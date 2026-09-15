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
 * XChain Hub - Cross-Chain Contract Call Engine (XCALL relay)
 *
 * Relays contract-emitted cross-chain calls (XCALL v0 on the source chain)
 * to the target chain and the execution outcome back, with zero per-call
 * on-chain writes: both legs ride the hub-DB mirror as quorum-signed
 * `cross_chain_calls` rows, the same transport that carries
 * cross_chain_matches (see CrossChainDexEngine).
 *
 * Flow:
 *   1. Discover: poll each chain's `getpendingcrosschaincalls` RPC for
 *                XCALL v0 requests that have reached that chain's
 *                confirmation depth (BTC 6 / LTC 12 / DOGE 60, the same
 *                thresholds as cross-chain swap attestation; a request
 *                below depth is reorg-able and must never be relayed,
 *                because the target-chain execution CANNOT be retracted).
 *   2. Dispatch: PBFT round over the dispatch row (each peer re-verifies
 *                the request against its OWN source-chain indexer before
 *                signing); 2f+1 signatures -> write + mirror the
 *                phase='dispatch' row. Target-chain indexers verify the
 *                signatures and inject the execution deterministically.
 *   3. Result:   poll the target chain's `getcrosschaincallresult` for
 *                the injected execution's outcome at confirmation depth;
 *                PBFT round over the result row (peers re-verify against
 *                their own target-chain indexer); write + mirror the
 *                phase='result' row. Source-chain indexers verify and
 *                inject the requester's callback.
 *   4. Retract:  on a source-chain reorg below a request, mark its rows
 *                retracted-by-deletion (broadcast) so indexers that have
 *                not yet injected skip them. Past confirmation depth this
 *                should never happen; it is the documented residual risk.
 *
 * Trust boundary: indexers verify the 2f+1 signatures against the mirrored
 * cross_chain capability snapshot (the mirror is a transport, not an
 * authority). Deadline expiry on the source chain bounds federation
 * censorship: a request that never gets a result fires a deterministic
 * `expired` callback derived from block height alone.
 *
 * Reuses CrossChainDexConsensus (parameterized message types) for the PBFT
 * rounds; round ids are sha256('XCALLROUND|' + phase + '|' + call_id) so
 * dispatch and result rounds for the same call never collide.
 *
 ********************************************************************/

const crypto       = require('crypto');
const EventEmitter = require('events');
const axios        = require('axios');

const eq                     = require('../equivocation_header.js');
const ah                     = require('../lib/admission_height.js');
const CrossChainDexConsensus = require('./dex_consensus.js');
const coins                  = require('../coins');
const snapWrite              = require('../lib/capability_snapshot_write.js');

// Relay margin: a relayed row's effective_time is stamped this many blocks (of
// the chain that GATES the row) into the future, so the row is written and
// propagated everywhere BEFORE any chain reaches the block it applies at.
// Without a margin, effective_time = the finalization instant, so a chain whose
// tip already sits at that second can reach the eligible block before the row
// has landed, injecting the execution/callback a block (or more) late and
// permanently shifting its action-index counter relative to a node that sees
// the row on time (EMITTER_ACTION_INDEX is in the call_id preimage -> ledger
// fork). Tunable UPWARD via XCALL_RELAY_MARGIN_BLOCKS (env / p2pConfig); the
// default doubles as a HARD FLOOR, so a 0 no longer zeroes the margin.
// Sizing, the ceiling and the follower-side floor live in lib/relay_margin.js.
const { DEFAULT_RELAY_MARGIN_BLOCKS } = require('../lib/relay_margin.js');

const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();
const { installParts } = require('./prototype_parts.js');
const { ALLOWED_CHAINS, DEFAULT_POLL_MS } = require('./call/constants.js');
const pollPart     = require('./call/poll.js');
const validatePart = require('./call/validate.js');
const finalizePart = require('./call/finalize.js');
const plumbingPart = require('./call/plumbing.js');

class CrossChainCallEngine extends EventEmitter {

