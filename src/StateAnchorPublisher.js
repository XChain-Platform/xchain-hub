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
 * XChain Hub - State Anchor Publisher (the ANCHOR action pipeline)
 *
 * Publishes the protocol's on-chain commitments on DOGE (and ONLY on DOGE,
 * so BTC/LTC carry zero anchor bytes; spec: protocol/actions/ANCHOR.md):
 *
 *   ANCHOR v0: the latest quorum-signed state checkpoint per chain (signatures
 *               come straight from state_checkpoints; no new signing round).
 *   ANCHOR v1: a checkpoint + a compressed archive of full cross_chain_matches
 *               rows (incl. their validator_signatures + the cross_chain
 *               capability_snapshots needed to re-verify them). This is what
 *               makes cross-chain match data recoverable from a full chain
 *               parse with no surviving hub DB.
 *   ANCHOR v2: continuation chunks when a v1 archive exceeds the per-action
 *               data budget.
 *
 * The v1 canonical covers the archive structure (batch_seq, count, crc32 of the
 * UNCOMPRESSED JSON, total_chunks), so stored checkpoint signatures cannot
 * authenticate an archive. The publisher therefore runs a fresh signing round
 * (XANC_SIGN_REQ / XANC_SIGN) in which every follower verifies the proposed
 * archive AGAINST ITS OWN cross_chain_matches + capability_snapshots before
 * co-signing (a Byzantine elected publisher cannot collect a quorum for
 * fabricated matches or fabricated snapshots). After on-chain publication the
 * leader broadcasts XANC_FINALIZED so every hub back-fills batch_seq /
 * archived_status (audit metadata; harmless if missed, re-archival is
 * deduplicated by recovery's latest-status-wins).
 *
 * Re-archival rule: a match is pending when batch_seq IS NULL (never archived)
 * OR archived_status <> status (retracted after being archived as finalized).
 *
 * Election (attestation-style hash-ordering, spec §8.2 idiom): each pending
 * checkpoint elects its OWN publisher (oracle_publish validators at the
 * checkpoint's snapshot_block ordered by SHA256(election key ‖ pubkey)
 * ascending, where the key binds chain/network/seq/snapshot_block). Rank 0
 * publishes; if it hasn't after ANCHOR_ELECTION_TOLERANCE_BLOCKS BTC blocks,
 * rank 1 also qualifies, and so on (the DB row's anchor_txid IS NULL is the
 * shared "still pending" signal, so a late rank-0 and an early rank-1 can both
 * publish). The on-chain state never diverges: both build byte-identical
 * commitments, and the anchor-reward rail does NOT inflate: recordAnchorReward
 * deterministically keeps a single reward per (checkpoint_seq, reward_type)
 * across distinct publisher pubkeys (see below), so the only residual cost of
 * the race is the duplicate DOGE tx fee. A different
 * validator therefore publishes each chain's anchor in a cycle, FROM ITS OWN
 * DOGE WALLET (no UTXO contention between the per-chain anchors, per-chain
 * fault isolation, and publish work plus its DOGE cost spreads across the
 * federation). Each successful publish records an `anchor_<chain>` /
 * `anchor_archive` reward on the validator_rewards rail (oracle-round
 * pattern; recordAnchorReward collapses failover-race duplicates to a single
 * deterministic per-(round,type) winner, best-effort push to the BTC indexer
 * for COLLECT). The v1 archive round elects a single leader the same way with a
 * per-election-block key. Signer resolution, balance checks and the DOGE
 * broadcast pipeline mirror OraclePublisher (the DB is
 * the durable queue: pending checkpoints are rows with anchor_txid IS NULL,
 * pending matches per the rule above; crash-safe with no separate WAL file).
 * The degenerate single-validator federation keeps today's behavior: one
 * publisher, serialized spends from one wallet. Supersedes the legacy
 * XDEXANCHOR raw payload (CrossChainDexAnchor, retired 2026-06-11 after
 * ANCHOR verified end-to-end on mainnet).
 *
 ********************************************************************/

const zlib              = require('zlib');
const crypto            = require('crypto');
const axios             = require('axios');
const coins             = require('./coins');
const EncoderClient     = require('./EncoderClient.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const StateCheckpointEngine = require('./StateCheckpointEngine.js');
const swq                   = require('./stake_weighted_quorum.js');
const eq                    = require('./equivocation_header.js');
const ckpt                  = require('./checkpoint_commitment_activation.js');
const ccr                   = require('./cross_chain_royalty_activation.js');
const ar                    = require('./anchor_reward_activation.js');

const XANC_SIGN_REQ  = 'XANC_SIGN_REQ';
const XANC_SIGN      = 'XANC_SIGN';
const XANC_FINALIZED = 'XANC_FINALIZED';
const XANC_V0_DONE   = 'XANC_V0_DONE';
// Publisher-attestation round (anchor-reward re-derivation flag-day): the elected
// checkpoint publisher collects a 2f+1 oracle_publish quorum ATTESTING that it is the
// legitimate reward earner, carried on-chain in ANCHOR v4/v5 so the indexer DERIVES the
// reward instead of trusting the forgeable push (#5311). Mirrors XANC_SIGN_REQ/SIGN.
const XANCPUB_SIGN_REQ = 'XANCPUB_SIGN_REQ';
const XANCPUB_SIGN     = 'XANCPUB_SIGN';

// Fixed serialization order for an archived match row (the crc32 and the
// follower byte-comparison depend on this exact order). Spec §Archive JSON.
// `id` (the hub-assigned mirror cursor) is archived because it is the
// indexers' settlement-order key (getEffectiveUnsettledMatches ORDER BY id):
// recovery must rebuild rows under their original ids or a reindexing node
// could settle two same-block matches in a different order than live history
// (action_index divergence). Archives published before this field exist
// without it; recovery tolerates both shapes.
const MATCH_KEYS = ['id', 'match_id', 'snapshot_block', 'network',
    'a_chain', 'a_action_index', 'a_kind', 'a_tick', 'a_amount', 'a_filled_before', 'a_ownership', 'a_payout_addr', 'a_payout_legs',
    'b_chain', 'b_action_index', 'b_kind', 'b_tick', 'b_amount', 'b_filled_before', 'b_ownership', 'b_payout_addr', 'b_payout_legs',
    'effective_time', 'finalizing_view', 'validator_signatures', 'status'];

// Fixed serialization order for an archived cross-chain CALL relay row (XCALL
// dispatch/result phases); same crc32/byte-comparison rules as MATCH_KEYS.
// Without these in the archive, a full-chain-parse recovery could not rebuild
// the injected executions/callbacks and would diverge from live nodes.
// `id` (the hub-assigned AUTO_INCREMENT primary key) IS archived for per-hub
// provenance only; injection order is determined by (snapshot_block, call_id),
// not by `id`. Recovery must preserve the original id so the indexer mirror
// cursor stays consistent, but consensus ordering never uses it.
const CALL_KEYS = ['id', 'call_id', 'phase', 'snapshot_block', 'network',
    'source_chain', 'source_action_index', 'source_contract_index',
    'target_chain', 'target_contract_index', 'method', 'params_json',
    'gas_limit', 'cross_hops', 'effective_time', 'finalizing_view', 'result_status',
    'return_payload_b64', 'validator_signatures', 'status'];

class StateAnchorPublisher {

    constructor(hub){
        this.hub         = hub;
        this.db          = hub.db;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.capSnapshot = hub.capabilitySnapshot || null;
        this.network     = (hub && hub.network) ? hub.network : '';   // STAKE_WEIGHTED_QUORUM gate

        let cfg = hub.p2pConfig || {};
        this.enabled       = String(process.env.ANCHOR_ENABLED || cfg.ANCHOR_ENABLED || 'true') !== 'false';
        this.intervalMs    = parseInt(process.env.ANCHOR_INTERVAL_MS      || cfg.ANCHOR_INTERVAL_MS      || '86400000'); // daily
        this.batchSize     = parseInt(process.env.ANCHOR_MATCH_BATCH_SIZE || cfg.ANCHOR_MATCH_BATCH_SIZE || '200');
        this.maxBatch      = parseInt(process.env.ANCHOR_MAX_BATCH        || cfg.ANCHOR_MAX_BATCH        || '1000');
        this.chunkMaxBytes = parseInt(process.env.ANCHOR_CHUNK_MAX_BYTES  || cfg.ANCHOR_CHUNK_MAX_BYTES  || '6000');
        this.roundTimeoutMs = parseInt(process.env.ANCHOR_ROUND_TIMEOUT_MS || cfg.ANCHOR_ROUND_TIMEOUT_MS || '120000');
        this.chunkRetryDelayMs = parseInt(process.env.ANCHOR_CHUNK_RETRY_MS || cfg.ANCHOR_CHUNK_RETRY_MS || '2500');
        this.electionToleranceBlocks = parseInt(process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS || cfg.ANCHOR_ELECTION_TOLERANCE_BLOCKS || '36');
        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');
        // Decouple on-chain anchoring from checkpoint production: checkpoints are
        // free (off-chain hub-DB mirror, good for light-client verify) but each
        // on-chain v0 anchor spends real DOGE on 3 chains. Only anchor every Nth
        // checkpoint_seq (recovery needs just the LATEST anchored checkpoint per
        // chain, so the skipped non-multiple seqs stay off-chain). N=1 keeps the
        // original anchor-every-checkpoint behaviour. checkpoint_seq is consensus
        // data (identical on every hub) so `seq % N` is deterministic fleet-wide.
        this.anchorEveryNCheckpoints = Math.max(1,
            parseInt(process.env.ANCHOR_CHECKPOINT_EVERY_N || cfg.ANCHOR_CHECKPOINT_EVERY_N || '1') || 1);

        this.dogeAddress   = process.env.DOGE_ADDRESS    || cfg.DOGE_ADDRESS    || '';
        this.dogePubkeyHex = process.env.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        let encoderUrl = process.env.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = process.env.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks; unset -> borrow the price publisher's DOGE signer.
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;

        this._archiveRound     = null;  // leader-side archive signing round (one at a time)
        this._attestRound      = null;  // leader-side publisher-attestation round (one at a time)
        this._pendingMatches   = 0;     // size trigger; DB is the source of truth
        this._callHandler      = null;
        this._flushing         = false;
        this._timer            = null;
        this._messageHandler   = null;
        this._matchHandler     = null;
        this._loggedNoPipeline = false;
        // Cumulative count of archive chunks that failed all broadcast retries.
        // A lost chunk is a durability failure (recovery needs every chunk), so
        // a pattern of losses is surfaced here for operator visibility rather
        // than requiring a log-grep.
        this._archiveChunkLosses = 0;
        // Cumulative count of v0/v3 anchors successfully published on-chain.
        this._anchorsPublished = 0;
        // Last DOGE balance observed by _checkBalance (refreshed each flush) and
        // when, surfaced via getAnchorStats so an operator/monitor can watch the
        // publisher wallet's runway (it spends real DOGE on every anchor cycle)
        // without log-grepping the low-balance warning. null until the first
        // balance read (no pipeline / before first flush).
        this._lastBalance   = null;
        this._lastBalanceAt = null;
        // Locally-observed archive-round leaders: batch_seq -> Set(elected leader
        // pubkeys). Populated in _handleSignReq the moment this hub validates a
        // SIGN_REQ sender as the (rank-unlocked) elected archive leader for that
        // batch_seq, and consulted in _handleFinalized to authenticate the
        // FINALIZED sender. The archive election is keyed on election_block (the
        // BTC tip at archive time), which the FINALIZED canonical does NOT carry,
        // so it cannot be re-derived at finalize time; this binds it from the
        // round we actually observed. Bounded (batch_seq is monotonic, evict the
        // smallest keys) so a long-lived hub never grows this without limit.
        this._observedArchiveLeaders = new Map();
        this._observedArchiveLeadersCap = 256;
        // Checkpoint IDENTITY observed per batch_seq (from the SIGN_REQ, recorded
        // alongside the leader). FINALIZED carries only batch_seq, not the
        // checkpoint identity getanchoraction needs, so _handleFinalized reads this
        // to verify the batch's archive checkpoint landed on DOGE before mirroring
        // the (LIVE, not flag-day-gated) anchor_archive reward. Identity only,
        // re-SELECTed against our own rows, and evicted in lockstep with the leader map.
        this._observedArchiveCheckpoints = new Map();

        // Per-coin indexer JSON-RPC clients (same env -> p2pConfig surface as
        // ReorgHandler / CrossChainCallEngine). Used ONLY for on-chain ANCHOR
        // verification, which always queries the DOGE indexer: every ANCHOR (for a
        // BTC/LTC/DOGE checkpoint) is a DOGE transaction, and only the DOGE
        // decoder+indexer decode the P2SH anchor payload (a raw getrawtransaction
        // cannot bind the tx to the checkpoint). Unset -> _verifyAnchorOnChain
        // returns 'no-indexer' and the receiver paths abstain (fail closed); wire
        // DOGE_INDEXER_URL fleet-wide before deploy.
        this.indexers = {};
        for(let coin of coins.ALLOWED_COINS){
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }
        // Confirmation depth an ANCHOR must reach on DOGE before a peer's
        // announcement is trusted for stamp/reward (operator decision: reject
        // 0-conf, depth = XCHAIN_CONFIRMATIONS_DOGE). Same env -> p2pConfig ->
        // per-coin default idiom the cross-chain engines use (mainnet
        // floor-clamped, see coins.resolveConfirmations - ).
        this.dogeConfirmations = coins.resolveConfirmations(cfg, this.network).DOGE;
    }

    setBroadcastHook(fn){ this.broadcastFn = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setBalanceHook(fn){ this.getBalanceFn = fn; }

    // Operator-facing stats. Exposed here so callers (hub RPC, status routes)
    // can surface cumulative archive health without grepping logs.
    getAnchorStats(){
        return {
            enabled:            this.enabled,
            anchorsPublished:   this._anchorsPublished,
            archiveChunkLosses: this._archiveChunkLosses,
            // Publisher-wallet runway: last-observed DOGE balance, its age, and the
            // low-balance threshold the publisher already warns at. dogeBalance is
            // null until the first flush reads it (or when no DOGE pipeline is set).
            dogeAddress:        this.dogeAddress || null,
            dogeBalance:        this._lastBalance,
            dogeBalanceAt:      this._lastBalanceAt,
            lowBalanceThreshold: this.lowBalanceThreshold
        };
    }

    async start(){
        if(!this.enabled){ console.log('StateAnchorPublisher: disabled (ANCHOR_ENABLED=false)'); return; }
        // Fill any indexer URL left empty at construction (configs-table-
        // provisioned hubs carry no *_INDEXER_URL env var) via the hub's
        // configs-aware resolver, so anchor on-chain verification reaches the
        // indexer instead of returning 'no-indexer' on a standard hub.
        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        if(this.peerManager){
            this._messageHandler = (env) => this._handleMessage(env);
            this.peerManager.on('message', this._messageHandler);
        }
        if(this.hub.crossChainDex){
            this._matchHandler = () => {
                if(++this._pendingMatches >= this.batchSize)
                    this.flush().catch(err => console.error('StateAnchorPublisher: size-trigger flush error:', err && err.message));
            };
            // Engine-level event; fires after the match row is written (the archive
            // round reads cross_chain_matches), unlike the consensus-level event.
            this.hub.crossChainDex.on('match:finalized', this._matchHandler);
        }
        if(this.hub.crossChainCalls){
            // XCALL relay rows share the size trigger: they ride the same archive.
            this._callHandler = () => {
                if(++this._pendingMatches >= this.batchSize)
                    this.flush().catch(err => console.error('StateAnchorPublisher: size-trigger flush error:', err && err.message));
            };
            this.hub.crossChainCalls.on('call:dispatch', this._callHandler);
            this.hub.crossChainCalls.on('call:result',   this._callHandler);
        }
        this._timer = setInterval(() => {
            this.flush().catch(err => console.error('StateAnchorPublisher: interval flush error:', err && err.message));
        }, this.intervalMs);
        if(this._timer.unref) this._timer.unref();
        console.log('StateAnchorPublisher started (interval ' + this.intervalMs + 'ms, batch ' + this.batchSize + ', address ' + (this.dogeAddress || '<unset>') + ')');
    }

    async stop(){
        if(this._timer){ clearInterval(this._timer); this._timer = null; }
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if(this._matchHandler && this.hub.crossChainDex){
            this.hub.crossChainDex.removeListener('match:finalized', this._matchHandler);
            this._matchHandler = null;
        }
        if(this._callHandler && this.hub.crossChainCalls){
            this.hub.crossChainCalls.removeListener('call:dispatch', this._callHandler);
            this.hub.crossChainCalls.removeListener('call:result',   this._callHandler);
            this._callHandler = null;
        }
        if(this._archiveRound && this._archiveRound.timer) clearTimeout(this._archiveRound.timer);
        this._archiveRound = null;
        if(this._attestRound && this._attestRound.timer) clearTimeout(this._attestRound.timer);
        if(this._attestRound && !this._attestRound.done && this._attestRound.resolve)
            this._attestRound.resolve({ met: false, sigs: [] });   // unblock any awaiting publish
        this._attestRound = null;
    }

    // Flush: publish pending v0 checkpoints + the pending archive batch.
    // Returns a summary (also served by the hub's `anchorflush` RPC):
    // { anchored: [{chain, network, block_index, txid}], archive: 'published'|
    //   'round_started'|'none', skipped: 'already_flushing'|'no_pipeline'? }
    async flush(){
        if(this._flushing) return { anchored: [], archive: 'none', skipped: 'already_flushing' };
        this._flushing = true;
        try {
            let btcBlock = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;

            let signer = this._resolveSigner();
            if(!signer.broadcastFn && !(signer.encoder && signer.walletSignFn)){
                if(!this._loggedNoPipeline){
                    console.warn('StateAnchorPublisher: no DOGE broadcast pipeline configured; anchors deferred (set DOGE_ENCODER_URL + a wallet-sign hook)');
                    this._loggedNoPipeline = true;
                }
                return { anchored: [], archive: 'none', skipped: 'no_pipeline' };
            }
            await this._checkBalance(signer);

            let anchored = await this._publishPendingCheckpoints(signer, btcBlock);
            let archive  = await this._startArchiveRound(signer, btcBlock);
            return { anchored: anchored, archive: archive };
        } catch(e){
            console.error('StateAnchorPublisher: flush failed:', e && e.message);
            return { anchored: [], archive: 'none', error: e && e.message };
        } finally {
            this._flushing = false;
        }
    }

    // Deterministic publisher ordering (AttestationRound's responsible-set
    // idiom): sort the eligible set by SHA256(key ‖ pubkey) ascending. Every
    // hub computes the identical order from the block-boundary snapshot.
    static hashOrder(key, pubkeys){
        return (pubkeys || []).map(pk => {
            let p = String(pk).toLowerCase();
            return { pubkey: p, hash: crypto.createHash('sha256').update(key, 'utf8').update(p, 'utf8').digest('hex') };
        }).sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0)).map(e => e.pubkey);
    }

    _v0ElectionKey(row){
        return 'XANCV0|' + row.chain + '|' + row.network + '|' + String(row.checkpoint_seq) + '|' + String(row.snapshot_block);
    }

    // May THIS hub publish for `order` right now? Rank 0 always may; each
    // additional rank unlocks after ANCHOR_ELECTION_TOLERANCE_BLOCKS more BTC
    // blocks past the election anchor point (deterministic failover ladder).
    // A hub outside a non-empty eligible set never publishes, and an empty
    // (unresolved/unavailable) set means abstain (fail closed), never a
    // free-for-all where every hub double-anchors the same checkpoint.
    _mayPublish(order, sinceBlocks){
        // Single source of truth for the v0 failover ladder: delegate to _rankUnlocked
        // over our own pubkey so the leader-election path and its follower verifiers can
        // never drift. Behaviour is identical to the prior inline form: an empty order or
        // a pubkey absent from it -> rank < 0 -> false; rank 0 (incl. the order.length===1
        // case) -> true; otherwise rank <= unlocked.
        if(!this.identity) return false;
        return this._rankUnlocked(order, String(this.identity.getPubkeyHex()).toLowerCase(), sinceBlocks);
    }

    // v0: one per chain/network (the LATEST checkpoint that has no anchor yet).
    // Older unanchored checkpoints are superseded (the chained hashes commit to
    // all prior history), so only the newest per chain costs DOGE bytes.
    // Each row elects its own publisher (hash-order at its snapshot_block).
    async _publishPendingCheckpoints(signer, btcBlock){
        // Pick, per chain, the latest ANCHOR-ELIGIBLE checkpoint (seq divisible by
        // anchorEveryNCheckpoints) that is not yet on-chain. Selecting the max
        // eligible seq rather than the absolute max means accumulated
        // non-multiple seqs never block: they simply stay off-chain. With N=1
        // (MOD(seq,1)=0 for all) this is identical to anchoring every checkpoint.
        // Scoped to this.network when one is configured (matching
        // StateCheckpointEngine's latch loader): a hub DB carrying rows from a
        // prior network deployment must never re-elect publishers for (or spend
        // a real DOGE anchor on) a dead network's perpetually-unanchored
        // checkpoints. A hub with no configured network keeps the legacy
        // unscoped behavior rather than filtering everything out.
        let pendingSql =
            'SELECT sc.* FROM state_checkpoints sc JOIN (' +
            '  SELECT chain, network, MAX(checkpoint_seq) AS max_seq FROM state_checkpoints' +
            '  WHERE MOD(checkpoint_seq, ?) = 0 GROUP BY chain, network' +
            ') t ON sc.chain = t.chain AND sc.network = t.network AND sc.checkpoint_seq = t.max_seq ' +
            'WHERE sc.anchor_txid IS NULL';
        let pendingParams = [this.anchorEveryNCheckpoints];
        if(this.network){ pendingSql += ' AND sc.network = ?'; pendingParams.push(this.network); }
        let rows = await this.db.doQuery(pendingSql, pendingParams);
        let anchored = [];
        for(let row of (rows || [])){
            try {
                let eligible = await this._getActiveOraclePublishPubkeys(Number(row.snapshot_block));
                // Fail closed: an empty/unresolved oracle_publish set is NOT a
                // licence for every hub to anchor independently (a guaranteed
                // N-way double-anchor + DOGE burn). Skip until the set resolves.
                if(eligible.length === 0){
                    console.warn('StateAnchorPublisher: v0 anchor for ' + row.chain + '/' + row.network +
                                 ' @ ' + row.block_index + ' deferred: empty oracle_publish set (fail closed)');
                    continue;
                }
                let order = StateAnchorPublisher.hashOrder(this._v0ElectionKey(row), eligible);
                let since = Number.isFinite(btcBlock) ? btcBlock - Number(row.snapshot_block) : null;
                if(!this._mayPublish(order, since)) continue;            // someone else's anchor (or not unlocked yet)
                // SPV Phase 2: emit ANCHOR v3 (carries + signs the light-client roots) when the
                // checkpoint was signed post-flag-day AND actually carries the roots; otherwise the
                // legacy v0. The roots-present check keeps a legacy/null-root row (signed over the
                // rootless canonical) on v0 so its sigs still verify, mirroring the canonical suffix
                // gating in StateCheckpointEngine._checkpointRootSuffix.
                let useV3 = ckpt.isCheckpointCommitmentActive(Number(row.snapshot_block), row.network) &&
                            row.state_root != null && row.block_merkle_root != null &&
                            row.state_root_version != null && row.block_merkle_version != null;
                // Anchor-reward re-derivation flag-day: at/above it, run the publisher-
                // attestation round (2f+1 oracle_publish quorum over XANCPUB binding THIS
                // hub as the earner) and emit ANCHOR v4 (rootless) / v5 (root-bearing),
                // which carries the attestation so the indexer DERIVES the reward and the
                // forgeable hub push is retired (#5311). LIVENESS-SAFE: a degraded round
                // (timeout / short quorum / not a snapshot member) FALLS BACK to legacy
                // v0/v3, so the anchor always lands; only reward issuance gains the quorum
                // dependency. A failed reward attestation must NEVER block the anchor.
                let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
                let payload;
                let attested = false;   // a v4/v5 (reward-derivable) payload was actually built
                if(me && ar.isAnchorRewardActive(Number(row.snapshot_block), row.network)){
                    let attest = await this._runPublisherAttestationRound(this._cpFromRow(row), me);
                    if(attest && attest.met && attest.sigs.length >= 1){
                        payload = useV3 ? this._buildV5Payload(row, me, attest.sigs)
                                        : this._buildV4Payload(row, me, attest.sigs);
                        attested = true;
                    } else {
                        console.warn('StateAnchorPublisher: publisher-attestation quorum not reached for ' +
                                     row.chain + '/' + row.network + ' @ ' + row.block_index +
                                     '; publishing legacy v' + (useV3 ? '3' : '0') + ' (anchor lands, no reward)');
                        payload = useV3 ? this._buildV3Payload(row) : this._buildV0Payload(row);
                    }
                } else {
                    payload = useV3 ? this._buildV3Payload(row) : this._buildV0Payload(row);
                }
                let broadcaster = signer.broadcastFn || ((p) => this._defaultBroadcast(p, signer));
                // Multiple chains' v0 anchors go out back-to-back from the same
                // wallet; without the retry, every cycle lands only the first
                // and the rest stagger one chain per 30-min flush (live prod
                // finding, first post-deploy cycle).
                let result = await this._broadcastWithRetry(broadcaster, payload);
                let txid = result && result.txid ? result.txid : null;
                if(!txid){
                    // A confirmed DOGE broadcast always returns a txid; a null txid
                    // is a false/incomplete success (broadcastTx returned empty
                    // instead of throwing). Treat it as a failed publish: leave the
                    // row pending (anchor_txid stays NULL) and do NOT stamp the row,
                    // record a reward, or announce XANC_V0_DONE. Stamping NULL keeps
                    // the row matching the `WHERE sc.anchor_txid IS NULL` selector so
                    // it re-anchors and re-burns DOGE every flush, and peers ignore a
                    // null-txid announcement anyway (_handleV0Done early-returns on
                    // !d.txid). A later flush retries the publish cleanly.
                    console.error('StateAnchorPublisher: v0 broadcast returned no txid for ' +
                                  row.chain + '/' + row.network + ' @ ' + row.block_index +
                                  '; treating as failed publish (row stays pending)');
                    continue;
                }
                // First-writer-wins, exactly like the peer path in _handleV0Done
                // (`... AND anchor_txid IS NULL`). In the documented failover race
                // (a late rank-0 and an early rank-1 both publish because the
                // shared pending signal is `anchor_txid IS NULL`) a hub may have
                // already stamped a peer's txid via V0_DONE; without this guard,
                // completing our own in-flight publish would overwrite it and
                // leave the fleet holding divergent anchor_txid bytes for the row.
                await this.db.doQuery(
                    'UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid IS NULL',
                    [txid, row.chain, row.network, row.block_index, row.checkpoint_seq]);
                console.log('StateAnchorPublisher: anchored checkpoint ' + row.chain + '/' + row.network +
                            ' @ ' + row.block_index + ' (txid ' + txid + ')');
                anchored.push({ chain: row.chain, network: row.network, block_index: Number(row.block_index), txid: txid });
                this._anchorsPublished++;
                // At/above the anchor-reward flag-day the per-chain reward is DERIVED
                // on-chain from the v4/v5 publisher attestation (the hub push is
                // retired), and the indexer credits NOTHING for a legacy v0/v3.
                // Recording the reward on the degraded fallback would strand it in
                // hub-local + archive bookkeeping only: no live indexer credits it,
                // but a recovering node restores the archived row, forking the
                // COLLECT-spendable ledger live-vs-recovered. Record only when the
                // published payload actually carries the attestation, or below the
                // flag-day (where the legacy push path credits live indexers).
                if(attested || !ar.isAnchorRewardActive(Number(row.snapshot_block), row.network)){
                    this._recordReward('anchor_' + row.chain, Number(row.checkpoint_seq),
                                       this.identity ? this.identity.getPubkeyHex() : null,
                                       Number(row.snapshot_block));
                } else {
                    console.log('StateAnchorPublisher: degraded legacy anchor at/above the reward flag-day for ' +
                                row.chain + '/' + row.network + ' @ ' + row.block_index +
                                '; reward withheld (no live indexer derives it from a v' + (useV3 ? '3' : '0') + ')');
                }
                // Tell peers so THEIR copy of the row stops being pending.
                // Without this, every hub whose failover rank unlocks would
                // re-anchor a checkpoint someone else already paid for.
                if(this.peerManager && this.identity){
                    this.peerManager.broadcast(XANC_V0_DONE, {
                        chain: row.chain, network: row.network, block_index: Number(row.block_index),
                        checkpoint_seq: Number(row.checkpoint_seq), txid: txid,
                        sig_pubkey: this.identity.getPubkeyHex().toLowerCase(),
                        sig: this.identity.sign(this._v0DoneCanonical(row, txid))
                    });
                }
            } catch(e){
                console.error('StateAnchorPublisher: v0 publish failed for ' + row.chain + ': ' + (e && e.message));
            }
        }
        return anchored;
    }

    // Anchor-publish reward: the validator that paid the DOGE earns it. Recorded
    // on EVERY hub (by the publisher at publish time and by peers from the
    // signature-verified V0_DONE / FINALIZED announcements) with blockIndex =
    // the quorum-agreed snapshot_block of the rewarded checkpoint, so all hubs
    // hold identical row bytes and the archived rewards section verifies by
    // re-derivation. recordAnchorReward dedups all paths, including a failover
    // race that hands the same (round, type) to two different publisher pubkeys,
    // which it collapses to a single deterministic per-(round,type) winner.
    _recordReward(rewardType, roundNumber, pubkey, blockIndex){
        if(!this.hub.rewardTracker || typeof this.hub.rewardTracker.recordAnchorReward !== 'function') return;
        if(!pubkey) return;
        this.hub.rewardTracker
            .recordAnchorReward(rewardType, roundNumber, String(pubkey).toLowerCase(), Number.isFinite(blockIndex) ? blockIndex : 0)
            .catch(e => console.warn('StateAnchorPublisher: reward record failed (' + rewardType + '/' + roundNumber + '): ' + (e && e.message)));
    }

    _buildV0Payload(row){
        let sigs = this._parseSigs(row.validator_signatures);
        let parts = ['ANCHOR', '0', row.chain, row.network, String(row.block_index), row.block_hash,
                     row.ledger_hash, row.actions_hash, row.contract_hash,
                     String(row.checkpoint_seq), String(row.snapshot_block), String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        return parts.join('|');
    }

    // SPV Phase 2 (spec §6.3): v0 checkpoint PLUS the two light-client roots + version
    // bytes appended before SIG_COUNT (positional). The roots come straight from the
    // signed state_checkpoints row; the row's sigs already cover them (the post-flag-day
    // checkpoint canonical includes the same roots), so this transports signed data.
    _buildV3Payload(row){
        let sigs = this._parseSigs(row.validator_signatures);
        let parts = ['ANCHOR', '3', row.chain, row.network, String(row.block_index), row.block_hash,
                     row.ledger_hash, row.actions_hash, row.contract_hash,
                     String(row.checkpoint_seq), String(row.snapshot_block),
                     String(row.state_root || '').toLowerCase(), String(row.state_root_version),
                     String(row.block_merkle_root || '').toLowerCase(), String(row.block_merkle_version),
                     String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        return parts.join('|');
    }

    // ANCHOR v4 (anchor-reward flag-day): the rootless v0 checkpoint PLUS the elected
    // PUBLISHER pubkey and a 2f+1 oracle_publish attestation (XANCPUB) over the reward
    // tuple, appended AFTER the root signature list. The indexer re-derives the reward
    // from these bytes (anchor.js formats[4]), so the trusted hub push is retired (#5311).
    // Field order MUST match the indexer parser: ...|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|
    // ATTEST_SIG_COUNT|APUBKEY|ASIG|...
    _buildV4Payload(row, publisher, attestSigs){
        let sigs = this._parseSigs(row.validator_signatures);
        let parts = ['ANCHOR', '4', row.chain, row.network, String(row.block_index), row.block_hash,
                     row.ledger_hash, row.actions_hash, row.contract_hash,
                     String(row.checkpoint_seq), String(row.snapshot_block), String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        parts.push(String(publisher).toLowerCase(), String((attestSigs || []).length));
        for(let s of (attestSigs || [])) parts.push(String(s.pubkey).toLowerCase(), String(s.sig).toLowerCase());
        return parts.join('|');
    }

    // ANCHOR v5: the root-bearing v3 checkpoint (SPV light-client roots + version bytes)
    // PLUS the same publisher + XANCPUB attestation tail as v4 (indexer formats[5]). Emitted
    // instead of v3 when the checkpoint carries roots AND the anchor-reward flag-day is met.
    _buildV5Payload(row, publisher, attestSigs){
        let sigs = this._parseSigs(row.validator_signatures);
        let parts = ['ANCHOR', '5', row.chain, row.network, String(row.block_index), row.block_hash,
                     row.ledger_hash, row.actions_hash, row.contract_hash,
                     String(row.checkpoint_seq), String(row.snapshot_block),
                     String(row.state_root || '').toLowerCase(), String(row.state_root_version),
                     String(row.block_merkle_root || '').toLowerCase(), String(row.block_merkle_version),
                     String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        parts.push(String(publisher).toLowerCase(), String((attestSigs || []).length));
        for(let s of (attestSigs || [])) parts.push(String(s.pubkey).toLowerCase(), String(s.sig).toLowerCase());
        return parts.join('|');
    }

    // Publisher-attestation canonical (XANCPUB): the string the 2f+1 oracle_publish quorum
    // signs to ATTEST which validator earns the anchor reward. MUST be BYTE-IDENTICAL to the
    // indexer's Anchor._rewardCanonical (a divergence forks the derived reward row). The
    // amount is the FROZEN consensus constant (ar.ANCHOR_REWARD_AMOUNT, read from the twin
    // module, NOT the operator-tunable ANCHOR_REWARD_PER_PUBLISH env). The EQUIV wrapper uses
    // the checkpoint's NETWORK (cp.network) like _canonical/_archiveCanonical, NOT this.network,
    // and a distinct 'XANCPUB|...' roundId gives the attestation its own equivocation family so
    // a validator that signs both the checkpoint root canonical and this reward attestation in
    // the same round is never falsely slashable.
    _attestationCanonical(cp, publisher){
        let base = ['XANCPUB', 'anchor_' + cp.chain, String(cp.checkpoint_seq),
                    String(cp.snapshot_block), String(publisher || '').toLowerCase(),
                    ar.ANCHOR_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network)){
            let roundId = 'XANCPUB|' + cp.chain + '|' + cp.network + '|' + cp.checkpoint_seq + '|' + cp.snapshot_block;
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    }

    // Run the publisher-attestation round for a checkpoint THIS hub is publishing.
    // Resolves { met, sigs:[{pubkey,sig}], publisher } once a 2f+1 oracle_publish quorum
    // (stake-weighted at/above STAKE_WEIGHTED_QUORUM, else count) co-signs XANCPUB, or
    // { met:false } on timeout / short quorum. The SIGNING/QUORUM set is resolved at the
    // checkpoint's snapshot_block, the SAME set the indexer (anchor.js) verifies the
    // attestation against, so the hub never collects a quorum the chain then rejects.
    async _runPublisherAttestationRound(cp, publisher){
        if(!this.identity) return { met: false, sigs: [] };

        let signingSet     = await this._resolveCapabilitySet('oracle_publish', Number(cp.snapshot_block));
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        let weighted       = swq.isStakeWeightedQuorumActive(Number(cp.snapshot_block), this.network);
        let quorum         = (snapCount <= 1) ? 1 : Math.max(2 * Math.floor((snapCount - 1) / 3) + 1, Math.ceil((snapCount + 1) / 2));

        let me        = this.identity.getPubkeyHex().toLowerCase();
        let canonical = this._attestationCanonical(cp, publisher);
        let mySig     = this.identity.sign(canonical);

        // The publisher must itself hold oracle_publish at snapshot_block, or the indexer
        // drops the reward (PUBLISHER must be in the verified set). Fall back to a legacy
        // anchor rather than emit a v4/v5 whose reward can never be credited.
        if(snapCount > 0 && !signingPubkeys.includes(me)) return { met: false, sigs: [] };

        let signatures = new Map();
        signatures.set(me, mySig);

        // Single-node / unresolved set: the publisher's own attestation is the quorum
        // (mirrors the archive round's snapCount<=1 self-sign bypass).
        if(snapCount <= 1 || !this.peerManager)
            return { met: true, sigs: [{ pubkey: me, sig: mySig }], publisher: publisher };

        return await new Promise((resolve) => {
            // Full {pubkey, source, weight} set so the stake-weighted tally can sum
            // distinct-source stake, identical to the archive round.
            let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
            // Preserve the truncation flag so the weighted reward quorum
            // (_checkAttestQuorum via meetsStakeThreshold) fails closed on an over-cap
            // oracle_publish snapshot, identical to the archive round (_startArchiveRound:899).
            // Without this the publisher-attestation quorum fail-OPENS on a truncated set,
            // emitting a v4/v5 whose reward the indexer would drop (stranded credit).
            if(signingSet.truncated === true) roundValidators.truncated = true;
            let round = {
                cp, publisher, canonical, quorum, weighted, resolve,
                validators: roundValidators,
                signatures, done: false, timer: null
            };
            this._attestRound = round;
            round.timer = setTimeout(() => {
                if(this._attestRound === round && !round.done){
                    round.done = true;
                    this._attestRound = null;
                    console.warn('StateAnchorPublisher: publisher-attestation round (seq ' + cp.checkpoint_seq +
                                 ') timed out at ' + round.signatures.size + '/' + quorum + ' sigs; legacy fallback');
                    resolve({ met: false, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })) });
                }
            }, this.roundTimeoutMs);
            if(round.timer.unref) round.timer.unref();

            this.peerManager.broadcast(XANCPUB_SIGN_REQ, {
                checkpoint: cp, publisher: publisher, sig_pubkey: me, sig: mySig
            });
            this._checkAttestQuorum();
        });
    }

    _checkAttestQuorum(){
        let round = this._attestRound;
        if(!round || round.done) return;
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._attestRound = null;
        round.resolve({ met: true, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })), publisher: round.publisher });
    }

    // Follower: co-sign the publisher attestation ONLY when the proposer is the
    // legitimately rank-unlocked publisher of a checkpoint that byte-matches our own
    // state_checkpoints row, and we ourselves hold oracle_publish at its snapshot_block.
    // The frozen amount is enforced implicitly: we rebuild the canonical with
    // ar.ANCHOR_REWARD_AMOUNT, so a wire-supplied amount can never be co-signed.
    async _handleAttestSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d || !d.checkpoint) return;
        let cp        = d.checkpoint;
        let myPubkey  = this.identity.getPubkeyHex().toLowerCase();
        let sender    = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;
        // The publisher attests ITSELF: the proposer must be the rewarded publisher, or it
        // is binding a pubkey it is not entitled to.
        let publisher = String(d.publisher || '').toLowerCase();
        if(publisher !== sender) return;

        // Re-run the v0 publisher election (oracle_publish @ snapshot_block, hash-ordered by
        // the v0 election key) and confirm the proposer is rank-unlocked on the SAME failover
        // ladder _publishPendingCheckpoints used, bounded to our own BTC tip (anti-spam; the
        // binding security is the checkpoint + frozen-amount re-derivation below).
        let eligible = await this._getActiveOraclePublishPubkeys(Number(cp.snapshot_block));
        if(eligible.length === 0) return;
        {
            // Run the ladder check for EVERY set size: a single-member set must
            // still bind sender === eligible[0] (rank 0), or any current member
            // could impersonate the sole elected publisher.
            let order = StateAnchorPublisher.hashOrder(this._v0ElectionKey(cp), eligible);
            let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
            let since = Number.isFinite(myBtc) ? myBtc - Number(cp.snapshot_block) : null;
            if(!this._rankUnlocked(order, sender, since)) return;          // proposer not unlocked
        }
        // Only co-sign if WE hold oracle_publish at snapshot_block, or the indexer would drop
        // our attestation signature anyway (same gate the archive follower applies).
        if(!eligible.includes(myPubkey)) return;

        // The checkpoint must equal OUR own state_checkpoints row (latest seq for the height);
        // a reorg-superseded row never attests. canonicalCheckpoint binds chain/network/
        // block_index/hashes/checkpoint_seq/snapshot_block, so this also rejects a proposer
        // whose seq or snapshot_block differs from ours.
        let local = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? ORDER BY checkpoint_seq DESC LIMIT 1',
            [cp.chain, cp.network, Number(cp.block_index)]);
        if(!local || local.length === 0) return;
        let mine = this._cpFromRow(local[0]);
        if(StateCheckpointEngine.canonicalCheckpoint(mine) !== StateCheckpointEngine.canonicalCheckpoint(cp)) return;

        let canonical = this._attestationCanonical(cp, publisher);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;   // proposer's own sig

        this.peerManager.broadcast(XANCPUB_SIGN, {
            chain: cp.chain, network: cp.network,
            checkpoint_seq: Number(cp.checkpoint_seq), snapshot_block: Number(cp.snapshot_block),
            sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    async _handleAttestSign(envelope){
        let d = envelope.data;
        let round = this._attestRound;
        if(!round || round.done || !d) return;
        // Match the active round by checkpoint identity (chain/network/seq/snapshot_block).
        if(String(d.chain) !== String(round.cp.chain) || String(d.network) !== String(round.cp.network) ||
           Number(d.checkpoint_seq) !== Number(round.cp.checkpoint_seq) ||
           Number(d.snapshot_block) !== Number(round.cp.snapshot_block)) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        this._checkAttestQuorum();
    }

    // Archive round (v1/v2).
    // Leader = hash-order rank 0 over the oracle_publish set, with the same
    // failover ladder as v0 anchors: the election key is anchored on the archive
    // CONTENT (wrapper checkpoint + batch seq; deterministic + identical on
    // every hub, and stable while the batch is stalled), and each further rank
    // unlocks after another ANCHOR_ELECTION_TOLERANCE_BLOCKS past the wrapper
    // checkpoint's snapshot_block. Without the ladder a signer-less elected
    // leader stalled archiving (live on a 3-hub test cluster: only 1-of-3 elections could
    // publish; on a static regtest tip the same leader won forever). Returns
    // the flush summary's archive status.
    async _startArchiveRound(signer, electionBlock){
        if(this._archiveRound) return 'round_pending';                       // one at a time

        // Leader ELECTION runs over the set at the current BTC block (liveness: a
        // freshly-joined validator can take over a stalled publish even when the
        // wrapper checkpoint's snapshot_block is hours old). This set decides only
        // WHO drives the round + pays the DOGE; it does NOT gate which signatures
        // count on-chain (that is the snapshot_block signing set resolved below).
        let electionPubkeys = await this._getActiveOraclePublishPubkeys(electionBlock);
        let me = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
        // Fail closed: an empty/unresolved oracle_publish set must defer the
        // archive round, not let every hub drive it independently (each would
        // broadcast a competing v1 + burn DOGE for the same batch slot).
        if(electionPubkeys.length === 0){
            console.log('StateAnchorPublisher: archive election at block ' + electionBlock +
                        ': empty oracle_publish set, deferring round (fail closed)');
            return 'none';
        }
        if(!me) return 'none';
        if(!electionPubkeys.includes(me)){
            console.log('StateAnchorPublisher: archive election at block ' + electionBlock +
                        ': own pubkey not in the oracle_publish election set (' + electionPubkeys.length + ' eligible)');
            return 'none';                                               // not an eligible publisher right now
        }

        let matches = await this.db.doQuery(
            "SELECT * FROM cross_chain_matches WHERE batch_seq IS NULL OR archived_status <> status " +
            "ORDER BY match_id ASC LIMIT ?", [this.maxBatch]);
        let calls = await this.db.doQuery(
            "SELECT * FROM cross_chain_calls WHERE batch_seq IS NULL OR archived_status <> status " +
            "ORDER BY call_id ASC, phase ASC LIMIT ?", [this.maxBatch]);
        // Archive transport for the anchor_% reward rails. Read this before touching
        // recovery dedup: the "indexer can never re-derive these" invariant is NOT
        // uniformly true any more, and the difference matters because these rows land
        // on the COLLECT-spendable ledger.
        //   - anchor_archive, and anchor_<CHAIN> BELOW the anchor-reward flag-day:
        //     genuinely hub-pushed. The chain carries no parse for them, so the archive
        //     is their only recovery transport. The original invariant holds here.
        //   - anchor_<CHAIN> AT/ABOVE the flag-day: the indexer DOES re-derive these
        //     on-chain from the v4/v5 XANCPUB publisher attestation (anchor.js
        //     createValidatorReward / reconcileAnchorRewardWinner), crediting the same
        //     frozen ANCHOR_REWARD_AMOUNT. The hub still records the row locally
        //     (RewardTracker isDerived path) and this selector still archives it, so the
        //     archive redundantly transports a row the chain reproduces.
        // That redundancy is safe ONLY because restore and derive both key on the UNIQUE
        // (validator_pubkey, round_number, reward_type), so the two paths dedup and the
        // amounts agree. Weaken that dedup and the archived anchor_<CHAIN> row becomes a
        // genuine SECOND credit. Do not treat "archived" as proof of "not re-derivable".
        // (oracle_round/attest_fee rows are indexer-derived and NEVER archived.)
        // Rows are immutable, so batch_seq IS NULL is the only pending test;
        // pre-upgrade rows without a deterministic block_index stay local.
        let rewards = await this.db.doQuery(
            "SELECT * FROM validator_rewards WHERE reward_type LIKE 'anchor\\_%' AND batch_seq IS NULL AND block_index IS NOT NULL " +
            "ORDER BY reward_type ASC, round_number ASC, validator_pubkey ASC LIMIT ?", [this.maxBatch]);
        if((!matches || matches.length === 0) && (!calls || calls.length === 0) && (!rewards || rewards.length === 0)){ this._pendingMatches = 0; return 'none'; }
        matches = matches || [];
        calls   = calls   || [];
        rewards = rewards || [];

        // The checkpoint wrapper: latest checkpoint (prefer BTC; its height also
        // selects validator sets). Without any checkpoint there is nothing to bind
        // the archive's signatures to, so defer until the checkpoint engine has run.
        // Scoped to this.network when one is configured, so a prior-network
        // leftover row can never become the archive wrapper (same hazard the
        // latch loader defends against); unconfigured-network hubs keep the
        // legacy unscoped selection.
        let cps = this.network
            ? await this.db.doQuery(
                "SELECT * FROM state_checkpoints WHERE network = ? ORDER BY (chain = 'BTC') DESC, id DESC LIMIT 1",
                [this.network])
            : await this.db.doQuery(
                "SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC, id DESC LIMIT 1");
        if(!cps || cps.length === 0){
            console.log('StateAnchorPublisher: no state checkpoint yet; archive deferred');
            return 'none';
        }
        let cp = this._cpFromRow(cps[0]);

        let network  = String(cps[0].network);
        let batchSeq = await this._getNextBatchSeq();

        {
            // Unconditional (all set sizes): the membership check above already
            // pins the size-1 identity, and a single-member ladder resolves to
            // rank 0 (always unlocked), so this is uniform, not a behavior change.
            let order = StateAnchorPublisher.hashOrder(this._archiveElectionKey(cp, batchSeq), electionPubkeys);
            let since = Number.isFinite(electionBlock) ? electionBlock - Number(cp.snapshot_block) : null;
            if(!this._rankUnlocked(order, me, since)){
                // Operator visibility: a hub that never wins the archive
                // election (e.g. signer-less peers keep ranking first) is
                // indistinguishable from a broken publisher without this.
                console.log('StateAnchorPublisher: archive election (batch ' + batchSeq + ') at block ' + electionBlock +
                            ': rank ' + order.indexOf(me) + '/' + order.length + ' (leader ' +
                            order[0].substring(0, 12) + '..., ladder unlocks a rank every ' +
                            this.electionToleranceBlocks + ' blocks), not publishing');
                return 'none';                                               // not unlocked on the failover ladder
            }
        }
        // Pin each reward's earn-time source into the archive (resolved via the
        // BTC indexer, block-scoped; every hub gets the same answer, and
        // recovery restores rewards BEFORE the BTC reindex so it cannot resolve
        // them itself). An unresolvable source leaves the row for a later batch
        // rather than archiving a hole.
        let rewardRows = [];
        for(let r of rewards){
            let source = this.hub.rewardTracker
                ? await this.hub.rewardTracker.resolveSourceByPubkey(String(r.validator_pubkey), Number(r.block_index))
                : null;
            if(!source){
                console.warn('StateAnchorPublisher: reward ' + r.reward_type + '/#' + r.round_number +
                             ' source unresolved for ' + String(r.validator_pubkey).substring(0, 12) + '... deferred to a later batch');
                continue;
            }
            rewardRows.push({ row: r, source: source });
        }

        // After source resolution, a round with no matches, no calls, and no
        // RESOLVABLE rewards has nothing to archive. The raw empty-check above
        // counts unresolvable rewards as pending, so without this an unstaked
        // single-validator hub (its own anchor-reward pubkey resolves to no
        // stake source) re-publishes an empty 0/0/0 archive to DOGE every cycle
        // (a live prod fee-burn finding). The unresolvable rows stay pending
        // (batch_seq NULL) for a later batch that can resolve them; recording is
        // deliberately unconditional (every hub holds identical rows for the
        // federation re-derivation invariant), so we suppress the empty PUBLISH,
        // not the record. Real federations are unaffected: a staked publisher's
        // rewards resolve, so rewardRows is non-empty whenever rewards are.
        if(matches.length === 0 && calls.length === 0 && rewardRows.length === 0){
            this._pendingMatches = 0;
            return 'none';
        }

        let archive  = await this._buildArchive(network, batchSeq, matches, cp.snapshot_block, calls, rewardRows);
        let json     = archive.json;
        let crc      = this._crc32Hex(json);
        let b64      = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
        let chunks   = this._splitChunks(b64);

        let canonical = this._archiveCanonical(cp, batchSeq, archive.count, crc, chunks.length);
        if(!this.identity) throw new Error('no validator identity: cannot sign archives');
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let mySig    = this.identity.sign(canonical);

        // SIGNING/QUORUM set: resolved at the wrapper checkpoint's snapshot_block.
        // The block the published v1 declares on the wire is the block the indexer
        // (anchor.js) + full-parse recovery verify the wrapper signatures against
        // (oracle_publish @ snapshot_block). Resolving it at the current election
        // block instead would let signers present only in the current set
        // contribute signatures the indexer later drops, pushing validSigs below
        // quorum, marking the v1 invalid on-chain while the rows get dequeued
        // anyway (see the on-chain-validity gate in _publishArchive), permanently
        // losing settled cross-chain state. The election set above may differ
        // (liveness); the set that gates co-signature acceptance must not.
        // Resolve the SIGNING set as the full {pubkey, source, weight} snapshot via
        // _resolveCapabilitySet (the SAME set the indexer anchor.js + full-parse
        // recovery verify the wrapper signatures against, oracle_publish @
        // snapshot_block, source-keyed). Bare pubkeys would lose the staking weight
        // the stake-weighted gate needs, so the publisher's local quorum decision
        // must use this set, not _getActiveOraclePublishPubkeys.
        let signingSet     = await this._resolveCapabilitySet('oracle_publish', Number(cp.snapshot_block));
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        // STAKE_WEIGHTED_QUORUM: weighted (source-deduped) at/above activation, else
        // legacy 2f+1 count; keyed on the BTC snapshot_block so the hub flips on the
        // same anchor as anchor.js (`swq.isStakeWeightedQuorumActive(snapshotBlock, NETWORK)`).
        let weighted       = swq.isStakeWeightedQuorumActive(Number(cp.snapshot_block), this.network);
        let quorum         = (snapCount <= 1) ? 1 : Math.max(2 * Math.floor((snapCount - 1) / 3) + 1, Math.ceil((snapCount + 1) / 2));

        // Seed the leader's own signature only if the leader is itself in the
        // signing set. A leader elected for liveness but absent from the
        // snapshot_block set must not inflate the local quorum with a signature
        // the indexer will drop on-chain.
        let signatures = new Map();
        if(snapCount <= 1 || signingPubkeys.includes(myPubkey)) signatures.set(myPubkey, mySig);

        // Full {pubkey, source, weight} set so _checkArchiveQuorum can tally
        // distinct-source stake (weight carries the source's stake when weighted).
        // Preserve the truncation flag so the weighted archive quorum (_checkArchiveQuorum
        // via meetsStakeThreshold) fails closed on an over-cap oracle_publish snapshot.
        let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
        if(signingSet.truncated === true) roundValidators.truncated = true;

        let round = {
            cp, batchSeq, crc, b64, chunks, canonical, quorum, weighted, signer, electionBlock,
            count:      archive.count,
            matchIds:   matches.map(m => ({ match_id: m.match_id, status: m.status })),
            callIds:    calls.map(c => ({ call_id: c.call_id, phase: c.phase, status: c.status })),
            rewardIds:  rewardRows.map(({row}) => ({ reward_type: String(row.reward_type), round_number: Number(row.round_number), validator_pubkey: String(row.validator_pubkey).toLowerCase() })),
            validators: roundValidators,
            signatures: signatures,
            done:       false,
            timer:      null
        };

        if(snapCount <= 1){                                                   // single-node: self-sign suffices
            await this._publishArchive(round);
            this._pendingMatches = 0;
            return 'published';
        }

        this._archiveRound = round;
        round.timer = setTimeout(() => {
            if(this._archiveRound === round && !round.done){
                console.warn('StateAnchorPublisher: archive round (batch ' + batchSeq + ') timed out at ' +
                             round.signatures.size + '/' + quorum + ' sigs; retrying next flush');
                this._archiveRound = null;
            }
        }, this.roundTimeoutMs);
        if(round.timer.unref) round.timer.unref();

        this.peerManager.broadcast(XANC_SIGN_REQ, {
            checkpoint: cp, batch_seq: batchSeq, match_count: archive.count,
            batch_crc32: crc, total_chunks: chunks.length, archive_b64: b64,
            election_block: (Number.isFinite(electionBlock) ? electionBlock : 0),
            sig_pubkey: myPubkey, sig: mySig
        });
        await this._checkArchiveQuorum();
        return 'round_started';
    }

    // Content-anchored election key: deterministic + identical on every hub
    // (both fields come from quorum-agreed state) and STABLE while the batch is
    // stalled, so the failover ladder has a fixed anchor to climb against.
    // Unlike the old current-block key, which re-elected fresh every block (and
    // on a static regtest tip elected the SAME leader forever).
    _archiveElectionKey(cp, batchSeq){
        return 'XANCV1|' + cp.chain + '|' + cp.network + '|' + String(cp.checkpoint_seq) + '|' + String(batchSeq);
    }

    // Failover-ladder check shared by leader election and follower verification:
    // rank 0 may publish immediately; each further rank unlocks after another
    // ANCHOR_ELECTION_TOLERANCE_BLOCKS past the anchor point. Concurrent
    // unlocked publishers build byte-identical archives (both verify against
    // the same quorum-agreed rows), so a race is duplicate-tx waste, not a
    // divergence hazard.
    _rankUnlocked(order, pubkey, sinceBlocks){
        let rank = order.indexOf(String(pubkey || '').toLowerCase());
        if(rank < 0) return false;
        if(rank === 0) return true;
        let unlocked = Number.isFinite(sinceBlocks) ? Math.floor(Math.max(0, sinceBlocks) / this.electionToleranceBlocks) : 0;
        return rank <= unlocked;
    }

    // Resolve the qualifying set for (capability, block). Primary source is
    // CapabilitySnapshot.getSnapshot (deterministic from on-chain BTC stakes,
    // identical on EVERY hub), so the archive builder (leader) and the archive
    // verifier (followers) agree regardless of which hub led past rounds (the
    // local capability_snapshots table only holds rows a hub persisted while
    // leading, so it can't be the shared source). Falls back to the local
    // table for seeded/regtest stacks with no live BTC resolution.
    async _resolveCapabilitySet(capability, block){
        // Source-keyed at/above STAKE_WEIGHTED_QUORUM so the archived snapshot rows
        // carry the staking source recovery needs to dedupe weight; legacy set
        // below it (source=''). amount carries the source's weight when weighted.
        let weighted = swq.isStakeWeightedQuorumActive(Number(block), this.network);
        // Gate on snapshot PRESENCE, not non-emptiness, matching the three sibling
        // resolvers (CrossChainDexEngine/CrossChainCallEngine/StateCheckpointEngine)
        // and the _coerceValidators contract: an actual array (even length 0) is a
        // legitimate snapshot; only a malformed shape yields null. Gating on
        // length > 0 conflated "legitimately empty at this block" with "indexer
        // unavailable" and routed the former into the per-hub-local table, so two
        // hubs could resolve different sets/N/quorum for the same (capability, block).
        // A throw from the snapshot call propagates (like the siblings) rather than
        // being swallowed into the divergent local-table fallback.
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, Number(block));
                if(snap && Array.isArray(snap.validators)){
                    let set = snap.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), amount: String(v.weight != null ? v.weight : '0'), source: String(v.source != null ? v.source : '') }));
                    // Carry the truncation flag so the weighted quorum verdict fails closed
                    // on an over-cap snapshot (SWQ-TRUNC parity: a truncated set under-counts
                    // S, so a stake-evicted minority could otherwise clear the 2/3 bar).
                    if(snap.truncated === true) set.truncated = true;
                    return set;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, Number(block));
                if(snap && Array.isArray(snap.validators))
                    return snap.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), amount: String(v.amount != null ? v.amount : '0'), source: '' }));
            }
        }
        // Local-table fallback is gated to seeded/regtest stacks with no live BTC
        // resolution (#1224), matching the sibling resolvers
        // (StateCheckpointEngine/CrossChainCallEngine/CrossChainDexEngine, which seed
        // only when regtest). The local capability_snapshots table holds only rows a
        // hub persisted while leading, so it is NOT the shared source: on mainnet/
        // testnet a null snapshot means THIS hub's indexer is down/misconfigured
        // (CapabilitySnapshot returns null on any fetch/auth/echo failure), and
        // resolving from local rows while healthy peers resolve the on-chain snapshot
        // forks the set bytes for the same (capability, block). Fail closed off
        // regtest so a degraded round stalls (archive verification catches it) rather
        // than building a divergent archive.
        if(this.network !== 'regtest'){
            throw new Error('StateAnchorPublisher: cannot resolve capability set for (' +
                String(capability) + ', ' + Number(block) + '): deterministic snapshot unavailable ' +
                'and the local capability_snapshots table is not a valid shared source off regtest ' +
                '(indexer down/misconfigured); failing closed rather than building a divergent archive');
        }
        let rows = await this.db.doQuery(
            "SELECT signing_pubkey, amount, source FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? ORDER BY signing_pubkey ASC",
            [Number(block), String(capability)]);
        return (rows || []).map(r => ({ pubkey: String(r.signing_pubkey).toLowerCase(), amount: String(r.amount), source: String(r.source != null ? r.source : '') }));
    }

    // Archive JSON with fixed key order (crc32-bearing bytes; see MATCH_KEYS).
    // capability_snapshots makes recovery self-contained: cross_chain rows for
    // every match's snapshot_block (to re-verify match signatures) PLUS the
    // oracle_publish rows at the wrapper checkpoint's snapshot_block (to
    // re-verify the v1 anchor's own signatures). Recovery additionally
    // cross-checks archived pubkeys against on-chain BTC stakes; archived
    // sets are a convenience, the chain remains the root of trust.
    async _buildArchive(network, batchSeq, matches, wrapperSnapshotBlock, calls, rewards){
        calls   = calls   || [];
        rewards = rewards || [];
        let wants = matches.map(m => ({ block: Number(m.snapshot_block), capability: 'cross_chain' }))
            .concat(calls.map(c => ({ block: Number(c.snapshot_block), capability: 'cross_chain' })))
            // oracle_publish set at each reward's earn block; verifiers (and
            // recovery) check the rewarded pubkey was an eligible publisher.
            .concat(rewards.map(({row}) => ({ block: Number(row.block_index), capability: 'oracle_publish' })));
        if(wrapperSnapshotBlock != null)
            wants.push({ block: Number(wrapperSnapshotBlock), capability: 'oracle_publish' });
        let seen = new Set(), snaps = [];
        for(let w of wants.sort((a, b) => a.block - b.block || (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0))){
            let key = w.block + '|' + w.capability;
            if(seen.has(key)) continue;
            seen.add(key);
            let set = await this._resolveCapabilitySet(w.capability, w.block);
            // Total order: pubkey then source. Equal pubkeys are legitimately
            // possible in weighted snapshots (one row per (source, pubkey), a key
            // may be delegated by multiple sources); a two-branch comparator that
            // returns 1 for both orderings of an equal pair is inconsistent and
            // leaves relative order engine-defined, which can diverge the crc32
            // archive bytes that follower co-signers verify byte-for-byte.
            for(let v of set.slice().sort((a, b) => a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)))
                snaps.push({ snapshot_block: w.block, capability: w.capability,
                             signing_pubkey: v.pubkey, amount: v.amount,
                             source: String(v.source != null ? v.source : '') });
        }
        // `calls` and `rewards` are additive to the v1 archive shape: recovery
        // treats a missing key as an empty list, so older on-chain archives stay
        // parseable.
        let obj = {
            v: 1,
            network: network,
            batch_seq: batchSeq,
            matches: matches.map(m => StateAnchorPublisher.serializeMatch(m)),
            calls: calls.map(c => StateAnchorPublisher.serializeCall(c)),
            rewards: rewards.map(({row, source}) => StateAnchorPublisher.serializeReward(row, source)),
            capability_snapshots: snaps
        };
        return { json: JSON.stringify(obj), count: matches.length };
    }

    // Fixed-key-order match record (shared with the follower verifier + recovery).
    static serializeMatch(m){
        let out = {};
        for(let k of MATCH_KEYS){
            let v = m[k];
            if(k === 'id' || k === 'a_action_index' || k === 'b_action_index' || k === 'snapshot_block' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'finalizing_view')
                out[k] = Number(v) || 0;   // EQUIV VIEW; archived so recovery rebuilds the exact signed bytes
            else if(k === 'a_ownership' || k === 'b_ownership')
                out[k] = Number(v) ? 1 : 0;
            else if(k === 'a_tick' || k === 'b_tick')
                out[k] = (v == null) ? null : String(v);
            else if(k === 'a_payout_legs' || k === 'b_payout_legs'){
                // Omit-when-null: legs only exist at/above the CROSS_CHAIN_ROYALTY flag-day
                // (create-side deny below it), so legs-less archives stay byte-identical to
                // those built by pre-royalty hubs and recovery tolerates both shapes.
                if(v != null) out[k] = String(v);
            }
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    }

    // Fixed-key-order XCALL relay record (shared with the follower verifier +
    // recovery). result_status / return_payload_b64 are null on dispatch rows.
    static serializeCall(c){
        let out = {};
        for(let k of CALL_KEYS){
            let v = c[k];
            if(k === 'id' || k === 'snapshot_block' || k === 'source_action_index' || k === 'source_contract_index' ||
               k === 'target_contract_index' || k === 'gas_limit' || k === 'cross_hops' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'finalizing_view')
                out[k] = Number(v) || 0;   // EQUIV VIEW; archived so recovery rebuilds the exact signed bytes
            else if(k === 'result_status' || k === 'return_payload_b64')
                out[k] = (v == null) ? null : String(v);
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    }

    // Fixed-key-order anchor-publish reward record (shared with the follower
    // verifier + recovery). `source` is the earn-time staking address pinned by
    // the archive builder. Recovery restores rewards into the BTC indexer DB
    // BEFORE the reindex, so it cannot resolve sources itself, and a later
    // re-stake of the pubkey from a different address must not move the credit.
    static serializeReward(r, source){
        return {
            validator_pubkey: String(r.validator_pubkey).toLowerCase(),
            source:           String(source),
            round_number:     Number(r.round_number),
            reward_type:      String(r.reward_type),
            amount:           String(r.amount),
            block_index:      Number(r.block_index)
        };
    }

    // v1 archive canonical = the RAW v0 checkpoint content + the batch extension, then
    // (at/above the EQUIV flag-day) wrapped ONCE in the uniform header. The v1 ROUND_ID
    // appends `batch_seq` to the v0 round id so the v0 (per-block) and v1 (archive)
    // canonicals (which legitimately share checkpoint_seq) get DISTINCT equivocation
    // keys; otherwise an honest validator that signs both is falsely slashable (R-4 fix).
    // Nests _rawCanonicalCheckpoint (not canonicalCheckpoint) so the header lands outside.
    _archiveCanonical(cp, batchSeq, count, crc, totalChunks){
        let raw = StateCheckpointEngine._rawCanonicalCheckpoint(cp) + '|' +
                  String(batchSeq) + '|' + String(count) + '|' + crc + '|' + String(totalChunks);
        if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
                cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq + '|' + batchSeq, 0, raw);
        return raw;
    }

    _splitChunks(b64){
        let chunks = [];
        for(let i = 0; i < b64.length; i += this.chunkMaxBytes) chunks.push(b64.slice(i, i + this.chunkMaxBytes));
        return chunks.length ? chunks : [''];
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XANC_SIGN_REQ:  this._handleSignReq(envelope).catch(e => console.error('StateAnchorPublisher: SIGN_REQ error: ' + (e && e.message))); break;
            case XANC_SIGN:      this._handleSign(envelope).catch(e => console.error('StateAnchorPublisher: SIGN error: ' + (e && e.message)));        break;
            case XANC_FINALIZED: this._handleFinalized(envelope).catch(e => console.error('StateAnchorPublisher: FINALIZED error: ' + (e && e.message))); break;
            case XANC_V0_DONE:   this._handleV0Done(envelope).catch(e => console.error('StateAnchorPublisher: V0_DONE error: ' + (e && e.message)));     break;
            case XANCPUB_SIGN_REQ: this._handleAttestSignReq(envelope).catch(e => console.error('StateAnchorPublisher: XANCPUB_SIGN_REQ error: ' + (e && e.message))); break;
            case XANCPUB_SIGN:     this._handleAttestSign(envelope).catch(e => console.error('StateAnchorPublisher: XANCPUB_SIGN error: ' + (e && e.message)));         break;
        }
    }

    // Peer back-fill for a published v0 anchor. Gated on membership + signature +
    // the sender being the rank-unlocked ELECTED v0 publisher for the referenced
    // checkpoint (see the election re-derivation below); a non-elected member can
    // no longer suppress the anchor or mirror itself the reward. The residual
    // (a Byzantine elected publisher announcing a fake txid) needs on-chain txid
    // verification. First writer wins (IS NULL guard).
    async _handleV0Done(envelope){
        let d = envelope.data;
        if(!d || !d.chain || !d.txid) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(null);
        // Fail CLOSED on an empty set: d.sig_pubkey is self-asserted and the sig is
        // verified against it, so membership in the oracle_publish set is the ONLY
        // thing tying this announcement to a federation member. An empty set (startup /
        // registry hiccup) must reject, not admit anyone -- otherwise a forged V0_DONE
        // stamps a bogus anchor_txid (suppressing the real anchor) and mirrors rewards.
        if(pubkeys.length === 0 || !pubkeys.includes(sender)) return;
        if(!ValidatorIdentity.verify(this._v0DoneCanonical(d, String(d.txid)), String(d.sig || ''), sender)) return;
        // XANC-V0DONE-SUPPRESS-1 / XANC-REWARD-THEFT-1: membership + signature alone let ANY
        // oracle_publish member self-assert an anchor for a checkpoint it never published,
        // stamping a bogus anchor_txid (suppressing the real anchor fleet-wide via the
        // `anchor_txid IS NULL` selector) and mirroring itself the reward. Re-run the SAME v0
        // publisher election the real publisher ran (_publishPendingCheckpoints): resolve
        // oracle_publish at THIS checkpoint's snapshot_block and require the sender to be
        // rank-unlocked on the failover ladder. snapshot_block is read from our own
        // quorum-agreed checkpoint row (not the wire), so this needs NO signed-canonical
        // change. It rejects any NON-elected member; a Byzantine ELECTED publisher (a far
        // smaller surface, fully closed only by on-chain txid verification - open item) can
        // still self-suppress its own election share. Rejecting a V0_DONE only ever risks a
        // redundant re-anchor (benign, the direction the code already tolerates), never a
        // fork, so using the receiver's own BTC-tip view for rank-unlock is safe here (same
        // pattern as _handleSignReq).
        let ckptRows = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
            [String(d.chain), String(d.network), Number(d.block_index), Number(d.checkpoint_seq)]);
        if(!ckptRows || ckptRows.length === 0) return;   // no local copy of the referenced checkpoint: cannot vet the election
        let electionSet = await this._getActiveOraclePublishPubkeys(Number(ckptRows[0].snapshot_block));
        if(electionSet.length === 0) return;             // fail closed: unresolved election set
        {
            // Run the ladder check for EVERY set size. A size-1 set previously
            // skipped it, so any CURRENT oracle_publish member (even one that
            // joined after snapshot_block) could stamp the sole elected
            // publisher's on-chain anchor with a V0_DONE naming itself and,
            // pre-ANCHOR_REWARD flag-day, capture the mirrored reward.
            let order = StateAnchorPublisher.hashOrder(
                this._v0ElectionKey({ chain: d.chain, network: d.network, checkpoint_seq: d.checkpoint_seq, snapshot_block: Number(ckptRows[0].snapshot_block) }),
                electionSet);
            let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
            let since = Number.isFinite(myBtc) ? myBtc - Number(ckptRows[0].snapshot_block) : null;
            if(!this._rankUnlocked(order, sender, since)) return;   // sender is not a rank-unlocked elected publisher
        }
        // XANC-V0DONE-SUPPRESS-1 / XANC-ELECTED-FORGE-1 (v0 half): the election gate
        // above proves the SENDER is an elected v0 publisher, NOT that it ever
        // published this anchor. A Byzantine ELECTED publisher can still announce a
        // phantom/never-mined txid, stamping a bogus anchor_txid (suppressing the real
        // anchor via the `anchor_txid IS NULL` selector) and mirroring itself the
        // reward. Confirm the anchor is really on DOGE at >= XCHAIN_CONFIRMATIONS_DOGE
        // depth by asking OUR OWN DOGE indexer for the DECODED anchor_actions row for
        // THIS checkpoint (payload hashes must byte-match our own copy). ABSTAIN (skip
        // stamp+reward, the benign redundant-re-anchor direction this handler already
        // tolerates) when the DOGE indexer is unwired/unreachable or the anchor is
        // absent/shallow; REJECT on a decoded-invalid status or a hash mismatch. The
        // failover ladder unlocks at ~electionToleranceBlocks BTC blocks per rank
        // (hours), far slower than the ~60-conf DOGE window, so waiting for depth does
        // not open a practical double-anchor race.
        //
        // d.txid is bound into the signed _v0DoneCanonical, so binding it here closes
        // the v0 half of XANC-ELECTED-FORGE-1: an ELECTED publisher announcing a
        // never-mined txid, or pointing at a real anchor for a DIFFERENT checkpoint,
        // no longer stamps (the phantom stamp is what suppresses the real anchor via
        // the `anchor_txid IS NULL` selector).
        let vOnChain = await this._verifyAnchorOnChain(ckptRows[0], { txid: String(d.txid), rejectVersions: [1, 2] });
        if(vOnChain !== 'verified'){
            console.warn('StateAnchorPublisher: V0_DONE for ' + d.chain + '/' + d.network + ' @ ' +
                         d.block_index + '/' + d.checkpoint_seq + ' NOT on-chain verified (' + vOnChain +
                         '); skipping stamp + reward');
            return;
        }
        // Key the stamp on checkpoint_seq exactly as the publisher's own stamp does:
        // checkpoint_seq is part of the signed _v0DoneCanonical, so binding it here
        // stops one V0_DONE from marking a DIFFERENT (or multiple) seq row(s) at the
        // same height.
        await this.db.doQuery(
            'UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid IS NULL',
            [String(d.txid), String(d.chain), String(d.network), Number(d.block_index), Number(d.checkpoint_seq)]);
        // Mirror the publisher's anchor reward locally (sender is signature-
        // verified above) so every hub holds the same reward rows and any of
        // them can archive/verify the rewards section. The snapshot_block comes
        // from OUR copy of the checkpoint row (quorum-agreed state, identical
        // on every hub).
        // Mirror against the EXACT announced+verified checkpoint (ckptRows[0], keyed on
        // d.checkpoint_seq above), NOT the latest seq at this height. When a reorg leaves
        // more than one checkpoint_seq at the same block_index with different
        // snapshot_blocks, the latest-seq row's snapshot_block diverges from the seq the
        // publisher actually anchored + recorded its reward under, forking peer reward rows
        // from the publisher's (a live-vs-recovered COLLECT-ledger fork).
        let cps = [{ snapshot_block: ckptRows[0].snapshot_block }];
        // At/above the anchor-reward flag-day the per-chain reward is indexer-
        // DERIVED from the on-chain v4/v5 attestation. V0_DONE does not say (and
        // its signed canonical does not bind) WHICH payload version landed, so a
        // mirror here could mint a reward for a degraded legacy v0/v3 fallback
        // that no live indexer credits (a stranded archive-only credit; the
        // live-vs-recovered fork). Skip the mirror at/above the flag-day: the
        // attested publisher records its own row (the archive transport), and
        // live + recovering indexers both derive the credit from the on-chain
        // attestation. Below the flag-day the mirror remains the only transport.
        if(cps && cps.length > 0 && !ar.isAnchorRewardActive(Number(cps[0].snapshot_block), String(d.network)))
            this._recordReward('anchor_' + String(d.chain), Number(d.checkpoint_seq), sender, Number(cps[0].snapshot_block));
    }

    _v0DoneCanonical(row, txid){
        return 'XANCV0DONE|' + row.chain + '|' + row.network + '|' + String(row.block_index) + '|' +
               String(row.checkpoint_seq) + '|' + String(txid || '');
    }

    // On-chain ANCHOR verification (XANC-ELECTED-FORGE-1 / XANC-V0DONE-SUPPRESS-1
    // residual). A peer's V0_DONE / FINALIZED announcement is authenticated (signed
    // by an elected sender) but its txid is SELF-ASSERTED: an elected-yet-Byzantine
    // publisher can announce a checkpoint it never actually anchored on DOGE,
    // suppressing the real anchor (bogus anchor_txid stamp) or minting itself a
    // reward. Confirm the anchor really landed by asking OUR OWN DOGE indexer for
    // the DECODED anchor_actions row for this checkpoint. `cp` is a raw
    // state_checkpoints row (our own quorum-agreed copy); its hashes are the bind.
    //
    // Returns the string 'verified' ONLY when the on-chain row exists, is not a
    // decoded-invalid, is buried >= XCHAIN_CONFIRMATIONS_DOGE deep, and its payload
    // hashes byte-match our checkpoint. Every other outcome returns a short reason
    // the caller treats as ABSTAIN (skip stamp+reward): 'no-indexer' (a hub with no
    // DOGE indexer wired fails closed, i.e. skips the receiver stamp+reward; wire
    // DOGE_INDEXER_URL fleet-wide before deploy), 'unreachable',
    // 'absent', 'shallow' are the benign redundant-re-anchor direction the receiver
    // paths already tolerate; 'rejected:status' / 'rejected:mismatch' /
    // 'rejected:txid' / 'rejected:version' are a positively-detected forge.
    //
    // `expect` BINDS the announcement to a specific on-chain transaction:
    //   expect.txid    - the txid the peer announced (signed into the V0_DONE /
    //                    FINALIZED canonical), so an elected-but-Byzantine publisher
    //                    cannot point at a real-but-different anchor, nor at a
    //                    never-mined one (XANC-ELECTED-FORGE-1).
    //   expect.version - narrows to a specific ANCHOR version (the archive gate binds
    //                    the v1 head), since one checkpoint_seq carries both the v0/v3
    //                    checkpoint anchor and the v1 archive anchor.
    //   expect.rejectVersions - a set of ANCHOR versions to REJECT when no single
    //                    exact version is expected (the V0_DONE checkpoint path passes
    //                    {1,2} so an archive anchor cannot pose as a checkpoint anchor).
    // Without `expect` this only proves "this checkpoint is anchored at depth".
    //
    // FAIL CLOSED against an un-upgraded indexer: one that predates the txid filter
    // silently ignores the param and returns no `txid`, so a caller that asked to bind
    // a txid gets 'no-txid-support' (ABSTAIN) rather than a false 'verified'. Roll the
    // DOGE indexers before the hubs.
    async _verifyAnchorOnChain(cp, expect){
        if(!cp) return 'no-checkpoint';
        let ix = this.indexers && this.indexers.DOGE;
        if(!ix || !ix.url) return 'no-indexer';
        let want = expect || {};
        let wantTxid = want.txid ? String(want.txid).toLowerCase() : null;
        let res;
        try {
            let params = {
                chain: String(cp.chain), network: String(cp.network),
                block_index: Number(cp.block_index), checkpoint_seq: Number(cp.checkpoint_seq)
            };
            if(wantTxid)                 params.txid    = wantTxid;
            if(want.version != null)     params.version = Number(want.version);
            res = await this._indexerCall('DOGE', 'getanchoraction', params);
        } catch(e){
            console.warn('StateAnchorPublisher: getanchoraction unreachable for ' + cp.chain + '/' + cp.network +
                         ' @ ' + cp.block_index + '/' + cp.checkpoint_seq + ': ' + (e && e.message));
            return 'unreachable';
        }
        if(!res || !res.exists){
            // The filtered lookup found nothing. `checkpoint_anchored` says whether ANY
            // anchor exists for this checkpoint: if one does, the announced txid is a
            // forge (the checkpoint is anchored, just not by that tx). If none does, the
            // checkpoint simply is not anchored yet, which is the benign direction.
            if(wantTxid && res && res.checkpoint_anchored) return 'rejected:txid';
            return 'absent';
        }
        if(/^invalid/i.test(String(res.status || ''))) return 'rejected:status';
        if(!(Number(res.confirmations) >= this.dogeConfirmations)) return 'shallow';
        // Re-check the binding client-side. The indexer already filtered, so this only
        // fires against an indexer that ignored the filter (pre-upgrade) or answered
        // inconsistently; either way we must not trust an unbound row.
        if(wantTxid){
            if(!res.txid) return 'no-txid-support';
            if(String(res.txid).toLowerCase() !== wantTxid) return 'rejected:txid';
        }
        if(want.version != null && Number(res.version) !== Number(want.version)) return 'rejected:version';
        // Reject a disallowed version even when no single exact version is
        // expected. The V0_DONE path accepts any CHECKPOINT-anchor version
        // ({0,3,4,5}) but must not accept an ARCHIVE anchor ({1,2}): one
        // checkpoint_seq carries both, and the 4-core-hash byte-match below
        // passes for a v1 archive whose wrapper is this same checkpoint, so
        // without this a Byzantine v0 publisher could name a confirmed v1
        // archive txid as proof of a v0 anchor (stamping the row fleet-wide and
        // mirroring a reward it never earned).
        if(Array.isArray(want.rejectVersions) &&
           want.rejectVersions.map(Number).includes(Number(res.version))) return 'rejected:version';
        // Byte-match the decoded on-chain payload against our own checkpoint. The
        // four core hashes are present on every checkpoint version; state_root and
        // block_merkle_root are compared only when the on-chain anchor is a
        // root-bearing version (v3/v5), matching the payload the publisher signed.
        if(!this._anchorHashEq(res.block_hash,    cp.block_hash)    ||
           !this._anchorHashEq(res.ledger_hash,   cp.ledger_hash)   ||
           !this._anchorHashEq(res.actions_hash,  cp.actions_hash)  ||
           !this._anchorHashEq(res.contract_hash, cp.contract_hash)) return 'rejected:mismatch';
        if(Number(res.version) === 3 || Number(res.version) === 5){
            if(!this._anchorHashEq(res.state_root,        cp.state_root) ||
               !this._anchorHashEq(res.block_merkle_root, cp.block_merkle_root)) return 'rejected:mismatch';
        }
        return 'verified';
    }

    // Null-safe hex-hash equality for the on-chain payload byte-match. Both
    // null/empty compare equal (a version that legitimately carries no such hash);
    // a one-sided null is a mismatch. Case-insensitive: hex hashes may differ only
    // in case between the decoder's serialization and ours.
    _anchorHashEq(a, b){
        let na = (a == null || a === '') ? null : String(a).toLowerCase();
        let nb = (b == null || b === '') ? null : String(b).toLowerCase();
        return na === nb;
    }

    // JSON-RPC to a per-coin indexer (byte-identical to the ReorgHandler /
    // CrossChainCallEngine helper). The hub attaches its x-api-key; getanchoraction
    // is a FEDERATION_READ_METHOD on the indexer.
    async _indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    // Follower: co-sign ONLY an archive that byte-matches our own DB state.
    async _handleSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d || !d.checkpoint) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;

        let cp = d.checkpoint;
        // The publisher is elected by the CURRENT BTC block (not the checkpoint's
        // possibly hours-old snapshot_block). The REQ carries its election block;
        // we verify the SENDER's rank against it, bounded to our own view of the
        // BTC tip (anti-spam; the security property is the DB byte-match below).
        let electionBlock = Number(d.election_block);
        if(!Number.isFinite(electionBlock)) return;
        let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(Number.isFinite(myBtc) && Math.abs(myBtc - electionBlock) > this.electionToleranceBlocks) return;
        let electionPubkeys = await this._getActiveOraclePublishPubkeys(electionBlock);
        if(electionPubkeys.length > 0){
            // Same content-anchored key + failover ladder the leader used.
            // Accept any sender whose rank has unlocked, not just rank 0, or a
            // signer-less rank-0 hub stalls archiving federation-wide.
            // Runs for a single-member set too (previously skipped), so the
            // sole elected leader cannot be impersonated by a non-member;
            // the empty-set (unresolvable election) path keeps its existing
            // behavior of deferring to the DB byte-match below.
            let order = StateAnchorPublisher.hashOrder(this._archiveElectionKey(cp, Number(d.batch_seq)), electionPubkeys);
            let since = electionBlock - Number(cp.snapshot_block);
            if(!this._rankUnlocked(order, sender, since)) return;            // not unlocked on the failover ladder
        }
        // The sender has validated as the (rank-unlocked) elected archive leader
        // for this batch_seq at election_block. Bind it locally BEFORE the
        // snapshot-set co-sign check below, so an election-set member that will
        // NOT co-sign (present only at election_block, not at snapshot_block) can
        // still authenticate this leader's later XANC_FINALIZED and back-fill.
        if(electionPubkeys.includes(sender))
            this._recordObservedArchiveLeader(Number(d.batch_seq), sender, cp);
        // MY co-sign eligibility, by contrast, is gated on the snapshot_block
        // SIGNING set: the indexer + recovery only count a wrapper signature whose
        // signer holds oracle_publish AT snapshot_block, so a follower present only
        // in the current election set would contribute a signature that is dropped
        // on-chain and could drag an otherwise-valid archive below quorum.
        let signingPubkeys = await this._getActiveOraclePublishPubkeys(Number(cp.snapshot_block));
        if(!signingPubkeys.includes(myPubkey)) return;

        let canonical = this._archiveCanonical(cp, Number(d.batch_seq), Number(d.match_count),
                                               String(d.batch_crc32), Number(d.total_chunks));
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;

        // 1. The checkpoint wrapper must equal OUR state_checkpoints row (latest
        // seq for the height; a reorg-superseded row never co-signs an archive).
        let local = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? ORDER BY checkpoint_seq DESC LIMIT 1',
            [cp.chain, cp.network, Number(cp.block_index)]);
        if(!local || local.length === 0) return;
        let mine = this._cpFromRow(local[0]);
        if(StateCheckpointEngine.canonicalCheckpoint(mine) !== StateCheckpointEngine.canonicalCheckpoint(cp)) return;

        // 2. The archive must decompress, CRC-match, and byte-match our own rows.
        let json;
        // Bounded decompress: the archive is attacker-supplied bytes decompressed
        // BEFORE any CRC/quorum check, so an unbounded gunzip is a gzip-bomb DoS.
        // Mirror the committed indexer cap (anchor.js / recovery.js, 16 MiB).
        try { json = zlib.gunzipSync(Buffer.from(String(d.archive_b64), 'base64url'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'); }
        catch(e){ return; }
        if(this._crc32Hex(json) !== String(d.batch_crc32)) return;
        let archive;
        try { archive = JSON.parse(json); } catch(e){ return; }
        if(!archive || !Array.isArray(archive.matches) || archive.matches.length !== Number(d.match_count)) return;
        if(!(await this._verifyArchiveAgainstLocal(archive))){
            console.warn('StateAnchorPublisher: proposed archive (batch ' + d.batch_seq + ') diverges from our DB; NOT signing');
            return;
        }

        this.peerManager.broadcast(XANC_SIGN, {
            batch_seq: Number(d.batch_seq), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    // Every archived match's TERMS must byte-equal our own cross_chain_matches
    // row (every hub writes finalized matches, so the local DB is authoritative).
    // validator_signatures is EXCLUDED from the byte-comparison (each hub stores
    // its own collected sig set; membership/order differ per node) and instead
    // verified CRYPTOGRAPHICALLY: the archived sigs must reach 2f+1 of OUR OWN
    // resolved cross_chain set over the XMATCH canonical (strictly stronger than
    // comparing local copies). Capability sets must exactly equal our own
    // resolution (set equality, not subset, so a leader can neither inject a
    // fake validator nor omit a real one).
    async _verifyArchiveAgainstLocal(archive){
        for(let am of archive.matches){
            let rows = await this.db.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [am.match_id]);
            if(rows && rows.length > 0){
                let localTerms    = StateAnchorPublisher.serializeMatch(rows[0]);
                let archivedTerms = Object.assign({}, am);
                // id is per-hub bookkeeping (each hub assigns its own AUTO_INCREMENT
                // cursor); the leader archives ITS id as provenance only (ordering
                // is (snapshot_block, match_id)/(snapshot_block, call_id)), so
                // followers must not byte-compare it, like validator_signatures.
                delete localTerms.id;
                delete archivedTerms.id;
                delete localTerms.validator_signatures;
                delete archivedTerms.validator_signatures;
                if(JSON.stringify(localTerms) !== JSON.stringify(archivedTerms)){
                    console.warn("StateAnchorPublisher: archive match " + String(am.match_id).substring(0, 16) +
                                 "... TERMS differ from our row; local " + JSON.stringify(localTerms).substring(0, 120) +
                                 " vs archived " + JSON.stringify(archivedTerms).substring(0, 120));
                    return false;
                }
            } else {
                // A row we never wrote: it predates this hub joining the
                // federation (a late joiner has no copy of earlier history).
                // The cryptographic bar below (archived sigs reaching 2f+1 of
                // OUR OWN resolved cross_chain set at the row's snapshot_block)
                // is the same proof full-parse recovery accepts, so absence is
                // not divergence. A forged row cannot carry those signatures.
                console.log('StateAnchorPublisher: archive match ' + String(am.match_id).substring(0, 16) +
                            '... predates our local history; accepting on signature quorum alone');
            }

            let set  = await this._resolveCapabilitySet('cross_chain', Number(am.snapshot_block));
            let sigs = this._parseSigs(am.validator_signatures);
            if(!this._quorumVerified(this._matchCanonical(am), sigs, set, swq.isStakeWeightedQuorumActive(Number(am.snapshot_block), this.network))){
                console.warn('StateAnchorPublisher: archive match ' + String(am.match_id).substring(0, 16) +
                             '... fails signature quorum against the cross_chain set at block ' + am.snapshot_block);
                return false;
            }
        }
        for(let ac of (archive.calls || [])){
            let rows = await this.db.doQuery(
                'SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ? LIMIT 1', [ac.call_id, ac.phase]);
            if(rows && rows.length > 0){
                let localTerms    = StateAnchorPublisher.serializeCall(rows[0]);
                let archivedTerms = Object.assign({}, ac);
                delete localTerms.id;                       // per-hub cursor; see the match loop
                delete archivedTerms.id;
                delete localTerms.validator_signatures;
                delete archivedTerms.validator_signatures;
                if(JSON.stringify(localTerms) !== JSON.stringify(archivedTerms)){
                    console.warn("StateAnchorPublisher: archive call " + String(ac.call_id).substring(0, 16) +
                                 "... (" + ac.phase + ") TERMS differ from our row; local " + JSON.stringify(localTerms).substring(0, 160) +
                                 " vs archived " + JSON.stringify(archivedTerms).substring(0, 160));
                    return false;
                }
            } else {
                console.log('StateAnchorPublisher: archive call ' + String(ac.call_id).substring(0, 16) +
                            '... (' + ac.phase + ') predates our local history; accepting on signature quorum alone');
            }

            let set  = await this._resolveCapabilitySet('cross_chain', Number(ac.snapshot_block));
            let sigs = this._parseSigs(ac.validator_signatures);
            if(!this._quorumVerified(this._callCanonical(ac), sigs, set, swq.isStakeWeightedQuorumActive(Number(ac.snapshot_block), this.network))){
                console.warn('StateAnchorPublisher: archive call ' + String(ac.call_id).substring(0, 16) +
                             '... (' + ac.phase + ') fails signature quorum against the cross_chain set at block ' + ac.snapshot_block);
                return false;
            }
        }
        // Reward rows carry no per-row signatures (they are unilateral local
        // writes), so they verify by RE-DERIVATION: every field must equal what
        // this hub derives independently:
        //   type:      anchor publish rails only; oracle_round/attest_fee are
        //              indexer-derived and must never ride the archive
        //   pubkey:    member of OUR oracle_publish set at the earn block
        //   amount:    exactly OUR configured publish reward
        //   source:    OUR own block-scoped indexer resolution
        //   local row: if we hold (type, round), it must agree (a leader
        //              crediting itself for another hub's publish diverges
        //              here on every hub that saw the real announcement);
        //              absence alone is tolerated (late joiner), the
        //              re-derivation above still bounds what it can say.
        // Loop var is `rr` (reward row), NOT `ar`: the module import `ar`
        // (anchor_reward_activation) is referenced below for the frozen-amount gate.
        for(let rr of (archive.rewards || [])){
            let tag = (rr && rr.reward_type) + '/#' + (rr && rr.round_number);
            if(!rr || !/^anchor_[A-Za-z_]+$/.test(String(rr.reward_type || ''))){
                console.warn('StateAnchorPublisher: archive reward ' + tag + ' has a non-anchor reward_type; NOT signing');
                return false;
            }
            let pubkey = String(rr.validator_pubkey || '').toLowerCase();
            let set = await this._resolveCapabilitySet('oracle_publish', Number(rr.block_index));
            if(!set.some(v => v.pubkey === pubkey)){
                console.warn('StateAnchorPublisher: archive reward ' + tag + ' pubkey ' + pubkey.substring(0, 12) +
                             '... is not in the oracle_publish set at block ' + rr.block_index + '; NOT signing');
                return false;
            }
            // #5311: a derived per-chain reward (at/above the ANCHOR_REWARD flag-day) carries the
            // FROZEN consensus amount that every indexer credits and recovery restores; below the
            // flag-day and for anchor_archive the legacy operator-configured amount stands. Mirrors
            // RewardTracker.recordAnchorReward so a leader's own archived rows verify here.
            let isDerived = /^anchor_(BTC|LTC|DOGE)$/.test(String(rr.reward_type || '')) &&
                            ar.isAnchorRewardActive(Number(rr.block_index), this.network);
            let expectedAmount = isDerived
                ? ar.ANCHOR_REWARD_AMOUNT
                : (this.hub.rewardTracker ? parseFloat(this.hub.rewardTracker.anchorReward).toFixed(8) : null);
            if(expectedAmount !== null && String(rr.amount) !== expectedAmount){
                console.warn('StateAnchorPublisher: archive reward ' + tag + ' amount ' + rr.amount +
                             ' != expected ' + expectedAmount + '; NOT signing');
                return false;
            }
            let mySource = this.hub.rewardTracker
                ? await this.hub.rewardTracker.resolveSourceByPubkey(pubkey, Number(rr.block_index))
                : null;
            if(!mySource || String(rr.source) !== mySource){
                console.warn('StateAnchorPublisher: archive reward ' + tag + ' source ' + rr.source +
                             ' does not match our resolution (' + mySource + '); NOT signing');
                return false;
            }
            // Cross-check against ALL our own local rows for this (reward_type,
            // round_number). Reward rows are written independently by every hub
            // from the same on-chain anchor-publish events, so an honest hub that
            // saw this round derives the SAME winner set. The table's UNIQUE key
            // is (validator_pubkey, round_number, reward_type), so two pubkeys can
            // legitimately co-exist for one (reward_type, round_number) under a
            // transient failover double-publish: querying ALL rows tolerates that
            // window (the archived pubkey's own row is matched and verified) while
            // still rejecting a leader that credits a pubkey we never derived.
            //   - a row for the archived pubkey  -> amount/block must agree
            //   - rows exist but none is ours     -> divergence: this hub saw the
            //                                        round and credited a DIFFERENT
            //                                        winner, so the archived pubkey
            //                                        is a misattributed/inflated
            //                                        credit -> NOT signing
            //   - no rows at all                  -> late joiner; re-derivation
            //                                        above already bounds it
            let local = await this.db.doQuery(
                'SELECT validator_pubkey, amount, block_index FROM validator_rewards WHERE reward_type = ? AND round_number = ?',
                [String(rr.reward_type), Number(rr.round_number)]);
            if(local && local.length > 0){
                let mine = local.find(r => String(r.validator_pubkey).toLowerCase() === pubkey);
                if(!mine){
                    console.warn('StateAnchorPublisher: archive reward ' + tag + ' credits ' + pubkey.substring(0, 12) +
                                 '... but our local rows for this round credit ' +
                                 local.map(r => String(r.validator_pubkey).substring(0, 12) + '...').join(',') +
                                 '; NOT signing');
                    return false;
                }
                if(String(mine.amount) !== String(rr.amount) ||
                   (mine.block_index != null && Number(mine.block_index) !== Number(rr.block_index))){
                    console.warn('StateAnchorPublisher: archive reward ' + tag + ' diverges from our row (' +
                                 String(mine.validator_pubkey).substring(0, 12) + '.../' + mine.amount + '/' + mine.block_index +
                                 ' vs ' + pubkey.substring(0, 12) + '.../' + rr.amount + '/' + rr.block_index + '); NOT signing');
                    return false;
                }
            } else {
                console.log('StateAnchorPublisher: archive reward ' + tag + ' predates our local history; accepting on re-derivation alone');
            }
        }
        let groups = new Map();              // block|capability -> Map<pubkey, {amount, source}>
        for(let s of (archive.capability_snapshots || [])){
            let key = Number(s.snapshot_block) + '|' + String(s.capability);
            if(!groups.has(key)) groups.set(key, new Map());
            groups.get(key).set(String(s.signing_pubkey).toLowerCase(),
                                { amount: String(s.amount), source: String(s.source != null ? s.source : '') });
        }
        for(let [key, archived] of groups){
            let [block, capability] = key.split('|');
            let resolved = await this._resolveCapabilitySet(capability, Number(block));
            if(resolved.length !== archived.size){
                console.warn("StateAnchorPublisher: archive snapshot group " + key + " size " + archived.size +
                             " differs from our resolution (" + resolved.length + ")");
                return false;
            }
            for(let v of resolved){
                let a = archived.get(v.pubkey);
                let vSource = String(v.source != null ? v.source : '');
                if(!a || a.amount !== v.amount || a.source !== vSource){
                    console.warn("StateAnchorPublisher: archive snapshot group " + key + " diverges for pubkey " +
                                 v.pubkey.substring(0, 12) + "... (local amount/source " + v.amount + "/" + vSource +
                                 ", archived " + (a ? (a.amount + "/" + a.source) : "<absent>") + ")");
                    return false;
                }
            }
        }
        return true;
    }

    async _handleSign(envelope){
        let d = envelope.data;
        let round = this._archiveRound;
        if(!round || round.done || Number(d.batch_seq) !== round.batchSeq) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        await this._checkArchiveQuorum();
    }

    async _checkArchiveQuorum(){
        let round = this._archiveRound;
        if(!round || round.done) return;
        // STAKE_WEIGHTED_QUORUM: fire on distinct-source signer stake > 2/3 of the
        // snapshot when weighted, else legacy signature count. Matches the indexer
        // anchor.js / recovery verdict so the publisher never dequeues a batch the
        // chain then rejects (or stalls a stake-met-but-count-short batch).
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._archiveRound = null;
        await this._publishArchive(round);
        this._pendingMatches = 0;
    }

    async _publishArchive(round){
        let sigs = [];
        for(let [pk, sg] of round.signatures) sigs.push({ pubkey: pk, sig: sg });

        let cp = round.cp;
        let parts = ['ANCHOR', '1', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                     cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                     String(cp.checkpoint_seq), String(cp.snapshot_block),
                     String(round.batchSeq), String(round.count), round.crc,
                     String(round.chunks.length), round.chunks[0], String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        let v1Payload = parts.join('|');

        let broadcaster = round.signer.broadcastFn || ((p) => this._defaultBroadcast(p, round.signer));
        let result = await this._broadcastWithRetry(broadcaster, v1Payload);
        let txid = result && result.txid ? result.txid : null;

        let lostChunks = 0;
        for(let i = 1; i < round.chunks.length; i++){
            let v2Payload = ['ANCHOR', '2', String(round.batchSeq), String(i), String(round.chunks.length), round.chunks[i]].join('|');
            // A lost chunk is a durability failure (recovery needs every chunk),
            // so the shared anchor-broadcast retry matters most here.
            try { await this._broadcastWithRetry(broadcaster, v2Payload); }
            catch(e){
                lostChunks++;
                this._archiveChunkLosses++;
                console.error('StateAnchorPublisher: v2 chunk ' + i + ' broadcast failed after retries: ' + (e && e.message));
            }
        }

        // On-chain VALIDITY gate: the source rows are only safe to DEQUEUE if the
        // v1 we just broadcast will pass the indexer's own check. Its wrapper
        // signatures must reach quorum over oracle_publish @ snapshot_block, the
        // SAME set + threshold the indexer (anchor.js) and full-parse recovery
        // verify against. If they don't (e.g. a validator-set drift the signing
        // round could not satisfy), the on-chain v1 is stored `invalid`; dequeuing
        // the rows anyway would strand settled cross_chain_matches/calls in an
        // unrecoverable hole. Treat it exactly like a lost chunk: keep the rows
        // pending so a later round re-archives them under a fresh batch seq. The
        // single-node / unresolvable-set degenerate (validators.length <= 1) keeps
        // today's behavior (the indexer stores those as recoverable 'unverified').
        let onChainValid = (round.validators.length <= 1) ||
                           this._quorumVerified(round.canonical, sigs, round.validators, round.weighted);

        // A partially-published archive is unrecoverable (recovery refuses
        // incomplete batches), so the rows must NOT be marked archived. Back-fill
        // with a sentinel archived_status instead: batch_seq still advances (a
        // re-archive must get a FRESH seq; two v1 anchors sharing one seq would
        // corrupt chunk reassembly) while `archived_status <> status` keeps every
        // row eligible, so the next flush re-archives the whole batch.
        // A null txid is a false/incomplete broadcast success (_defaultBroadcast falls
        // back to { txid: null }); the v1 never landed on-chain, so dequeuing the rows
        // with their final status would strand them in an unrecoverable hole and the
        // archive reward would be credited for an anchor that was never published. Treat
        // it exactly like a lost chunk: keep the rows pending under a fresh batch seq.
        // (Mirrors the v0 null-txid guard in _publishPendingCheckpoints.)
        let noTxid = !txid;
        let matchIds = round.matchIds, callIds = round.callIds || [], rewardIds = round.rewardIds || [];
        if(lostChunks > 0 || !onChainValid || noTxid){
            matchIds  = matchIds.map(m => Object.assign({}, m, { status: '__partial__' }));
            callIds   = callIds.map(c => Object.assign({}, c, { status: '__partial__' }));
            rewardIds = [];                  // reward rows stay pending (batch_seq NULL) and re-archive
            if(lostChunks > 0)
                console.error('StateAnchorPublisher: batch ' + round.batchSeq + ' lost ' + lostChunks +
                              ' chunk(s) on-chain; rows stay pending and re-archive under a new batch seq' +
                              ' (cumulative chunk losses: ' + this._archiveChunkLosses + ')');
            if(!onChainValid)
                console.error('StateAnchorPublisher: batch ' + round.batchSeq + ' archive will NOT reach quorum over ' +
                              'oracle_publish @ snapshot_block ' + round.cp.snapshot_block + '; on-chain v1 would be ' +
                              'invalid, rows stay pending and re-archive under a new batch seq');
            if(noTxid)
                console.error('StateAnchorPublisher: batch ' + round.batchSeq + ' archive v1 broadcast returned no ' +
                              'txid; rows stay pending and re-archive under a new batch seq');
        }
        await this._backfillBatch(round.batchSeq, matchIds, txid, callIds, rewardIds);
        if(this.peerManager){
            this.peerManager.broadcast(XANC_FINALIZED, {
                batch_seq: round.batchSeq, txid: txid, matches: matchIds,
                calls: callIds,
                rewards: rewardIds,
                snapshot_block: Number(round.cp.snapshot_block),
                sig_pubkey: this.identity.getPubkeyHex().toLowerCase(),
                sig: this.identity.sign(this._finalizedCanonical(round.batchSeq, txid, matchIds.length))
            });
        }
        if(lostChunks === 0 && onChainValid && !noTxid){
            console.log('StateAnchorPublisher: archived ' + round.count + ' matches + ' +
                        ((round.callIds && round.callIds.length) || 0) + ' calls + ' +
                        ((round.rewardIds && round.rewardIds.length) || 0) + ' rewards (batch ' + round.batchSeq +
                        ', ' + round.chunks.length + ' chunk(s), txid ' + txid + ')');
            this._recordReward('anchor_archive', round.batchSeq,
                               this.identity ? this.identity.getPubkeyHex() : null,
                               Number(round.cp.snapshot_block));
        }
    }

    // Back-fills batch metadata from the archive leader so a rotated leader doesn't re-archive.
    async _handleFinalized(envelope){
        let d = envelope.data;
        if(!d || !Array.isArray(d.matches)) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(null);
        // Fail CLOSED on an empty set (see _handleV0Done): membership is the only tie
        // to a federation member, so an empty set must reject. Otherwise a forged
        // FINALIZED backfills real matches as archived and strands them for recovery.
        if(pubkeys.length === 0 || !pubkeys.includes(sender)) return;
        if(!ValidatorIdentity.verify(this._finalizedCanonical(Number(d.batch_seq), d.txid, d.matches.length),
                                     String(d.sig || ''), sender)) return;
        // Authenticate the FINALIZED sender as an archive leader we actually
        // observed getting elected for THIS batch_seq (via _handleSignReq). The
        // archive election is keyed on election_block, which the FINALIZED
        // canonical does NOT carry, so membership + signature alone let ANY
        // oracle_publish member forge a FINALIZED that (a) marks settled rows
        // archived under a bogus batch_seq -> stranded from full-parse recovery
        // (XANC-FINALIZED-STRAND-1), and (b) mirrors the anchor_archive reward
        // crediting itself -> mints COLLECT-spendable XCHAIN, since the archive
        // reward push is NOT retired by the anchor-reward flag-day (RewardTracker
        // only derives anchor_<CHAIN> on-chain; anchor_archive still pushes). Fail
        // closed on an un-observed round: back-fill is local bookkeeping the rows
        // re-archive under a fresh seq if missed, and the elected leader records
        // its own reward directly (co-signers' mirrors are redundant, INSERT
        // IGNORE-deduped). A Byzantine ELECTED leader announcing a never-published
        // txid is the residual, closable only by on-chain DOGE txid verification.
        if(!this._isObservedArchiveLeader(Number(d.batch_seq), sender)) return;
        // XANC-FINALIZED-CONTENT-1: the signed canonical binds only (batch_seq,
        // txid, match COUNT); the match/call/reward id+status lists are UNSIGNED
        // wire fields. The observed-leader gate above bounds WHO may send this,
        // not WHAT it says: a Byzantine ELECTED leader could otherwise stamp
        // arbitrary local rows archived with attacker-chosen statuses, stranding
        // them from every future archive round. Re-verify the announced content
        // against OUR OWN rows before stamping (receiver-side only, no
        // wire-format change; same authority argument as _verifyArchiveAgainstLocal:
        // every hub writes finalized rows, so the local DB is authoritative).
        // Rejecting is always safe: back-fill is local bookkeeping and missed
        // rows simply re-archive under a fresh batch seq.
        let calls   = Array.isArray(d.calls)   ? d.calls   : [];
        let rewards = Array.isArray(d.rewards) ? d.rewards : [];
        if(!(await this._verifyFinalizedAgainstLocal(d.matches, calls, rewards))){
            console.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') announces content ' +
                         'diverging from our DB; ignoring back-fill (rows re-archive under a fresh seq)');
            return;
        }
        await this._backfillBatch(Number(d.batch_seq), d.matches, d.txid ? String(d.txid) : null,
                                  calls, rewards);
        // Mirror the leader's archive-publish reward (sender is signature-
        // verified) so all hubs hold the same reward rows (same rail as the
        // V0_DONE mirror). Only a COMPLETE publish earns it (the leader skips
        // its own reward on lost chunks and marks rows __partial__).
        let partial = (d.matches || []).some(m => m && m.status === '__partial__') ||
                      calls.some(c => c && c.status === '__partial__');
        if(d.txid && !partial && Number.isFinite(Number(d.snapshot_block))){
            // d.snapshot_block is an unsigned wire field used as the mirrored
            // reward's block-scoped source-resolution key. Bound it by the same
            // re-derivation _verifyArchiveAgainstLocal applies to archived reward
            // rows: the credited pubkey must hold oracle_publish AT that block
            // (a fabricated block index fails the membership resolution).
            let setAtSnap = await this._getActiveOraclePublishPubkeys(Number(d.snapshot_block));
            if(!setAtSnap.includes(sender)){
                console.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') sender not in the ' +
                             'oracle_publish set at announced snapshot_block ' + d.snapshot_block +
                             '; NOT mirroring the archive reward');
            } else {
                // XANC-REWARD-THEFT-1 (archive half, LIVE): anchor_archive is NOT
                // retired by the anchor-reward flag-day (RewardTracker only derives
                // anchor_<CHAIN>), so a forged mirror mints COLLECT-spendable XCHAIN
                // TODAY. Gate the mirror on the batch's checkpoint being really
                // anchored on DOGE at depth: an elected-yet-Byzantine leader that
                // announces a FINALIZED for an archive it never published earns
                // nothing. ABSTAIN (no mirror) on an unverifiable / absent / shallow
                // anchor - the elected leader records its own reward directly, so a
                // co-signer's mirror is redundant (INSERT IGNORE-deduped) and the
                // rows re-archive under a fresh seq if the checkpoint later confirms.
                // d.txid is bound into the signed _finalizedCanonical and names the v1
                // archive head, so it is passed through to bind the specific archive
                // transaction, not merely "some anchor for this checkpoint".
                let archiveVerified = await this._verifyArchiveCheckpointOnChain(Number(d.batch_seq), String(d.txid));
                if(archiveVerified === 'verified')
                    this._recordReward('anchor_archive', Number(d.batch_seq), sender, Number(d.snapshot_block));
                else
                    console.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') archive checkpoint ' +
                                 'not on-chain verified (' + archiveVerified + '); NOT mirroring the archive reward');
            }
        }
    }

    // FINALIZED content re-verification (receiver side; the XANCFIN canonical
    // does not commit to the announced id/status lists). For every announced
    // row this hub holds locally, the announced status must be the '__partial__'
    // sentinel (keeps the row archive-eligible; benign) or byte-equal our row's
    // current status. A row we do NOT hold passes: its UPDATE is a no-op and a
    // late joiner has no copy of earlier history. Announced rewards must at
    // least be anchor-rail rows (same bar _verifyArchiveAgainstLocal sets);
    // their UPDATE only ever stamps batch_seq on rows we already derived.
    async _verifyFinalizedAgainstLocal(matches, calls, rewards){
        for(let m of (matches || [])){
            if(!m || m.match_id == null) return false;
            if(m.status === '__partial__') continue;
            let rows = await this.db.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [m.match_id]);
            if(rows && rows.length > 0 && String(rows[0].status) !== String(m.status)){
                console.warn('StateAnchorPublisher: FINALIZED match ' + String(m.match_id).substring(0, 16) +
                             "... announces status '" + m.status + "' but our row holds '" + rows[0].status + "'");
                return false;
            }
        }
        for(let c of (calls || [])){
            if(!c || c.call_id == null) return false;
            if(c.status === '__partial__') continue;
            let rows = await this.db.doQuery('SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ? LIMIT 1', [c.call_id, c.phase]);
            if(rows && rows.length > 0 && String(rows[0].status) !== String(c.status)){
                console.warn('StateAnchorPublisher: FINALIZED call ' + String(c.call_id).substring(0, 16) +
                             "... (" + c.phase + ") announces status '" + c.status + "' but our row holds '" + rows[0].status + "'");
                return false;
            }
        }
        for(let r of (rewards || [])){
            if(!r || !/^anchor_[A-Za-z_]+$/.test(String(r.reward_type || ''))){
                console.warn('StateAnchorPublisher: FINALIZED reward list carries a non-anchor reward_type; rejecting');
                return false;
            }
        }
        return true;
    }

    _finalizedCanonical(batchSeq, txid, count){
        return 'XANCFIN|' + String(batchSeq) + '|' + String(txid || '') + '|' + String(count);
    }

    // Record that `pubkey` validated as the elected archive leader for `batchSeq`
    // (called from _handleSignReq after the election/rank check passes). Stored as
    // a SET because the failover ladder can legitimately unlock more than one rank
    // for the same batch_seq, and this hub may observe successive proposers.
    _recordObservedArchiveLeader(batchSeq, pubkey, cpIdentity){
        if(!Number.isFinite(batchSeq) || !pubkey) return;
        let set = this._observedArchiveLeaders.get(batchSeq);
        if(!set){ set = new Set(); this._observedArchiveLeaders.set(batchSeq, set); }
        set.add(String(pubkey).toLowerCase());
        // Stash the batch's checkpoint identity (first observation wins). Identity
        // ONLY (chain/network/block_index/checkpoint_seq) - _handleFinalized
        // re-SELECTs our OWN checkpoint row from it before verifying, so a Byzantine
        // wire cp can never inject foreign hashes; a wrong identity just fails to
        // resolve locally and the reward mirror abstains.
        if(cpIdentity && !this._observedArchiveCheckpoints.has(batchSeq))
            this._observedArchiveCheckpoints.set(batchSeq, {
                chain: String(cpIdentity.chain), network: String(cpIdentity.network),
                block_index: Number(cpIdentity.block_index), checkpoint_seq: Number(cpIdentity.checkpoint_seq)
            });
        // Bounded memory: batch_seq is monotonic, so evict the smallest keys from
        // both maps in lockstep.
        while(this._observedArchiveLeaders.size > this._observedArchiveLeadersCap){
            let oldest = null;
            for(let k of this._observedArchiveLeaders.keys()) if(oldest === null || k < oldest) oldest = k;
            if(oldest === null) break;
            this._observedArchiveLeaders.delete(oldest);
            this._observedArchiveCheckpoints.delete(oldest);
        }
    }

    _isObservedArchiveLeader(batchSeq, pubkey){
        let set = this._observedArchiveLeaders.get(batchSeq);
        return !!set && set.has(String(pubkey || '').toLowerCase());
    }

    // The checkpoint identity we stashed for this batch_seq's archive round (from
    // the SIGN_REQ), or null if we never observed it.
    _observedArchiveCheckpoint(batchSeq){
        return this._observedArchiveCheckpoints.get(batchSeq) || null;
    }

    // Verify the checkpoint an archive batch is bound to really landed on DOGE, for
    // the FINALIZED reward gate. Resolves the stashed identity to OUR OWN
    // state_checkpoints row (never the wire), then defers to _verifyAnchorOnChain.
    // Returns 'no-checkpoint-id' (never saw the SIGN_REQ) / 'absent-local' (we do
    // not hold the referenced checkpoint) as ABSTAIN reasons, else the
    // _verifyAnchorOnChain verdict. `announcedTxid` is the FINALIZED's txid, which is
    // bound into the signed _finalizedCanonical and is the txid of the v1 ARCHIVE HEAD
    // (_publishArchive broadcasts the v1 payload first, then the v2 continuation
    // chunks). Binding it, plus version 1, closes the archive half of
    // XANC-ELECTED-FORGE-1: proving the CHECKPOINT is anchored is not enough, because
    // an elected leader could reference a real-but-different anchored checkpoint and
    // still mirror itself the (LIVE, not flag-day-retired) anchor_archive reward.
    async _verifyArchiveCheckpointOnChain(batchSeq, announcedTxid){
        let id = this._observedArchiveCheckpoint(batchSeq);
        if(!id) return 'no-checkpoint-id';
        let rows = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
            [id.chain, id.network, Number(id.block_index), Number(id.checkpoint_seq)]);
        if(!rows || rows.length === 0) return 'absent-local';
        if(!announcedTxid) return 'no-txid';
        return this._verifyAnchorOnChain(rows[0], { txid: String(announcedTxid), version: 1 });
    }

    // XMATCH canonical: byte-identical to CrossChainDexEngine._canonicalMatch /
    // the indexer's cross_settle._canonical (kept local so archive verification
    // never depends on the DEX engine being constructed).
    _matchCanonical(m){
        let raw = [
            'XMATCH', m.match_id, String(m.snapshot_block),
            m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
            m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
            String(m.effective_time), m.network || '',
            m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
            m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')
        ].join('|');
        // Cross-chain royalty legs ride the signed match at/above the CROSS_CHAIN_ROYALTY
        // flag-day; below it the canonical is byte-identical to the legacy format.
        if(ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
            raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
        // EQUIV (WI-2 bump 2): VIEW = the archived row's finalizing_view. TAG=XDEX,
        // ROUND_ID=match_id. Byte-matches the hub engine + indexer cross_settle.
        if(eq.isEquivHeaderActive(m.snapshot_block, m.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
        return raw;
    }

    // XCALL phase canonicals: byte-identical to CrossChainCallEngine._canonicalMatch
    // / the indexer's verifiers (kept local for the same reason as _matchCanonical).
    _callCanonical(c){
        let sha = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
        let phase = (c.phase === 'result') ? 'result' : 'dispatch';
        let raw;
        if(c.phase === 'result'){
            raw = [
                'XCALL', 'RESULT', c.call_id, String(c.snapshot_block), c.network || '',
                c.target_chain, String(c.result_status || ''),
                sha(c.return_payload_b64), String(c.effective_time)
            ].join('|');
        } else {
            raw = [
                'XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
                c.source_chain, String(c.source_action_index), String(c.source_contract_index),
                c.target_chain, String(c.target_contract_index),
                c.method, sha(c.params_json),
                String(c.gas_limit), String(c.cross_hops), String(c.effective_time)
            ].join('|');
        }
        // EQUIV (WI-2 bump 2): TAG=XCALL, ROUND_ID = sha256('XCALLROUND|'+phase+'|'+call_id),
        // VIEW = the archived row's finalizing_view. Byte-matches the hub engine + indexer twins.
        if(eq.isEquivHeaderActive(c.snapshot_block, c.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|' + phase + '|' + c.call_id), (c.finalizing_view != null ? c.finalizing_view : 0), raw);
        return raw;
    }

    // Signature quorum over a resolved validator set, byte-for-byte the same verdict
    // the indexer recovery (_quorumVerified) + anchor.js apply: stake-weighted
    // (source-deduped, 3*Sigma signer-source weight > 2*S) at/above STAKE_WEIGHTED_QUORUM,
    // else legacy 2f+1 count. `validatorSet` is the full [{pubkey, source, weight|amount}]
    // set (bare-pubkey callers must now pass objects). Used to gate the wrapper's own
    // on-chain validity and every archived match/call against its cross_chain set.
    _quorumVerified(canonical, sigs, validatorSet, weighted){
        // Fail CLOSED on a TRUNCATED weighted set (SWQ-TRUNC parity, mirrors
        // meetsStakeThreshold + the DEX/Call consensus refuse): an over-cap snapshot
        // under-counts summed stake S, so a stake-evicted minority could otherwise clear
        // the strict 2/3 bar and authenticate a fabricated archived match/call (or the
        // wrapper). The COUNT path proceeds (deterministic cap; see CapabilitySnapshot.getQuorum).
        if(weighted && validatorSet && validatorSet.truncated === true) return false;
        let qualified = new Set((validatorSet || []).map(v => String(v.pubkey).toLowerCase()));
        if(qualified.size === 0) return false;
        let validSigners = [], seen = new Set();
        for(let s of sigs){
            let pk = String(s.pubkey).toLowerCase();
            if(seen.has(pk) || !qualified.has(pk)) continue;
            seen.add(pk);
            if(ValidatorIdentity.verify(canonical, String(s.sig), pk)) validSigners.push(pk);
        }
        if(weighted){
            // source carries the staking source; weight (or amount, from
            // _resolveCapabilitySet) carries its stake; normalize for swq.
            let weightedSet = (validatorSet || []).map(v => ({
                pubkey: String(v.pubkey).toLowerCase(),
                source: String(v.source != null ? v.source : ''),
                weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0'))
            }));
            return swq.meetsStakeThreshold(weightedSet, validSigners);
        }
        let quorum = (qualified.size <= 1) ? 1 : Math.max(2 * Math.floor((qualified.size - 1) / 3) + 1, Math.ceil((qualified.size + 1) / 2));
        return validSigners.length >= quorum;
    }

    async _backfillBatch(batchSeq, matchIds, txid, callIds, rewardIds){
        // Every stamp is guarded by the archive-eligibility predicate the
        // pending selectors use (batch_seq IS NULL OR archived_status <> status):
        // a row that is already fully archived can never be re-stamped onto a
        // different batch by a replayed/forged FINALIZED, while legitimate
        // __partial__ re-archives (archived_status <> status) still stamp their
        // fresh seq. Reward rows are immutable, so batch_seq IS NULL is their
        // only pending test (mirrors the reward selector).
        for(let m of matchIds){
            await this.db.doQuery(
                'UPDATE cross_chain_matches SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) ' +
                'WHERE match_id = ? AND (batch_seq IS NULL OR archived_status <> status)',
                [batchSeq, m.status, txid, m.match_id]);
        }
        // Re-emit the stamped rows on the hub-DB mirror feed: anchor_txid is the one
        // back-filled column the mirror twins carry, and without a re-broadcast a
        // long-running streamed mirror keeps NULL forever while a later REST bootstrap
        // serves the stamp (divergent mirrors). Retracted rows stay out of the feed
        // (the stream already deleted them on mirrors); old sync clients INSERT IGNORE
        // the re-delivery, so this is backward-compatible.
        if(txid && matchIds.length && this.hub && this.hub.hubDbBroadcaster){
            try {
                let ids = matchIds.map(m => m.match_id);
                let rows = await this.db.doQuery(
                    "SELECT * FROM cross_chain_matches WHERE match_id IN (" + ids.map(() => '?').join(', ') + ") AND status <> 'retracted'",
                    ids);
                for(let row of rows)
                    this.hub.hubDbBroadcaster.broadcastRow({ table: 'cross_chain_matches', row: row });
            } catch(e){
                console.warn('StateAnchorPublisher: anchor-stamp re-broadcast failed (mirrors converge on next bootstrap):', e.message);
            }
        }
        for(let c of (callIds || [])){
            await this.db.doQuery(
                'UPDATE cross_chain_calls SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) ' +
                'WHERE call_id = ? AND phase = ? AND (batch_seq IS NULL OR archived_status <> status)',
                [batchSeq, c.status, txid, c.call_id, c.phase]);
        }
        for(let r of (rewardIds || [])){
            // Rows are immutable; batch_seq is the only archive bookkeeping.
            await this.db.doQuery(
                'UPDATE validator_rewards SET batch_seq = ? WHERE reward_type = ? AND round_number = ? AND validator_pubkey = ? ' +
                'AND batch_seq IS NULL',
                [batchSeq, String(r.reward_type), Number(r.round_number), String(r.validator_pubkey).toLowerCase()]);
        }
    }

    async _getNextBatchSeq(){
        // Spans every batch_seq-bearing table so a fresh seq is unique across
        // matches, calls AND rewards (consensus-uniform: all hubs compute the
        // same next seq from quorum-agreed rows).
        let r = await this.db.doQuery(
            'SELECT COALESCE(GREATEST(' +
            '  COALESCE((SELECT MAX(batch_seq) FROM cross_chain_matches), -1), ' +
            '  COALESCE((SELECT MAX(batch_seq) FROM cross_chain_calls), -1), ' +
            '  COALESCE((SELECT MAX(batch_seq) FROM validator_rewards), -1)' +
            '), -1) + 1 AS next_seq');
        return (r && r.length > 0) ? Number(r[0].next_seq) : 0;
    }

    _cpFromRow(row){
        return {
            chain: String(row.chain), network: String(row.network), block_index: Number(row.block_index),
            block_hash: String(row.block_hash), ledger_hash: String(row.ledger_hash),
            actions_hash: String(row.actions_hash), contract_hash: String(row.contract_hash),
            checkpoint_seq: Number(row.checkpoint_seq), snapshot_block: Number(row.snapshot_block)
        };
    }

    _parseSigs(raw){
        try {
            let sigs = JSON.parse(String(raw || '[]'));
            return Array.isArray(sigs) ? sigs.filter(s => s && s.pubkey && s.sig) : [];
        } catch(e){ return []; }
    }

    // crc32 over the UNCOMPRESSED archive JSON (zlib version independent).
    _crc32Hex(str){
        let n = zlib.crc32 ? zlib.crc32(Buffer.from(str, 'utf8')) : this._crc32Fallback(Buffer.from(str, 'utf8'));
        return (n >>> 0).toString(16).padStart(8, '0');
    }
    _crc32Fallback(buf){
        let c, crc = 0xFFFFFFFF;
        for(let i = 0; i < buf.length; i++){
            c = (crc ^ buf[i]) & 0xFF;
            for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    async _getActiveOraclePublishPubkeys(blockIndex){
        if(!this.hub) return [];
        if(blockIndex !== undefined && blockIndex !== null){
            // Block-PINNED election query. Fail CLOSED on a miss: the block-unpinned,
            // self-test/enabled-filtered, gossip-driven capabilityRegistry set is
            // per-hub, so substituting it here forks the election set across hubs
            // (two hubs elect over different member lists -> double-anchor of real
            // DOGE, stalled checkpoint, or an archive co-signature the indexer drops).
            // An empty (unresolved) set means abstain, which the pinned election gates
            // already fail-close on. Matches the accepted fix for #686/#925/#930.
            if(this.hub.capabilitySnapshot){
                try {
                    let snap = await this.hub.capabilitySnapshot.getSnapshot('oracle_publish', blockIndex);
                    if(snap && Array.isArray(snap.validators))
                        return snap.validators.map(v => String(v.pubkey).toLowerCase()).sort();
                } catch(e){ /* fail closed: fall through to [] */ }
            }
            return [];
        }
        // Unpinned CURRENT-membership query (blockIndex null): the coarse V0_DONE /
        // FINALIZED sender pre-filter, which wants "is this sender a current
        // oracle_publish member" and NOT a block-pinned set. Every such caller
        // re-checks the sender against the block-PINNED election / observed-leader
        // set before acting, so the live registry is the correct source here and
        // this path must NOT fail closed (that would reject every legitimate peer
        // back-fill and force systematic re-anchoring).
        if(!this.hub.capabilityRegistry) return [];
        try {
            let pubkeys = await this.hub.capabilityRegistry.getActiveValidators('oracle_publish');
            return pubkeys.map(p => String(p).toLowerCase()).sort();
        } catch(e){ return []; }
    }

    _resolveSigner(){
        let op = this.hub.oraclePublisher || {};
        return {
            broadcastFn:  this.broadcastFn  || op.broadcastFn  || null,
            walletSignFn: this.walletSignFn || op.walletSignFn || null,
            getBalanceFn: this.getBalanceFn || op.getBalanceFn || null,
            encoder:      this.encoder      || op.encoder      || null
        };
    }

    // Back-to-back spends from the one publisher wallet race the UTXO
    // tracker's mempool view and collide on input selection
    // (txn-mempool-conflict), so every anchor broadcast retries with a pause
    // for the previous spend to become visible. Throws the last error once
    // attempts are exhausted.
    async _broadcastWithRetry(broadcaster, payload, attempts){
        attempts = attempts || 5;
        let lastErr = null;
        for(let attempt = 0; attempt < attempts; attempt++){
            if(attempt > 0) await new Promise(r => setTimeout(r, this.chunkRetryDelayMs));
            try { return await broadcaster(payload); }
            catch(e){ lastErr = e; }
        }
        throw lastErr || new Error('broadcast failed');
    }

    async _defaultBroadcast(payload, signer){
        signer = signer || this._resolveSigner();
        if(!signer.encoder)      throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if(!signer.walletSignFn) throw new Error('no wallet sign hook configured');
        if(!this.dogeAddress)    throw new Error('no DOGE_ADDRESS configured');
        let utxos = await signer.encoder.getUtxos(this.dogeAddress);
        if(!utxos || (Array.isArray(utxos) && utxos.length === 0)) throw new Error('no UTXOs available for ' + this.dogeAddress);
        let psbtResult = await signer.encoder.createTx({
            utxos: utxos, pubkey: this.dogeAddress, data: payload, change: this.dogeAddress, encoding: 'P2SH'
        });
        if(!psbtResult || !psbtResult.psbt) throw new Error('encoder returned no PSBT');
        let txHex = await signer.walletSignFn(psbtResult.psbt);
        if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        return (await signer.encoder.broadcastTx(txHex)) || { txid: null };
    }

    async _checkBalance(signer){
        let balance = null;
        try {
            if(signer.getBalanceFn) balance = await signer.getBalanceFn();
            else if(signer.encoder && this.dogeAddress){
                let utxos = await signer.encoder.getUtxos(this.dogeAddress);
                if(Array.isArray(utxos)) balance = utxos.reduce((t, u) => t + (parseFloat(u.value || u.amount || 0) || 0), 0);
            }
        } catch(e){ return null; }
        if(balance !== null){
            this._lastBalance   = balance;
            this._lastBalanceAt = Date.now();
        }
        if(balance !== null && balance < this.lowBalanceThreshold)
            console.warn('StateAnchorPublisher: DOGE balance LOW (' + Number(balance).toFixed(4) + ' DOGE)');
        return balance;
    }
}

module.exports = StateAnchorPublisher;
module.exports.XANC_SIGN_REQ  = XANC_SIGN_REQ;
module.exports.XANC_SIGN      = XANC_SIGN;
module.exports.XANC_FINALIZED = XANC_FINALIZED;
module.exports.XANC_V0_DONE   = XANC_V0_DONE;
module.exports.XANCPUB_SIGN_REQ = XANCPUB_SIGN_REQ;
module.exports.XANCPUB_SIGN     = XANCPUB_SIGN;
module.exports.MATCH_KEYS     = MATCH_KEYS;
