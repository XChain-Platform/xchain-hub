/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - State Checkpoint Engine
 *
 * Periodically produces quorum-signed checkpoints of each chain's indexer
 * state (the per-block ledger/actions/contract hash triple the indexer
 * already computes into its `blocks` table) so light clients can verify any
 * indexer/explorer response against a quorum of `oracle_publish` signatures
 * (max(2f+1, ceil((N+1)/2)); for small N this can require unanimity)
 * instead of trusting a single operator. Checkpoints are OFF-CHAIN: written
 * to `state_checkpoints` and streamed over the hub-DB mirror (zero chain
 * writes); the StateAnchorPublisher separately commits the latest checkpoint
 * on-chain via the DOGE-only ANCHOR action.
 *
 * Round shape (leaner than CrossChainDexConsensus; a missed checkpoint is
 * benign, the next cadence retries under a rotated leader, so no view-change
 * machinery):
 *   1. The cadence leader (rank btcBlock % N over the sorted oracle_publish
 *      set, same election as OraclePublisher) reads each chain's hash triple
 *      from ITS OWN indexer, signs the XCHECKPOINT canonical, and broadcasts
 *      XCHK_SIGN_REQ.
 *   2. Every peer independently re-fetches the SAME block's triple from its
 *      own indexer/replica, signs only on byte-identical canonical, and
 *      replies XCHK_SIGN. A Byzantine leader cannot collect a quorum for
 *      state honest validators don't hold.
 *   3. At 2f+1 the leader broadcasts XCHK_FINALIZED with the full signature
 *      set; EVERY hub verifies the set and writes its own state_checkpoints
 *      row (mirroring _writeFinalizedMatch's everyone-writes pattern), then
 *      streams it to its indexer subscribers and emits checkpoint:finalized.
 *
 * Canonical signing string (must stay byte-identical to the indexer's ANCHOR
 * verifier and the SDK CheckpointVerifier; see spec protocol/actions/ANCHOR.md):
 *   XCHECKPOINT|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK
 *
 * Single-node fallback: oracle_publish set <= 1 (e.g. single-operator regtest)
 * collapses to immediate self-sign + write, like the other consensus engines.
 *
 ********************************************************************/

const EventEmitter      = require('events');
const axios             = require('axios');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const swq               = require('./stake_weighted_quorum.js');
const eq                = require('./equivocation_header.js');
const ckpt              = require('./checkpoint_commitment_activation.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const coins             = require('./coins');

const XCHK_SIGN_REQ  = 'XCHK_SIGN_REQ';
const XCHK_SIGN      = 'XCHK_SIGN';
const XCHK_FINALIZED = 'XCHK_FINALIZED';

const ALLOWED_CHAINS = [...coins.ALLOWED_COINS];

// Default follower co-sign freshness tolerance (BTC blocks) for the leader-
// supplied snapshot_block. ~144 = roughly one day of BTC blocks, matching
// CrossChainCallEngine's snapshot_block bound. See the constructor comment on
// this.cosignToleranceBlocks for why this is deliberately NOT electionToleranceBlocks.
const CHECKPOINT_COSIGN_TOLERANCE_BLOCKS = 144;

class StateCheckpointEngine extends EventEmitter {

    constructor(hub){
        super();
        this.hub         = hub;
        this.db          = hub.db;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.broadcaster = hub.hubDbBroadcaster || null;
        this.capSnapshot = hub.capabilitySnapshot || null;
        // Deployment network for the STAKE_WEIGHTED_QUORUM gate (cp.network == this
        // for every checkpoint this hub signs). Available before the per-chain network
        // is known, so the cadence-leader set + snapshot persist use the right rule.
        this.network     = (hub && hub.network) ? hub.network : '';

        let cfg = hub.p2pConfig || {};
        this.enabled        = String(process.env.CHECKPOINT_ENABLED || cfg.CHECKPOINT_ENABLED || 'true') !== 'false';
        this.intervalBlocks = parseInt(process.env.CHECKPOINT_INTERVAL_BLOCKS || cfg.CHECKPOINT_INTERVAL_BLOCKS || '6');
        this.confirmations  = parseInt(process.env.CHECKPOINT_CONFIRMATIONS  || cfg.CHECKPOINT_CONFIRMATIONS  || '6');
        this.pollMs         = parseInt(process.env.CHECKPOINT_POLL_MS        || cfg.CHECKPOINT_POLL_MS        || '60000');
        this.roundTimeoutMs = parseInt(process.env.CHECKPOINT_ROUND_TIMEOUT_MS || cfg.CHECKPOINT_ROUND_TIMEOUT_MS || '60000');

        // Follower co-sign freshness bound on the leader-supplied snapshot_block.
        // DEDICATED and separate from StateAnchorPublisher.electionToleranceBlocks
        // (default 36) on purpose: that constant bounds an ELECTION block that
        // advances every BTC block, so a tight window is correct there. The
        // checkpoint snapshot_block instead selects the validator set AND every
        // flag-day gate (stake-weighted quorum, equivocation-header, checkpoint-
        // commitment); it moves on the slower checkpoint cadence, so it needs its
        // own, wider tolerance. Mirrors CrossChainCallEngine's snapshot_block bound
        // (a day of BTC blocks, ~144), the closest analog. Fail-closed: a SIGN_REQ
        // whose snapshot_block deviates from our own BTC tip beyond this is declined.
        this.cosignToleranceBlocks = parseInt(process.env.CHECKPOINT_COSIGN_TOLERANCE_BLOCKS
            || cfg.CHECKPOINT_COSIGN_TOLERANCE_BLOCKS || String(CHECKPOINT_COSIGN_TOLERANCE_BLOCKS));
        this.chains = String(process.env.CHECKPOINT_CHAINS || cfg.CHECKPOINT_CHAINS || ALLOWED_CHAINS.join(','))
            .split(',').map(c => c.trim().toUpperCase()).filter(c => ALLOWED_CHAINS.includes(c));

        // Regtest seams: shared with the cross-chain DEX engine so a no-BTC
        // regtest configures its deterministic anchor + seeded validator once.
        // Network-gated (item decff441): the snapshot-block override feeds the SIGNED
        // checkpoint canonical and the seeded validator joins the federation set, so a
        // stray env var or configs-table row must never reach them on mainnet/testnet.
        // Honored ONLY on regtest; NaN/false everywhere else (fail closed to the real set).
        let _isRegtest = (this.network === 'regtest');
        this._snapshotBlockOverride = _isRegtest ? parseInt(process.env.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK) : NaN;
        this._seedLocalValidator    = _isRegtest && (process.env.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
                                       cfg.XDEX_SEED_LOCAL_VALIDATOR === '1' || cfg.XDEX_SEED_LOCAL_VALIDATOR === true);

        // Per-coin indexer JSON-RPC endpoints (same env surface as CrossChainDexEngine).
        this.indexers = {};
        for(let coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        // Leader-side rounds in flight: Map<id, pending>. id = chain|network|block_index|seq.
        this.pending = new Map();

        this._lastCheckpointBtcBlock = null;     // leader cadence latch
        this._pollTimer      = null;
        this._messageHandler = null;
        this._ticking        = false;

        // Process-lifetime counter for rounds that timed out below quorum.
        // Surfaced by getcheckpointstats so operators can detect stalled rounds
        // without running raw SQL.
        this._roundTimeouts = 0;
        // Follower-side FINALIZED drops. Quorum loss observed as leader is metered
        // via _roundTimeouts; these meter the same loss observed as a follower so a
        // validator-set/quorum drift or a Byzantine leader is visible at the moment
        // every incoming FINALIZED fails here, not only via the indirect tip-stall.
        this._malformedFinalized  = 0;
        this._subQuorumFinalized  = 0;

        // : cadence stalls. Every pre-leadership bail in _tick used to return
        // silently, so a hub whose oracle_publish capability had gone unqualified
        // produced zero checkpoints and zero log lines. The mainnet hub sat that way
        // for 18 days (last checkpoint 2026-07-10 at BTC 957439, tip 960028) because
        // its capability config still carried a placeholder DOGE address, and nothing
        // in the logs or in getcheckpointstats said so. Meter every "cadence is due
        // but we cannot lead" bail and name the reason.
        this._cadenceStalls        = 0;
        this._cadenceStallReason   = null;
        this._cadenceStallBlock    = null;
        this._cadenceStallLoggedAt = 0;
        // Log throttle: the poll runs far faster than the cadence, so log the reason
        // at most once an hour and let the counter carry the true rate.
        this._cadenceStallLogMs = parseInt(process.env.CHECKPOINT_STALL_LOG_MS
            || cfg.CHECKPOINT_STALL_LOG_MS || String(60 * 60 * 1000));
    }

    // Record (and throttle-log) a cadence round this hub could not lead. `block` is
    // the BTC snapshot block the round would have used, or null when we could not
    // even resolve one.
    _noteCadenceStall(block, reason){
        this._cadenceStalls++;
        this._cadenceStallReason = reason;
        this._cadenceStallBlock  = (block == null ? null : Number(block));
        let now = Date.now();
        if(now - this._cadenceStallLoggedAt < this._cadenceStallLogMs) return;
        this._cadenceStallLoggedAt = now;
        console.warn('StateCheckpointEngine: checkpoint cadence STALLED at BTC block ' +
                     (block == null ? 'unknown' : block) + ': ' + reason +
                     ' (no checkpoint will be produced until this is fixed; ' +
                     this._cadenceStalls + ' stalled tick(s) so far)');
    }

    // A round we led (or a cadence that simply is not due yet) clears the stall, so
    // getcheckpointstats reports a live reason rather than a stale one.
    _clearCadenceStall(){
        this._cadenceStallReason   = null;
        this._cadenceStallBlock    = null;
        this._cadenceStallLoggedAt = 0;
    }

    async start(){
        if(!this.enabled){ console.log('StateCheckpointEngine: disabled (CHECKPOINT_ENABLED=false)'); return; }
        // Fill any indexer URL left empty at construction (a configs-table-
        // provisioned hub carries no *_INDEXER_URL env var, and the p2pConfig
        // fallback never holds one) via the hub's configs-aware resolver, so this
        // engine reaches the indexer instead of silently producing zero checkpoints.
        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        for(const coin of (this.chains || [])){
            if(!this.indexers[coin] || !this.indexers[coin].url)
                console.warn('StateCheckpointEngine: no indexer URL for chain ' + coin + ' (set ' + coin + '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); this chain is skipped every tick until configured');
        }
        // Restore the cadence latch from the last checkpoint we already produced.
        // Without this the latch starts null, so the FIRST tick after a restart
        // checkpoints immediately regardless of intervalBlocks, and every such
        // off-schedule checkpoint anchors 3 chains on-chain (real DOGE). A
        // restart must not reset the cadence; only btcBlock advancing past
        // intervalBlocks should.
        await this._loadLastCheckpointLatch();
        if(this.peerManager){
            this._messageHandler = (env) => this._handleMessage(env);
            this.peerManager.on('message', this._messageHandler);
        }
        this._pollTimer = setInterval(() => {
            this._tick().catch(err => console.error('StateCheckpointEngine: tick error:', err && err.message));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();
        console.log('StateCheckpointEngine started (every ' + this.intervalBlocks + ' BTC blocks, chains ' + this.chains.join('/') + ')');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for(let [, p] of this.pending){ if(p.timer) clearTimeout(p.timer); }
        this.pending.clear();
    }

    // Return operator-visible checkpoint health: last finalized height per chain
    // and a process-lifetime count of rounds that timed out below quorum.
    // Mirrors getcrosschaincallstats / getattestationstats.
    async getStats(){
        let rows = [];
        try {
            rows = await this.db.doQuery(
                'SELECT chain, MAX(block_index) AS last_finalized_block, MAX(checkpoint_seq) AS last_seq ' +
                'FROM state_checkpoints WHERE network = ? GROUP BY chain',
                [this.network]);
        } catch(e){
            console.warn('StateCheckpointEngine: getStats query failed: ' + (e && e.message));
        }
        let last_finalized_by_chain = {};
        for(let r of rows){
            last_finalized_by_chain[r.chain] = {
                block_index:    Number(r.last_finalized_block),
                checkpoint_seq: Number(r.last_seq)
            };
        }
        return {
            last_finalized_by_chain: last_finalized_by_chain,
            round_timeouts:          this._roundTimeouts,
            malformed_finalized:     this._malformedFinalized,
            sub_quorum_finalized:    this._subQuorumFinalized,
            // : non-zero with a reason means the engine is alive but structurally
            // unable to checkpoint (unqualified capability, missing identity, not in the
            // validator set), the failure mode that produced 18 silent days on mainnet.
            cadence_stalls:          this._cadenceStalls,
            cadence_stall_reason:    this._cadenceStallReason,
            cadence_stall_block:     this._cadenceStallBlock
        };
    }

    // Seed the cadence latch from persisted checkpoints so a hub restart does
    // not fire an off-schedule (extra DOGE-anchored) checkpoint. The latch is a
    // single global "last snapshot block we checkpointed at" (one round spans
    // all chains), so MAX(snapshot_block) for THIS network is the right seed.
    // Scoped to this.network so a hub carrying rows from a prior network does
    // not seed the latch from the wrong (typically larger) block height, which
    // would silently suppress checkpointing on the active network indefinitely.
    // Best-effort: a read failure leaves the latch null (pre-fix behaviour) and
    // must not block engine startup.
    async _loadLastCheckpointLatch(){
        try {
            let rows = await this.db.doQuery(
                'SELECT MAX(snapshot_block) AS last_block FROM state_checkpoints WHERE network = ?',
                [this.network]);
            let last = rows && rows[0] ? rows[0].last_block : null;
            if(last != null){
                this._lastCheckpointBtcBlock = Number(last);
                console.log('StateCheckpointEngine: cadence latch restored at snapshot block ' + this._lastCheckpointBtcBlock);
            }
        } catch(e){
            console.warn('StateCheckpointEngine: could not restore cadence latch (' + (e && e.message) + '), first tick may checkpoint early');
        }
    }

    // Cadence: leader-only initiation; followers only react to SIGN_REQs.
    async _tick(){
        if(this._ticking) return;
        this._ticking = true;
        try {
            let btcBlock = await this._resolveSnapshotBlock();
            if(btcBlock == null){ this._noteCadenceStall(null, 'no BTC snapshot block (indexer unreachable or no tip)'); return; }
            if(this._lastCheckpointBtcBlock != null && btcBlock < this._lastCheckpointBtcBlock + this.intervalBlocks){
                // On schedule: the cadence simply has not come round yet.
                this._clearCadenceStall();
                return;
            }

            let validators = await this._resolveCapabilityValidators('oracle_publish', btcBlock);
            // : dedupe to DISTINCT pubkeys before ranking (mirrors the finalizer's
            // Set at _handleFinalized). At/above STAKE_WEIGHTED_QUORUM the weighted
            // snapshot is one row per (source, pubkey), so a key delegated by two sources
            // appears twice; ranking over the raw list inflates pubkeys.length and lets
            // `btcBlock % pubkeys.length` land on a duplicate's slot where no hub is
            // leader, silently dropping that cadence round. MUST stay in lockstep with the
            // follower site below (deduping only one turns a dropped round into split-brain).
            // Inert below SWQ, where there are no duplicate pubkeys.
            let pubkeys    = [...new Set(validators.map(v => String(v.pubkey).toLowerCase()))].sort();
            // No oracle_publish set at all -> nothing to sign authoritatively. A
            // checkpoint signed by a non-validator identity could never verify
            // against any capability snapshot. (Single-operator regtest seeds a
            // local validator via XDEX_SEED_LOCAL_VALIDATOR, so it still runs.)
            if(pubkeys.length === 0){
                this._noteCadenceStall(btcBlock, 'no qualified oracle_publish validator set (capability self-test failing, ' +
                                                 'not enabled, or no snapshot rows)');
                return;
            }
            // Membership + cadence run for EVERY set size: a size-1 set used to
            // skip even the indexOf check, letting a hub whose identity is NOT
            // the sole oracle_publish validator sign an unverifiable checkpoint.
            // (Size-1 cadence is btcBlock % 1 === 0 === rank, so the sole
            // validator still checkpoints every cadence block.)
            if(!this.identity){ this._noteCadenceStall(btcBlock, 'no validator identity (cannot sign checkpoints)'); return; }
            let me = this.identity.getPubkeyHex().toLowerCase();
            let myRank = pubkeys.indexOf(me);
            if(myRank < 0){                                     // not an oracle_publish validator
                this._noteCadenceStall(btcBlock, 'this hub is not in the oracle_publish validator set (' +
                                                 pubkeys.length + ' member(s))');
                return;
            }
            // Not our slot: normal rotation in an N>1 federation, NOT a stall. A single-
            // member set is always its own leader (btcBlock % 1 === 0 === rank), so this
            // branch can never hide the lone-validator case the stall counter is for.
            if(myRank !== (btcBlock % pubkeys.length)) return;

            // We are the cadence leader (or a single-node set): one round per chain.
            // The latch advances even on per-chain failure; the next cadence retries.
            this._clearCadenceStall();
            this._lastCheckpointBtcBlock = btcBlock;
            await this._persistCapabilitySnapshot('oracle_publish', btcBlock);
            for(let chain of this.chains){
                if(!this.indexers[chain].url) continue;
                try { await this._runRound(chain, btcBlock, validators); }
                catch(e){ console.warn('StateCheckpointEngine: ' + chain + ' round failed: ' + (e && e.message)); }
            }
        } finally {
            this._ticking = false;
        }
    }

    async _runRound(chain, snapshotBlock, validators){
        // Checkpoint the chain's tip minus a confirmation margin, so every peer's
        // indexer/replica has indexed the block and a shallow reorg can't race the round.
        let tip = await this._indexerCall(chain, 'getblockhashes', {});
        if(!tip || tip.block_index == null) throw new Error('no tip block hashes from ' + chain + ' indexer');
        let target = Number(tip.block_index) - this.confirmations;
        if(target < 0) target = Number(tip.block_index);
        let bh = (target === Number(tip.block_index)) ? tip : await this._indexerCall(chain, 'getblockhashes', { block_index: target });
        if(!bh || bh.block_index == null || !bh.block_hash) throw new Error('no block hashes for ' + chain + ' @ ' + target);

        let network = String(bh.network || '');
        if(!network) throw new Error(chain + ' indexer returned no network (refusing a network-agnostic checkpoint)');
        // : seq is a deterministic function of the round's BTC snapshot_block, NOT
        // COALESCE(MAX(seq))+1. The old read-then-allocate let two one-block-tip-skewed
        // leaders read the same MAX and mint the SAME seq for DIFFERENT blocks; every
        // honest leader now derives its seq from the (per-hub-unique-at-a-given-tip)
        // snapshot_block, so a shared seq implies a shared snapshot_block implies one
        // payload. Followers re-derive and refuse a mismatch (_handleSignReq).
        let seq = StateCheckpointEngine.deriveCheckpointSeq(snapshotBlock);

        let cp = {
            chain:          chain,
            network:        network,
            block_index:    Number(bh.block_index),
            block_hash:     String(bh.block_hash).toLowerCase(),
            ledger_hash:    String(bh.ledger_hash    || '').toLowerCase(),
            actions_hash:   String(bh.actions_hash   || '').toLowerCase(),
            contract_hash:  String(bh.contract_hash  || '').toLowerCase(),
            checkpoint_seq: seq,
            snapshot_block: Number(snapshotBlock),
            // SPV Phase 2: the additive light-client roots the post-flag-day canonical signs.
            state_root:           bh.state_root           != null ? String(bh.state_root).toLowerCase()        : null,
            state_root_version:   bh.state_root_version   != null ? Number(bh.state_root_version)   : null,
            block_merkle_root:    bh.block_merkle_root    != null ? String(bh.block_merkle_root).toLowerCase() : null,
            block_merkle_version: bh.block_merkle_version != null ? Number(bh.block_merkle_version) : null
        };
        // Post-flag-day the signed shape REQUIRES the roots; refuse to sign a malformed
        // (empty-root) canonical if the indexer hasn't produced them yet (operator must
        // pick a snapshot_block at/after every chain's STATE_COMMITMENT flag-day).
        if(StateCheckpointEngine.isRootless(cp))
            throw new Error('checkpoint-commitment active for ' + chain + '@' + cp.block_index +
                            ' but indexer returned no light-client roots (state-commitment flag-day not yet reached on ' + chain + ')');
        let canonical = StateCheckpointEngine.canonicalCheckpoint(cp);
        let id        = this._roundId(cp);
        if(this.pending.has(id)) return;
        if(!this.identity) throw new Error('no validator identity (cannot sign checkpoints)');

        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let mySig    = this.identity.sign(canonical);
        // #3095: the SWQ gate below resolves on this.network; refuse before signing if
        // the checkpoint we just built disagrees (a mis-set indexer network).
        this._assertCheckpointNetwork(cp, 'propose');
        let snapCount = validators.length;   // raw row count (matches _handleFinalized + anchor.js:336)
        // STAKE_WEIGHTED_QUORUM: weighted (source-deduped) at/above activation, else count.
        let weighted  = swq.isStakeWeightedQuorumActive(cp.snapshot_block, this.network);
        let quorum    = bftQuorumOrSingle(snapCount, 1);   // : majority-floored BFT quorum

        // Single-node self-sign fast path. Below SWQ this is snapCount<=1 (one row).
        // At/above SWQ the snapshot is one row per (source, pubkey), so a lone validator
        // whose one key is delegated by multiple sources has snapCount>1 even though THIS
        // hub is the entire federation; meetsStakeThreshold structurally cannot credit one
        // key for multiple sources (pubkey->source is 1:1), so that round could never
        // gather a second signer and would stall ( / item 2651). Detect the genuine
        // sole-self case - every snapshot row is our own pubkey - and self-finalize,
        // mirroring the CrossChainDexConsensus soleSelf guard. The _tick cadence check
        // already proved we are a member, so a distinct-pubkey count of 1 means that one
        // pubkey is ours. Inert below SWQ, where distinct pubkeys == snapCount (no dupes),
        // so the weighted term never fires and the condition is byte-for-byte snapCount<=1.
        let oneDistinctPubkey = (new Set(validators.map(v => String(v.pubkey).toLowerCase()))).size === 1;
        let soleSelf = oneDistinctPubkey && String(validators[0].pubkey).toLowerCase() === myPubkey;
        if(snapCount <= 1 || (weighted && soleSelf)){
            await this._acceptFinalized(cp, [{ pubkey: myPubkey, sig: mySig }], quorum, true);
            return;
        }

        // Re-map to the signer-verification shape, preserving the truncation flag so
        // _checkQuorum's meetsStakeThreshold still fails closed on an over-cap snapshot
        // (the .map would otherwise drop it, same defect class as the resolver above).
        let pendingValidators = validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0')) }));
        if(validators.truncated === true) pendingValidators.truncated = true;
        let pending = {
            id, cp, canonical, quorum, weighted,
            validators: pendingValidators,
            signatures: new Map([[myPubkey, mySig]]),
            done:       false,
            timer:      null
        };
        this.pending.set(id, pending);
        pending.timer = setTimeout(() => {
            this.pending.delete(id);
            if(!pending.done){
                this._roundTimeouts++;
                console.warn('StateCheckpointEngine: round ' + id + ' timed out at ' +
                    pending.signatures.size + '/' + quorum + ' sigs, retrying next cadence');
            }
        }, this.roundTimeoutMs);
        if(pending.timer.unref) pending.timer.unref();

        this.peerManager.broadcast(XCHK_SIGN_REQ, { checkpoint: cp, sig_pubkey: myPubkey, sig: mySig });
        this._checkQuorum(id);
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XCHK_SIGN_REQ:  this._handleSignReq(envelope).catch(e => console.error('StateCheckpointEngine: SIGN_REQ error: ' + (e && e.message))); break;
            case XCHK_SIGN:      this._handleSign(envelope);      break;
            case XCHK_FINALIZED: this._handleFinalized(envelope).catch(e => console.error('StateCheckpointEngine: FINALIZED error: ' + (e && e.message))); break;
        }
    }

    // Follower: independently confirm the proposed checkpoint against OUR OWN
    // indexer before signing (never sign state we don't hold ourselves).
    async _handleSignReq(envelope){
        let d  = envelope.data;
        let cp = this._normalizeCheckpoint(d.checkpoint);
        if(!cp || !this.identity) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;                            // our own broadcast

        // Freshness guard (fail-closed): the leader-supplied snapshot_block selects
        // the validator set AND every flag-day gate below, but is a wire field the
        // proposer chose. Bound it against our OWN resolved BTC tip before it can
        // reach leader-selection (grinding), the validator-set resolve, or the flag-
        // day gates (regression). If we cannot resolve our own tip, we decline rather
        // than co-sign blind. Mirrors StateAnchorPublisher.js:1467 / CrossChainCallEngine.js:536.
        let myBtc = await this._resolveSnapshotBlock();
        if(!Number.isFinite(myBtc)) return;                        // no own tip -> fail closed
        if(Math.abs(myBtc - Number(cp.snapshot_block)) > this.cosignToleranceBlocks) return;

        //  deterministic-seq guard: checkpoint_seq is a pure function of
        // snapshot_block, so re-derive it and refuse a leader whose seq does not match.
        // This closes seq-grinding (a leader picking an arbitrary seq to dodge the
        // replay guard below or fork the anchor/reward bookkeeping) and makes the
        // tightened (chain, network, checkpoint_seq) unique key a true split-brain fence.
        if(Number(cp.checkpoint_seq) !== StateCheckpointEngine.deriveCheckpointSeq(cp.snapshot_block)) return;

        let validators = await this._resolveCapabilityValidators('oracle_publish', cp.snapshot_block);
        // : dedupe to DISTINCT pubkeys before ranking, in lockstep with the leader
        // site in _tick (see the rationale there). Both MUST rank the same list or leader
        // and follower disagree on the cadence slot (split-brain). Inert below SWQ.
        let pubkeys    = [...new Set(validators.map(v => String(v.pubkey).toLowerCase()))].sort();
        if(!pubkeys.includes(myPubkey)) return;                    // we don't qualify
        if(sender !== pubkeys[cp.snapshot_block % pubkeys.length]) return;   // not the cadence leader

        let canonical = StateCheckpointEngine.canonicalCheckpoint(cp);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;

        // Replay guard: never co-sign a seq at-or-below one we've already recorded.
        let maxSeq = await this._getMaxCheckpointSeq(cp.chain, cp.network);
        if(maxSeq != null && cp.checkpoint_seq <= maxSeq) return;

        // Independent confirmation from our own indexer/replica.
        let bh = null;
        try { bh = await this._indexerCall(cp.chain, 'getblockhashes', { block_index: cp.block_index }); }
        catch(e){ return; }                                        // can't confirm -> don't sign
        if(!bh) return;
        let mine = StateCheckpointEngine.canonicalCheckpoint({
            chain: cp.chain, network: String(bh.network || ''), block_index: Number(bh.block_index),
            block_hash:    String(bh.block_hash    || '').toLowerCase(),
            ledger_hash:   String(bh.ledger_hash   || '').toLowerCase(),
            actions_hash:  String(bh.actions_hash  || '').toLowerCase(),
            contract_hash: String(bh.contract_hash || '').toLowerCase(),
            checkpoint_seq: cp.checkpoint_seq, snapshot_block: cp.snapshot_block,
            // SPV Phase 2: re-derive the roots from OUR OWN indexer so we co-sign only
            // when our state_root + block_merkle_root match the proposer's (same self-
            // verification guarantee the three flat hashes already get).
            state_root:           bh.state_root           != null ? String(bh.state_root).toLowerCase()        : null,
            state_root_version:   bh.state_root_version   != null ? Number(bh.state_root_version)   : null,
            block_merkle_root:    bh.block_merkle_root    != null ? String(bh.block_merkle_root).toLowerCase() : null,
            block_merkle_version: bh.block_merkle_version != null ? Number(bh.block_merkle_version) : null
        });
        if(mine !== canonical){
            console.warn('StateCheckpointEngine: ' + cp.chain + '@' + cp.block_index + ' diverges from our indexer, NOT signing');
            return;
        }

        // : matching the proposer is NOT sufficient post-flag-day. Two rootless
        // hubs agree byte-for-byte (the canonical's root suffix is empty when the roots
        // are null), so the check above passes and we would co-sign a checkpoint that
        // carries none of the light-client commitment its own flag-day requires. The
        // propose path already refuses this; refuse it here too.
        if(StateCheckpointEngine.isRootless(cp)){
            console.warn('StateCheckpointEngine: ' + cp.chain + '@' + cp.block_index +
                ' is checkpoint-commitment active but carries no light-client roots, NOT signing');
            return;
        }

        this.peerManager.broadcast(XCHK_SIGN, {
            id: this._roundId(cp), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    // Leader: collect follower signatures.
    _handleSign(envelope){
        let d  = envelope.data;
        let id = String(d.id || '');
        let pending = this.pending.get(id);
        if(!pending || pending.done) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(pending.canonical, String(d.sig || ''), pubkey)) return;
        pending.signatures.set(pubkey, String(d.sig));
        this._checkQuorum(id);
    }

    _checkQuorum(id){
        let pending = this.pending.get(id);
        if(!pending || pending.done) return;
        let met = pending.weighted
            ? swq.meetsStakeThreshold(pending.validators, pending.signatures.keys())
            : (pending.signatures.size >= pending.quorum);
        if(!met) return;
        pending.done = true;
        if(pending.timer){ clearTimeout(pending.timer); pending.timer = null; }
        this.pending.delete(id);
        let sigs = [];
        for(let [pk, sg] of pending.signatures) sigs.push({ pubkey: pk, sig: sg });
        this.peerManager.broadcast(XCHK_FINALIZED, { checkpoint: pending.cp, signatures: sigs });
        this._acceptFinalized(pending.cp, sigs, pending.quorum, true)
            .catch(e => console.error('StateCheckpointEngine: accept error: ' + (e && e.message)));
    }

    // Every hub verifies + writes the finalized checkpoint locally (the mirror
    // streams from each hub to ITS OWN indexer subscribers, so everyone writes).
    async _handleFinalized(envelope){
        let d  = envelope.data;
        let cp = this._normalizeCheckpoint(d.checkpoint);
        if(!cp || !Array.isArray(d.signatures)){
            this._malformedFinalized++;
            console.warn('StateCheckpointEngine: dropped malformed FINALIZED broadcast (missing checkpoint or signatures array)');
            return;
        }

        // : a finalized checkpoint whose seq is not the value derived from its
        // snapshot_block is malformed (the signers would not have co-signed it); refuse
        // to persist it even with an otherwise-valid signature set.
        if(Number(cp.checkpoint_seq) !== StateCheckpointEngine.deriveCheckpointSeq(cp.snapshot_block)){
            this._malformedFinalized++;
            console.warn('StateCheckpointEngine: dropped FINALIZED with seq ' + cp.checkpoint_seq +
                ' != derived seq for snapshot_block ' + cp.snapshot_block + ' ');
            return;
        }

        let validators = await this._resolveCapabilityValidators('oracle_publish', cp.snapshot_block);
        let pubkeys    = new Set(validators.map(v => String(v.pubkey).toLowerCase()));   // signer-membership set
        //  (item 2651): size the quorum from the RAW row count, matching the propose
        // path (_runRound) and the on-chain authority (anchor.js:336). The deduped
        // pubkeys.size used before diverged whenever a key was multi-source. `quorum` only
        // gates the count path (weighted uses meetsStakeThreshold), and below SWQ
        // validators.length == pubkeys.size, so this is inert below SWQ.
        let snapCount  = validators.length;
        let weighted   = swq.isStakeWeightedQuorumActive(cp.snapshot_block, this.network);
        let quorum     = bftQuorumOrSingle(snapCount, 1);   // : majority-floored BFT quorum

        let canonical = StateCheckpointEngine.canonicalCheckpoint(cp);
        let seen = new Set(), sigs = [];
        for(let s of d.signatures){
            let pk = String(s && s.pubkey || '').toLowerCase();
            if(!pk || seen.has(pk) || !pubkeys.has(pk)) continue;
            if(!ValidatorIdentity.verify(canonical, String(s.sig || ''), pk)) continue;
            seen.add(pk);
            sigs.push({ pubkey: pk, sig: String(s.sig) });
        }
        let met = weighted
            ? swq.meetsStakeThreshold(validators, sigs.map(s => s.pubkey))
            : (sigs.length >= quorum);
        if(!met){                                                  // sub-quorum, ignore
            this._subQuorumFinalized++;
            console.warn('StateCheckpointEngine: dropped sub-quorum FINALIZED for snapshot_block ' + cp.snapshot_block +
                ' (' + sigs.length + '/' + quorum + ' valid sigs' + (weighted ? ', stake-weighted' : '') +
                '); persisted nothing on this hub');
            return;
        }
        await this._acceptFinalized(cp, sigs, quorum, false);
    }

    // Write the checkpoint row (append-only INSERT IGNORE: a reorged height is
    // superseded by a NEW row with a higher checkpoint_seq, never an UPDATE, so
    // the INSERT-IGNORE indexer mirror always converges), stream it to our
    // indexer subscribers, and emit for the StateAnchorPublisher.
    async _acceptFinalized(cp, sigs, quorum, isLeader){
        // #3095: refuse BEFORE any work. This cp arrived from a PEER, so its network is
        // the sender's claim; if it disagrees with ours we would tally the signature set
        // under a different rule than the anchor publisher (and the sender) will. Checked
        // first so a cross-network checkpoint costs no validator resolution and cannot
        // slip past an earlier early-return.
        this._assertCheckpointNetwork(cp, 'accept-finalized');
        // EVERY hub persists the oracle_publish snapshot for the checkpoint's
        // snapshot_block, not just the cadence leader (_tick): ANCHOR verifiers
        // check the checkpoint's signatures against capability_snapshots in
        // whichever hub DB they mirror, and a follower's DB may be the only one
        // they read. Deterministic from BTC stakes + INSERT IGNORE, so all hubs
        // write identical rows. Persisted BEFORE the checkpoint row streams so a
        // mirror subscriber never sees a row it can't verify: a persist failure
        // must therefore fail closed (throw) rather than log-and-continue, so the
        // checkpoint INSERT/broadcast/emit below are all skipped and no
        // quorum-signed, unverifiable row reaches a mirror or the anchor poller.
        // Matches the leader _tick persist (unguarded) and _writeFinalizedMatch;
        // callers (_tick .catch, _handleFinalized .catch, the leader accept .catch)
        // log the accept error, and the FINALIZED broadcast is re-deliverable.
        // , final backstop. Co-sign now refuses a rootless checkpoint, but this
        // path also accepts checkpoints that arrive already-finalized from a peer, so it
        // must enforce the rule independently rather than trust that every signer did.
        //
        // Placed BEFORE the capability-snapshot persist below on purpose: that persist is
        // deliberately fail-closed so "no quorum-signed, unverifiable row reaches a mirror
        // or the anchor poller", and the same reasoning applies one step earlier. Throwing
        // here means neither the snapshot nor the checkpoint row is written and nothing is
        // broadcast or emitted; the caller's .catch logs the accept error and the FINALIZED
        // broadcast stays re-deliverable.
        if(StateCheckpointEngine.isRootless(cp))
            throw new Error('refusing to persist rootless checkpoint ' + cp.chain + '@' + cp.block_index +
                ': checkpoint-commitment is active for snapshot_block ' + cp.snapshot_block +
                ' but the light-client roots are absent ()');

        await this._persistCapabilitySnapshot('oracle_publish', Number(cp.snapshot_block));
        await this.db.doQuery(
            'INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [cp.chain, cp.network, cp.block_index, cp.block_hash, cp.ledger_hash, cp.actions_hash,
             cp.contract_hash, cp.checkpoint_seq, cp.snapshot_block,
             cp.state_root || null, cp.state_root_version != null ? cp.state_root_version : null,
             cp.block_merkle_root || null, cp.block_merkle_version != null ? cp.block_merkle_version : null,
             JSON.stringify(sigs)]);

        if(this.broadcaster){
            let r = await this.db.doQuery(
                'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
                [cp.chain, cp.network, cp.block_index, cp.checkpoint_seq]);
            if(r.length) this.broadcaster.broadcastRow({ table: 'state_checkpoints', row: r[0] });
        }

        // Advance the cadence latch for PEER-led rounds too, symmetric with the
        // startup seed (_loadLastCheckpointLatch reads MAX(snapshot_block) over rows
        // written by ANY leader). Writing it only in the leader branch of _tick left
        // each hub gated on its own leadership history: with N validators and leader
        // = btcBlock % N, every hub's latch is stale on the N-1 blocks it does not
        // lead, so the federation finalizes a round roughly every intervalBlocks / N
        // blocks. That advances checkpoint_seq (and therefore ANCHOR_CHECKPOINT_EVERY_N,
        // which is defined against seq % N) N times faster than CHECKPOINT_INTERVAL_BLOCKS
        // configures, and burns DOGE on the extra anchors. Monotonic so an out-of-order
        // or replayed FINALIZED cannot walk the latch backwards into an early round.
        let latch = Number(cp.snapshot_block);
        if(Number.isFinite(latch) && (this._lastCheckpointBtcBlock == null || latch > this._lastCheckpointBtcBlock))
            this._lastCheckpointBtcBlock = latch;

        console.log('StateCheckpointEngine: checkpoint ' + cp.chain + '/' + cp.network + ' @ ' + cp.block_index +
                    ' seq ' + cp.checkpoint_seq + ' (' + sigs.length + '/' + quorum + ' sigs' + (isLeader ? ', leader' : '') + ')');
        this.emit('checkpoint:finalized', { checkpoint: cp, signatures: sigs });
    }

    // RAW (ungated) v0 checkpoint canonical: the bare pipe-join. The v1 archive
    // (StateAnchorPublisher._archiveCanonical) nests THIS, not the gated form, so the
    // EQUIV header is applied exactly once around the whole archive content.
    static _rawCanonicalCheckpoint(cp){
        // The bare v0 checkpoint canonical, WITHOUT the SPV roots: the v1 archive
        // (_archiveCanonical) nests THIS and must stay byte-identical to its pre-SPV
        // shape, so the root-append lives in canonicalCheckpoint (checkpoint family
        // only), never here.
        return ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
    }

    // The SPV Phase 2 (spec §6.1) root suffix appended to the checkpoint-family
    // canonical at/above the CHECKPOINT_COMMITMENT flag-day. Kept as one helper so
    // the hub / SDK / indexer-anchor / explorer all build byte-identical bytes.
    static _checkpointRootSuffix(cp){
        if(!ckpt.isCheckpointCommitmentActive(cp.snapshot_block, cp.network)) return '';
        // Append only when the roots are actually present. Post-flag-day the engine
        // refuses to sign a checkpoint that lacks them (_runRound throws), so for every
        // REAL post-flag-day checkpoint this is always true and the suffix is byte-
        // deterministic; the guard only keeps legacy/pre-Phase-1 rows (null roots) on
        // their original rootless canonical, so old signatures still verify.
        if(cp.state_root == null || cp.block_merkle_root == null ||
           cp.state_root_version == null || cp.block_merkle_version == null) return '';
        return '|' + [String(cp.state_root).toLowerCase(), String(cp.state_root_version),
                      String(cp.block_merkle_root).toLowerCase(), String(cp.block_merkle_version)].join('|');
    }

    // Byte-identical to the indexer ANCHOR verifier + SDK CheckpointVerifier. At/above
    // the EQUIV flag-day (gated on the BTC snapshot_block + network) the v0 canonical is
    // wrapped in the uniform signed header (TAG=XCHECKPOINT, ROUND_ID=v0 round id,
    // VIEW=0: checkpoints have no view change); below it, the bare raw bytes (regression-safe).
    static canonicalCheckpoint(cp){
        // Checkpoint family (v0/v3): the bare canonical PLUS the SPV root suffix
        // (post-flag-day), appended to the RAW string BEFORE the EQUIV wrap. The v1
        // archive uses _archiveCanonical (rootless) instead, so archives are untouched.
        let raw = StateCheckpointEngine._rawCanonicalCheckpoint(cp) + StateCheckpointEngine._checkpointRootSuffix(cp);
        if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
                cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq, 0, raw);
        return raw;
    }

    _roundId(cp){ return cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq; }

    _normalizeCheckpoint(raw){
        if(!raw || !raw.chain || !raw.network || raw.block_index == null) return null;
        let chain = String(raw.chain).toUpperCase();
        if(!ALLOWED_CHAINS.includes(chain)) return null;
        return {
            chain:          chain,
            network:        String(raw.network),
            block_index:    Number(raw.block_index),
            block_hash:     String(raw.block_hash    || '').toLowerCase(),
            ledger_hash:    String(raw.ledger_hash   || '').toLowerCase(),
            actions_hash:   String(raw.actions_hash  || '').toLowerCase(),
            contract_hash:  String(raw.contract_hash || '').toLowerCase(),
            checkpoint_seq: Number(raw.checkpoint_seq),
            snapshot_block: Number(raw.snapshot_block),
            // SPV Phase 2: carried so a peer-received checkpoint reconstructs the SAME
            // post-flag-day canonical the proposer signed. null below the flag-day.
            state_root:           raw.state_root           != null ? String(raw.state_root).toLowerCase()        : null,
            state_root_version:   raw.state_root_version   != null ? Number(raw.state_root_version)   : null,
            block_merkle_root:    raw.block_merkle_root    != null ? String(raw.block_merkle_root).toLowerCase() : null,
            block_merkle_version: raw.block_merkle_version != null ? Number(raw.block_merkle_version) : null
        };
    }

    // : the checkpoint_seq is derived purely from the round's BTC snapshot_block.
    // snapshot_block is the single consensus field every hub already agrees on, and
    // cadence leader election (rank == btcBlock % N over each hub's OWN BTC tip) makes
    // at most one honest leader per BTC block; so tying seq to snapshot_block guarantees
    // two honest leaders cannot mint divergent payloads under one seq (a shared seq
    // implies a shared snapshot_block implies a shared tip implies one payload). It is
    // monotonic across cadences (snapshot_block only advances by intervalBlocks), so the
    // readers' MAX(checkpoint_seq) supersession and the co-sign replay guard still hold,
    // and it strictly exceeds any legacy COALESCE(MAX)+1 dense seq (a count of prior
    // checkpoints <= snapshot_block/interval), so a mid-upgrade hub never stalls.
    // Every hub (leader, follower, finalizer) computes the identical value with no DB read.
    static deriveCheckpointSeq(snapshotBlock){
        return Number(snapshotBlock);
    }

    // : true when checkpoint-commitment is active for this checkpoint's
    // snapshot_block/network but the light-client roots are missing.
    //
    // The propose path always refused to SIGN such a checkpoint, but that was the only
    // place the rule lived, and it is the one path an attacker does not control. The
    // canonical hides the gap: _rootSuffix() contributes the EMPTY STRING when the
    // roots are null, so a rootless proposal and a rootless self-derivation produce
    // BYTE-IDENTICAL canonicals. A follower's "does the proposer's canonical match
    // mine?" check therefore passes, and it co-signs a post-flag-day checkpoint
    // carrying no roots at all. Quorum then forms and every hub persists it, so the
    // light-client commitment the flag-day exists to guarantee is silently absent from
    // the checkpoint chain, and an SPV client has nothing to verify against.
    //
    // One predicate, three call sites (propose, co-sign, persist), so the rule cannot
    // be enforced on one path and quietly skipped on the others again.
    // : the SWQ gate here resolves on the DEPLOYMENT network
    // (`this.network`) while StateAnchorPublisher resolves the same gate on the
    // RECORD's network (resolveQuorumNetwork(cp, ...), "gate on the RECORD network to
    // match the indexer", ). Two files, one gate, two planes.
    //
    // The v1 call is kept deliberately rather than switched to cp.network. Switching
    // would make a misconfigured hub silently adopt whatever network a PEER asserts in
    // a gossiped checkpoint, which is a worse failure than the one being fixed: the
    // quorum rule would then be chosen by the sender. Instead the drift is made LOUD.
    //
    // A checkpoint whose network disagrees with this hub's deployment network is
    // refused outright. That surfaces the misconfiguration where it is diagnosable (a
    // named error naming both values) rather than at consensus time, where it appears
    // as an unexplained quorum failure or, worse, as two hubs tallying the same
    // signature set under different rules and disagreeing about whether quorum was
    // reached. Callers treat a throw as "do not sign / do not persist".
    // Scoped to a genuine disagreement between two KNOWN networks. An UNSCOPED hub
    // (this.network === '') is a different, already-documented problem: it silently
    // resolves every flag-day gate to "off" (isStakeWeightedQuorumActive returns false
    // on an unknown network) and it is what #2236 found double-crediting the COLLECT
    // rail. It is warned about loudly here but NOT refused, because refusing would take
    // every unscoped deployment offline at once, which is a far larger behavioural
    // change than this finding asks for and is not what it is about.
    _assertCheckpointNetwork(cp, context){
        let recordNet = (cp && cp.network != null) ? String(cp.network) : '';
        if(recordNet === '') return;
        if(this.network === ''){
            if(!this._warnedUnscopedNetwork){
                this._warnedUnscopedNetwork = true;
                console.warn('StateCheckpointEngine: this hub has NO deployment network, so every ' +
                    'flag-day gate (stake-weighted quorum, equivocation-header, checkpoint-commitment) ' +
                    'resolves to OFF while the checkpoints it handles are scoped to "' + recordNet +
                    '". Set HUB_NETWORK. Continuing on the legacy unscoped path ().');
            }
            return;
        }
        if(recordNet === this.network) return;
        throw new Error('checkpoint network mismatch in ' + context + ': record says "' + recordNet +
            '" but this hub is deployed on "' + this.network + '". Refusing rather than ' +
            'resolving the stake-weighted-quorum gate on one plane while the anchor ' +
            'publisher resolves it on the other ().');
    }

    static isRootless(cp){
        if(!cp) return false;
        if(!ckpt.isCheckpointCommitmentActive(cp.snapshot_block, cp.network)) return false;
        return (!cp.state_root || !cp.block_merkle_root ||
                cp.state_root_version == null || cp.block_merkle_version == null);
    }

    async _getMaxCheckpointSeq(chain, network){
        let r = await this.db.doQuery(
            'SELECT MAX(checkpoint_seq) AS max_seq FROM state_checkpoints WHERE chain = ? AND network = ?',
            [chain, network]);
        return (r.length > 0 && r[0].max_seq != null) ? Number(r[0].max_seq) : null;
    }

    // Mirror CrossChainDexEngine._resolveCapabilityValidators (incl. regtest seam).
    // Source-keyed at/above STAKE_WEIGHTED_QUORUM (this.network + block), else legacy
    // count set (source='' , weight=amount). Uses the deployment network so the set is
    // resolved correctly at _tick, before the per-chain network is known.
    async _resolveCapabilityValidators(capability, block){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, this.network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0'), amount: String(v.weight != null ? v.weight : '0') }));
                    // Carry the truncation flag through the .map so the quorum check fails
                    // closed on an over-cap weighted snapshot (SWQ-TRUNC parity with the sibling
                    // engines CrossChainDexEngine/CrossChainCallEngine and the indexer consumers;
                    // meetsStakeThreshold under-counts a truncated S, so a stake-evicted minority
                    // could otherwise clear the strict 2/3 bar and finalize a checkpoint a full
                    // snapshot would reject - the root of XHUB-TRUNC-1, which this engine missed).
                    if(snap.truncated === true) validators.truncated = true;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators))
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: '', weight: String(v.amount != null ? v.amount : '0'), amount: String(v.amount != null ? v.amount : '0') }));
            }
        }
        if(validators.length === 0 && this._seedLocalValidator && this.identity){
            let pk = this.identity.getPubkeyHex();
            validators = [{ pubkey: pk, source: 'seed:' + String(pk).toLowerCase(), weight: '1', amount: '1' }];
        }
        return validators;
    }

    // Mirror CrossChainDexEngine._persistCapabilitySnapshot: the ANCHOR verifier
    // on the DOGE indexer resolves oracle_publish from the mirrored snapshots.
    async _persistCapabilitySnapshot(capability, block){
        let validators = await this._resolveCapabilityValidators(capability, block);
        // SWQ-TRUNC-MIRROR (): never mirror a TRUNCATED set. The `.truncated`
        // marker _resolveCapabilityValidators carries is what makes this hub's own
        // meetsStakeThreshold fail closed on an over-cap snapshot, but it is a JS array
        // property and capability_snapshots has no column for it, so persisting the capped
        // rows hands the off-BTC (DOGE/LTC) indexer verifiers a partial set they read back
        // as COMPLETE (xchain-indexer getCapabilitySnapshotWeights sets no `truncated`).
        // They would then clear the strict 2/3 bar against an under-counted stake
        // denominator S and finalize what this hub rejects: an accept/reject divergence on
        // a consensus path, reachable organically once the federation outgrows the source
        // cap and deliberately via key-spam stake eviction. Writing nothing leaves the
        // mirror empty, so the off-BTC read yields S=0 and fails closed through the same
        // predicate as everything else. The window ends when operators raise the cap
        // (coordinated), which is the design's already-stated posture.
        if(validators && validators.truncated === true){
            console.warn('StateCheckpointEngine: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return;
        }
        for(let v of validators){
            let pubkey = String(v.pubkey).toLowerCase();
            let amount = String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0'));
            let source = String(v.source != null ? v.source : '');
            await this.db.doQuery(
                'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
                [block, capability, pubkey, amount, source]);
            if(this.broadcaster){
                // : select the row back by (block, capability, pubkey, SOURCE),
                // matching the widened uq_cap_snap. A pubkey-only select-back returned
                // just ONE of a multi-source key's rows (LIMIT 1), so the mirror stream
                // carried a single source and the downstream indexer never saw the
                // second. Inert below SWQ, where source='' and there is one row per key.
                let r = await this.db.doQuery(
                    'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
                    [block, capability, pubkey, source]);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
    }

    async _resolveSnapshotBlock(){
        let b = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
    }

    async _indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }
}

module.exports = StateCheckpointEngine;
module.exports.XCHK_SIGN_REQ  = XCHK_SIGN_REQ;
module.exports.XCHK_SIGN      = XCHK_SIGN;
module.exports.XCHK_FINALIZED = XCHK_FINALIZED;