    constructor(hub){
        super();
        this.hub         = hub;
        this.db          = hub.db;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.broadcaster = hub.hubDbBroadcaster || null;
        this.capSnapshot = hub.capabilitySnapshot || null;

        let cfg = hub.p2pConfig || {};
        this.pollMs = parseInt(hubConfig.XCALL_POLL_MS || cfg.XCALL_POLL_MS || DEFAULT_POLL_MS);

        // Confirmation thresholds (env -> p2pConfig -> default), shared with the
        // swap-attestation engine so operators tune ONE depth per chain.
        // Mainnet floor-clamped, see coins.resolveConfirmations.
        this.confirmations = coins.resolveConfirmations(cfg, hub && hub.network);

        // Relay margin in blocks (env -> p2pConfig -> default). Stamped onto every
        // relayed row's effective_time, sized by the gating chain's nominal block
        // interval. See DEFAULT_RELAY_MARGIN_BLOCKS.
        let marginBlocks = parseInt(hubConfig.XCALL_RELAY_MARGIN_BLOCKS, 10);
        if(!Number.isFinite(marginBlocks)) marginBlocks = parseInt(cfg.XCALL_RELAY_MARGIN_BLOCKS, 10);
        if(!Number.isFinite(marginBlocks) || marginBlocks < 0) marginBlocks = DEFAULT_RELAY_MARGIN_BLOCKS;
        this.relayMarginBlocks = marginBlocks;

        // Regtest seams: deliberately the SAME env names as the DEX engine so a
        // no-BTC regtest stack configures the anchor + seeded validator once.
        // Honored ONLY on regtest; NaN/false everywhere else (fail closed to the real
        // set) so a stray env var or configs-table row never reaches the SIGNED snapshot
        // anchor or the seeded validator on mainnet/testnet. Mirrors StateCheckpointEngine.
        this.network = (hub && hub.network) ? hub.network : '';
        let _isRegtest = (this.network === 'regtest');
        this._snapshotBlockOverride = _isRegtest ? parseInt(hubConfig.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK) : NaN;
        this._seedLocalValidator    = _isRegtest && (hubConfig.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
                                       cfg.XDEX_SEED_LOCAL_VALIDATOR === '1' || cfg.XDEX_SEED_LOCAL_VALIDATOR === true);

        // Per-coin indexer JSON-RPC endpoints (same idiom as CrossChainDexEngine).
        this.indexers = {};
        for(let coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: hubConfig.env()[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: hubConfig.env()[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        this.initRoundTracking();
        this.createRelayConsensus();

        this._pollTimer = null;
        this._polling   = false;

        // Process-lifetime counter for result-relay attempt failures (one per
        // per-call catch in pollTargetResults). Surfaced by getcrosschaincallstats.
        this._resultAttemptFailures = 0;

        // Node-local result-relay backoff (M-14): call_id -> { attempts, nextAt (ms epoch) }.
        // Parked entries are excluded from the result poll's hot window until nextAt.
        this._resultBackoff = new Map();
    }

    createRelayConsensus(){
        // PBFT consensus over each relay row. Distinct message types keep XCALL
        // gossip out of the DEX match rounds; idField binds rounds to round_id.
        this.consensus = new CrossChainDexConsensus(this, {
            messageTypes: {
                PROPOSE:     'XCALL_RELAY_PROPOSE',
                PREPARE:     'XCALL_RELAY_PREPARE',
                COMMIT:      'XCALL_RELAY_COMMIT',
                VIEW_CHANGE: 'XCALL_RELAY_VIEW_CHANGE',
                NEW_VIEW:    'XCALL_RELAY_NEW_VIEW',
                FINAL_SYNC:  'XCALL_RELAY_FINAL_SYNC'
            },
            controlTags: { vc: 'XCALLVC', nv: 'XCALLNV' },
            idField: 'round_id'
        });
        this.consensus.on('match:finalized', (ev) => {
            this.writeFinalizedRow(ev).catch(err =>
                logger.error(nodeUtil.format('CrossChainCall: write finalized row error:', err && err.message)));
        });
        // A round the consensus abandons (churned past its max lifetime under
        // sustained message loss) must release its inflight slot, or the next poll
        // skips it (line: `if(this._inflight.has(roundId)) return;`) and the call
        // wedges permanently. Releasing it lets the poll re-propose a fresh round.
        this.consensus.on('match:abandoned', (ev) => {
            this._inflight.delete(String(ev.matchId));
        });
    }

    async start(){
        // Fill any indexer URL left empty at construction (configs-table-
        // provisioned hubs carry no *_INDEXER_URL env var) via the hub's
        // configs-aware resolver, then warn loudly for any chain still missing,
        // so this engine cannot silently poll nothing forever.
        if(this.hub && typeof this.hub.resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub.resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        for(const coin of Object.keys(this.indexers || {})){
            if(!this.indexers[coin] || !this.indexers[coin].url)
                logger.warn('CrossChainCall: no indexer URL for chain ' + coin + ' (set ' + coin + '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); this chain is skipped every tick until configured');
        }
        await this.consensus.start();
        this._pollTimer = setInterval(() => {
            this._poll().catch(err => logger.error(nodeUtil.format('CrossChainCall: poll error:', err && err.message)));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();
        logger.info('CrossChainCall: engine started (poll ' + this.pollMs + 'ms, confirmations ' +
                    ALLOWED_CHAINS.map(c => c + '=' + this.confirmations[c]).join(' ') + ')');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        await this.consensus.stop();
    }

    // Canonical signing strings. MUST byte-match the indexer's verifiers
    // (xexec.js for dispatch, the callback pass for result). Variable-length
    // fields (params, return payload) enter as sha256 so the canonical stays
    // fixed-arity and '|'-safe.
    // `view` = the live pending.view (consensus) / persisted finalizing_view (twins). At/above
    // the EQUIV flag-day the content is wrapped (TAG=XCALL, ROUND_ID = the sha256 round id,
    // which folds in `phase` so dispatch and result get DISTINCT keys, VIEW=view). The view
    // lives in the header only (not a content field).
    // Stamp the row's ADMISSION MAP over the chains that read it (target_chain OR
    // source_chain, from the consuming selects), at this hub's fresh admission tip on each
    // plus the table's block margin. Returns false when the round must NOT open.
    //
    // C4: with no fresh tip for either chain this hub refuses to open the round rather
    // than guessing a height, because a guessed height forks while a refusal stalls one
    // rail. Every column is named at every height so a legacy row carries explicit NULLs,
    // which is the legacy binding rule rather than an absent key.
    async stampAdmission(row){
        let map = null;
        if(ah.isAdmissionEra(row.network, row.snapshot_block)){
            let readSet = ah.admissionReadSet('cross_chain_calls', row);
            map = this.hub && typeof this.hub.resolveAdmitBlocks === 'function'
                ? await this.hub.resolveAdmitBlocks('cross_chain_calls', readSet) : null;
            if(!map){
                logger.error('CrossChainCall: refusing to open the ' + row.phase + ' round for call ' +
                    String(row.call_id).substring(0,16) + '... at snapshot_block ' + row.snapshot_block +
                    '; no fresh admission tip for ' + readSet.join(' / '));
                return false;
            }
        }
        Object.assign(row, ah.admitBlocksToColumns(map));
        return true;
    }

    // The FOLLOWER half of admission by height: which table this row belongs to, which
    // chains read it, and which block keys its era. Read by CrossChainDexConsensus, which
    // holds the one PROPOSE handler every engine shares and cannot know any of the three
    // for itself: `idField` is 'round_id' on both this engine and AttestationRelay, so
    // there is nothing on the consensus side to derive a table from without guessing.
    //
    // Returning null means "this row is not in the admission era", which is the legacy
    // binding rule and not a pass: a legacy-era row carrying a map is refused by
    // _canonicalMatch before the consensus ever asks.
    admissionScope(row){
        let r = row || {};
        if(!ah.isAdmissionEra(r.network, r.snapshot_block)) return null;
        return { table: 'cross_chain_calls', readSet: ah.admissionReadSet('cross_chain_calls', r) };
    }

    // The per-chain follower bound (C38, BF6). A leader's admit_blocks[c] must land in
    // [ourTip + 1, ourTip + ADMIT_MAX_FUTURE_BLOCKS(c)] on every chain that reads the row,
    // and the map must cover every one of them.
    //
    // This is a SECOND axis, not a replacement for the effective_time window above: a hub
    // with a broken clock and a hub with a wrong tip are each caught by the axis that can
    // see them, and a Byzantine leader has to be right on both to collect our signature.
    //
    // Every failure below is a refusal, including the ones that are our own fault (no
    // resolver, a dead indexer, a frozen decoder). Adopting a height we could not check
    // would sign the proposer's own claim back to it, which is what a bound is for.
    async checkProposedAdmission(row){
        let scope;
        try { scope = this.admissionScope(row); }
        catch (err) {
            logger.warn('CrossChainCall: refusing call ' + String(row.call_id).substring(0,16) +
                '...; unusable admission read set: ' + err.message);
            return false;
        }
        if(scope === null) return true;                       // legacy era; the old rule binds

        let map;
        try { map = ah.rowAdmitBlocks(row); }
        catch (err) {
            logger.warn('CrossChainCall: refusing call ' + String(row.call_id).substring(0,16) +
                '...; unusable admission map: ' + err.message);
            return false;
        }
        let v = await ah.checkAdmitBlocksAgainstHub(this.hub, scope.readSet, map);
        if(!v.ok){
            logger.warn('CrossChainCall: refusing to sign the ' + row.phase + ' round for call ' +
                String(row.call_id).substring(0,16) + '... at snapshot_block ' + row.snapshot_block +
                '; ' + v.reason);
            return false;
        }
        return true;
    }

    _canonicalMatch(r, view){
        let raw;
        if(r.phase === 'result'){
            raw = [
                'XCALL', 'RESULT', r.call_id, String(r.snapshot_block), r.network || '',
                r.target_chain, String(r.result_status || ''),
                this._sha256(String(r.return_payload_b64 == null ? '' : r.return_payload_b64)),
                String(r.effective_time)
            ].join('|');
        } else {
            raw = [
                'XCALL', 'DISPATCH', r.call_id, String(r.snapshot_block), r.network || '',
                r.source_chain, String(r.source_action_index), String(r.source_contract_index),
                r.target_chain, String(r.target_contract_index),
                r.method, this._sha256(String(r.params_json == null ? '' : r.params_json)),
                String(r.gas_limit), String(r.cross_hops), String(r.effective_time)
            ].join('|');
        }
        // The admission map, height-gated on the ROW's own snapshot_block. BOTH phases
        // carry it: the dispatch is read by source_chain and target_chain and the result by
        // target_chain, and a phase that skipped the field would bind by effective_time
        // while its sibling bound by height, which is the split this design removes.
        raw += ah.admissionCanonicalField('CrossChainCall', r.network, r.snapshot_block, ah.rowAdmitBlocks(r));
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, this._roundId(r.phase, r.call_id), (view != null ? view : 0), raw);
        return raw;
    }

    // Persist + mirror the qualifying validator set (consensus leader path,
    // same contract as CrossChainDexEngine._persistCapabilitySnapshot).
    // Returns the number of capability rows resolved (and persisted) for this
    // (capability, block). A return of 0 means the set degraded to empty (an
    // indexer RPC error / auth mismatch surfaces as a null snapshot, which
    // resolveCapabilityValidators normalizes to []) or was refused as truncated,
    // so money-path callers can fail closed rather than committing a row whose
    // signatures no mirror can verify against capability_snapshots.
    async _persistCapabilitySnapshot(capability, block, network){
        let validators = await this.resolveCapabilityValidators(capability, block, network);
        // SWQ-TRUNC-MIRROR: a TRUNCATED set is never mirrored, for the reason
        // spelled out in CrossChainDexEngine._persistCapabilitySnapshot. Mirroring the
        // capped rows would let the off-BTC cross_chain verifiers finalize over an
        // under-counted stake denominator that this hub's own meetsStakeThreshold rejects.
        // Keep the three engines' guards in lockstep.
        if(validators && validators.truncated === true){
            logger.warn('CrossChainCall: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return 0;
        }
        // One statement for the whole set: a per-row loop left the mirror PARTIAL on any
        // single INSERT throw, and a partial set has no completeness marker so a verifier
        // reads it as COMPLETE. Rationale in lib/capability_snapshot_write.js. Parity with
        // StateCheckpointEngine and the other four writers.
        //
        // The chain identity is passed rather than left to the writer's own lookup: this
        // engine knows the row's network, so the snapshot a call is verified against carries
        // the same identity the call row does, even on a hub whose HUB_NETWORK is unset.
        let rows = await snapWrite.writeCapabilitySnapshotRows(
            this.db, capability, block, validators, await this.resolveBtcChainId(network));
        for(let row of rows){
            if(this.broadcaster){
                // Select back on the full widened uq_cap_snap
                // (snapshot_block, capability, signing_pubkey, source). A pubkey-only
                // select-back re-read the SAME row for every source of a delegated key
                // (LIMIT 1), so the mirror stream carried one source and the downstream
                // verifier tallied an under-counted denominator. Inert below SWQ, where
                // source='' and there is one row per key. Parity with StateCheckpointEngine.
                let r = await this.db.getCapabilitySnapshot(block, capability, row.signing_pubkey, row.source);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
    }

    _roundId(phase, callId){
        return this._sha256('XCALLROUND|' + phase + '|' + callId);
    }

    _sha256(s){
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
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

installParts(CrossChainCallEngine.prototype, [
    pollPart, validatePart, finalizePart, plumbingPart
]);

module.exports = CrossChainCallEngine;
