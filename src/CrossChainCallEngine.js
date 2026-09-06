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

const swq                    = require('./stake_weighted_quorum.js');
const eq                     = require('./equivocation_header.js');
const CrossChainDexConsensus = require('./CrossChainDexConsensus.js');
const { XCALL_MAX_HOPS }     = require('./constants.js');
const coins                  = require('./coins');
const { normalizeRetractionBounds } = require('./lib/retraction_bounds.js');
const snapWrite              = require('./lib/capability_snapshot_write.js');

const ALLOWED_CHAINS  = [...coins.ALLOWED_COINS];
const DEFAULT_POLL_MS = 15000;

// Per-chain confirmation depth a source request (and a target execution) must
// reach before the federation will sign its relay row: shares the cross-chain
// swap thresholds (coins.resolveConfirmations; XCHAIN_CONFIRMATIONS_<COIN> env
// / p2pConfig overridable, mainnet floor-clamped).

// Result statuses the federation will relay. Anything else from an indexer is
// treated as 'error' (deterministic normalization happens indexer-side; this
// is belt-and-suspenders against a confused indexer response).
// Note: the indexer's vmFailureStatus collapses resource exhaustion to
// 'out_of_resource', but xexec.js:_mapFailureStatus then re-normalizes
// 'out_of_resource' back to 'out_of_gas' for XCALL result rows, so
// 'out_of_gas' (not 'out_of_resource') is what the federation relays here.
const RESULT_STATUSES = ['ok', 'reverted', 'out_of_gas', 'no_contract', 'not_callable', 'payload_too_large', 'error'];

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
const { DEFAULT_RELAY_MARGIN_BLOCKS, RELAY_MIN_FUTURE_S, relayMarginS } = require('./lib/relay_margin.js');

// Canonical integer-spelling guard for the signed fields (see lib/canonical_int.js).
const { allCanonicalInts } = require('./lib/canonical_int.js');

// The INT/BIGINT-backed fields each phase signs VERBATIM into _canonicalMatch and
// every verifier re-derives from a normalized integer. Decimal, address, method,
// payload, chain and status fields are compared as strings and are NOT listed.
const CANONICAL_INT_FIELDS = {
    dispatch: ['snapshot_block', 'source_action_index', 'source_contract_index',
               'target_contract_index', 'gas_limit', 'cross_hops', 'effective_time'],
    result:   ['snapshot_block', 'effective_time']
};

// Result-relay backoff (deepdive M-14). A dispatch row whose target execution
// never yields a result at confirmation depth (e.g. the execution was reorged
// away and never re-injected) matches the result poll's WHERE clause forever.
// Under a plain `ORDER BY id ASC LIMIT n` window such rows, being the lowest ids,
// would pin the window and starve every newer dispatch (head-of-line blocking).
// A result-less row is parked with an exponential next-retry time and excluded
// from the hot window until then, so fresh dispatches always get in while the
// stuck row is retried on a slow cadence. Node-local only: which rows THIS hub
// proposes first is not a consensus decision (every hub re-verifies each round
// independently and any hub can lead it), so parking never blocks participation.
const RESULT_BACKOFF_BASE_MS    = 60 * 1000;        // first re-attempt delay for a result-less dispatch
const RESULT_BACKOFF_MAX_MS     = 60 * 60 * 1000;   // exponential backoff ceiling (1h)
const RESULT_BACKOFF_EXCLUDE_MAX = 500;             // max parked call_ids excluded per query (bounds query size)
const RESULT_BACKOFF_MAP_MAX    = 10000;            // parked-map cap; FIFO evict just retries an entry sooner (safe)

// Read-only surface column list for the relay-row API (getCall/listCalls).
// Excludes the heavy validator_signatures blob, the hub-side-only ANCHOR audit
// columns (batch_seq/archived_status/anchor_txid), and the mirror-internal
// consensus fences (finalizing_view/push_generation): those serve signature
// verification and reorg fencing, not operator/explorer display.
const CALL_SURFACE_COLS = 'id, call_id, phase, snapshot_block, network, source_chain, ' +
    'source_action_index, source_contract_index, target_chain, target_contract_index, ' +
    'method, params_json, gas_limit, cross_hops, effective_time, status, result_status, ' +
    'return_payload_b64, created_at';

// Bound on listCalls rows (mirrors the api-side validateLimit ceiling).
const CALL_LIST_MAX = 10000;

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
        this.pollMs = parseInt(process.env.XCALL_POLL_MS || cfg.XCALL_POLL_MS || DEFAULT_POLL_MS);

        // Confirmation thresholds (env -> p2pConfig -> default), shared with the
        // swap-attestation engine so operators tune ONE depth per chain.
        // Mainnet floor-clamped, see coins.resolveConfirmations.
        this.confirmations = coins.resolveConfirmations(cfg, hub && hub.network);

        // Relay margin in blocks (env -> p2pConfig -> default). Stamped onto every
        // relayed row's effective_time, sized by the gating chain's nominal block
        // interval. See DEFAULT_RELAY_MARGIN_BLOCKS.
        let marginBlocks = parseInt(process.env.XCALL_RELAY_MARGIN_BLOCKS, 10);
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
        this._snapshotBlockOverride = _isRegtest ? parseInt(process.env.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK) : NaN;
        this._seedLocalValidator    = _isRegtest && (process.env.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
                                       cfg.XDEX_SEED_LOCAL_VALIDATOR === '1' || cfg.XDEX_SEED_LOCAL_VALIDATOR === true);

        // Per-coin indexer JSON-RPC endpoints (same idiom as CrossChainDexEngine).
        this.indexers = {};
        for(let coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        // Round ids currently in PBFT but not yet written (mirrors DexEngine._inflight).
        this._inflight = new Set();

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
            this._writeFinalizedRow(ev).catch(err =>
                console.error('CrossChainCall: write finalized row error:', err && err.message));
        });
        // A round the consensus abandons (churned past its max lifetime under
        // sustained message loss) must release its inflight slot, or the next poll
        // skips it (line: `if(this._inflight.has(roundId)) return;`) and the call
        // wedges permanently. Releasing it lets the poll re-propose a fresh round.
        this.consensus.on('match:abandoned', (ev) => {
            this._inflight.delete(String(ev.matchId));
        });

        this._pollTimer = null;
        this._polling   = false;

        // Process-lifetime counter for result-relay attempt failures (one per
        // per-call catch in _pollTargetResults). Surfaced by getcrosschaincallstats.
        this._resultAttemptFailures = 0;

        // Node-local result-relay backoff (M-14): call_id -> { attempts, nextAt (ms epoch) }.
        // Parked entries are excluded from the result poll's hot window until nextAt.
        this._resultBackoff = new Map();
    }

    async start(){
        // Fill any indexer URL left empty at construction (configs-table-
        // provisioned hubs carry no *_INDEXER_URL env var) via the hub's
        // configs-aware resolver, then warn loudly for any chain still missing,
        // so this engine cannot silently poll nothing forever.
        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        for(const coin of Object.keys(this.indexers || {})){
            if(!this.indexers[coin] || !this.indexers[coin].url)
                console.warn('CrossChainCall: no indexer URL for chain ' + coin + ' (set ' + coin + '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); this chain is skipped every tick until configured');
        }
        await this.consensus.start();
        this._pollTimer = setInterval(() => {
            this._poll().catch(err => console.error('CrossChainCall: poll error:', err && err.message));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();
        console.log('CrossChainCall: engine started (poll ' + this.pollMs + 'ms, confirmations ' +
                    ALLOWED_CHAINS.map(c => c + '=' + this.confirmations[c]).join(' ') + ')');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        await this.consensus.stop();
    }

    // Return operator-visible relay backlog depth and lifetime failure counter.
    // Mirrors getattestationstats: pending_relay_count is the number of dispatch
    // rows per target chain that do not yet have a result row; result_attempt_failures
    // is a process-lifetime count of per-call errors in _pollTargetResults.
    async getStats(){
        let rows = [];
        try {
            // Mirror _pollTargetResults' retracted-result filter so the backlog
            // count matches what the engine will actually re-relay: a
            // dispatch whose only result row is 'retracted' is pending again.
            rows = await this.db.doQuery(
                "SELECT d.target_chain, COUNT(*) AS pending_relay_count " +
                "FROM cross_chain_calls d " +
                "LEFT JOIN cross_chain_calls r ON r.call_id = d.call_id AND r.phase = 'result' AND r.status <> 'retracted' " +
                "WHERE d.phase = 'dispatch' AND d.status = 'finalized' AND r.id IS NULL " +
                "GROUP BY d.target_chain");
        } catch(e){
            console.warn('CrossChainCall: getStats query failed: ' + (e && e.message));
        }
        let pending_by_chain = {};
        for(let r of rows) pending_by_chain[r.target_chain] = Number(r.pending_relay_count);
        return {
            pending_relay_count:      rows.reduce((s, r) => s + Number(r.pending_relay_count), 0),
            pending_by_chain:         pending_by_chain,
            result_attempt_failures:  this._resultAttemptFailures
        };
    }

    // Surface one XCALL relay lifecycle for the explorer/dashboard. Reads
    // the hub's OWN cross_chain_calls table and returns both phases keyed by call_id
    // as { call_id, dispatch, result }. dispatch/result are null when absent (e.g. a
    // dispatched call whose target execution has not been relayed back yet). Includes
    // retracted rows so a caller can see a reorged-away call's last-known state; the
    // row's own `status` field distinguishes finalized from retracted. Read-only.
    async getCall(callId){
        if(!callId) return null;
        let rows = await this.db.doQuery(
            'SELECT ' + CALL_SURFACE_COLS + " FROM cross_chain_calls WHERE call_id = ? ORDER BY phase",
            [String(callId)]);
        if(!rows || rows.length === 0) return null;
        return {
            call_id:  String(callId),
            dispatch: rows.find(r => r.phase === 'dispatch') || null,
            result:   rows.find(r => r.phase === 'result')   || null
        };
    }

    // List XCALL relay rows for the explorer/dashboard, newest first,
    // with optional source_chain/target_chain/status/phase filters. Read-only.
    async listCalls({sourceChain, targetChain, status, phase, limit} = {}){
        let where = [];
        let args  = [];
        if(sourceChain){ where.push('source_chain = ?'); args.push(String(sourceChain)); }
        if(targetChain){ where.push('target_chain = ?'); args.push(String(targetChain)); }
        if(status){ where.push('status = ?'); args.push(String(status)); }
        if(phase){ where.push('phase = ?'); args.push(String(phase)); }
        let sql = 'SELECT ' + CALL_SURFACE_COLS + ' FROM cross_chain_calls';
        if(where.length) sql += ' WHERE ' + where.join(' AND ');
        sql += ' ORDER BY id DESC LIMIT ?';
        let n = parseInt(limit);
        if(!Number.isInteger(n) || n <= 0) n = 50;
        if(n > CALL_LIST_MAX) n = CALL_LIST_MAX;
        args.push(n);
        return await this.db.doQuery(sql, args);
    }

    async _poll(){
        if(this._polling) return;                       // never overlap slow polls
        this._polling = true;
        try {
            for(let coin of ALLOWED_CHAINS){
                if(!this.indexers[coin].url) continue;
                await this._pollSourceRequests(coin);
                await this._pollTargetResults(coin);
            }
        } finally {
            this._polling = false;
        }
    }

    // Discover XCALL v0 requests on `coin` that have reached confirmation depth
    // and have no dispatch row yet, and run a dispatch round for each.
    async _pollSourceRequests(coin){
        let res;
        try { res = await this._indexerCall(coin, 'getpendingcrosschaincalls', { limit: 100 }); }
        catch(e){ return; }
        if(!res || !Array.isArray(res.calls) || !res.network) return;
        let latest = Number(res.latest_block_index);
        if(!Number.isFinite(latest)) return;

        for(let call of res.calls){
            try { await this._maybeDispatch(coin, String(res.network), latest, call); }
            catch(e){ console.warn('CrossChainCall: dispatch attempt failed for ' +
                                   String(call && call.call_id).substring(0, 16) + '...: ' + (e && e.message)); }
        }
    }

    async _maybeDispatch(coin, network, latestBlock, call){
        let callId = String(call.call_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(callId)) return;
        if(!ALLOWED_CHAINS.includes(call.target_chain) || call.target_chain === coin) return;

        // Confirmation gate: the one defense against relaying a reorg-able
        // request (the target-side execution cannot be retracted).
        let depth = latestBlock - Number(call.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[coin]) return;

        // Deadline gate: the source chain will locally expire this request; a
        // late dispatch would be wasted work (the result callback loses the
        // exactly-once interlock race deterministically, but don't bother).
        if(call.deadline_block != null && Number(call.deadline_block) <= latestBlock) return;

        // Hop-cap gate (defense-in-depth): the indexer caps cross_hops at
        // XCALL_MAX_HOPS during execution, so a relay row that exceeds the cap
        // would be rejected at injection anyway. Drop it here to avoid a wasted
        // PBFT round and a stale dispatch row.
        if((Number(call.cross_hops) || 0) > XCALL_MAX_HOPS) return;

        let roundId = this._roundId('dispatch', callId);
        if(this._inflight.has(roundId)) return;
        if(await this._rowExists(callId, 'dispatch')) return;

        let snapshotBlock = await this._resolveSnapshotBlock();
        if(snapshotBlock == null) throw new Error('cannot resolve snapshot block');

        let row = {
            round_id:              roundId,
            call_id:               callId,
            phase:                 'dispatch',
            snapshot_block:        Number(snapshotBlock),
            network:               network,
            source_chain:          coin,
            source_action_index:   Number(call.action_index),
            source_contract_index: Number(call.source_contract_index),
            target_chain:          String(call.target_chain),
            target_contract_index: Number(call.target_contract_index),
            method:                String(call.method),
            params_json:           String(call.params_json || '[]'),
            gas_limit:             Number(call.gas_limit),
            cross_hops:            Number(call.cross_hops) || 0,
            effective_time:        this._relayEffectiveTime(String(call.target_chain)),
            result_status:         null,
            return_payload_b64:    null,
            // Source-chain reorg fence: the source indexer's generation
            // for this call, mirrored from getpendingcrosschaincalls. The result row
            // inherits it so a source-keyed retraction fences both phases by the same
            // generation. Metadata only; NOT part of the signed canonical.
            push_generation:       Number(call.push_generation) || 0
        };

        let validators = await this._resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);
        this._inflight.add(roundId);
        try {
            await this.consensus.propose(roundId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(roundId);
            throw e;
        }
    }

    // Discover dispatch rows targeting `coin` whose injected execution has
    // completed at confirmation depth, and run a result round for each.
    async _pollTargetResults(coin){
        // The result-leg join carries `AND r.status <> 'retracted'` for the same
        // reason _rowExists does: after a deep reorg leaves a 'retracted'
        // result row, an unfiltered join would see r.id IS NOT NULL, exclude the
        // dispatch, and never re-relay the result (the call could then only deliver
        // the deterministic 'expired' callback). Filtering retracted result rows
        // back out re-opens re-discovery; _maybeRelayResult re-relay is idempotent
        // (synthetic TX_HASH dedup) so re-relay after re-discovery is safe.
        // Exclude call_ids still inside their backoff window so a permanently
        // result-less dispatch cannot pin the ORDER BY id ASC window (M-14). Bounded
        // to keep the NOT IN list (and query) small; beyond the bound the remaining
        // parked rows fall back to the id-window, which is the pre-fix behavior only
        // for that pathological tail.
        let now = Date.now();
        let parked = [];
        for(let [cid, b] of this._resultBackoff){
            if(b.nextAt > now){ parked.push(cid); if(parked.length >= RESULT_BACKOFF_EXCLUDE_MAX) break; }
        }
        let exclude = parked.length ? (" AND d.call_id NOT IN (" + parked.map(() => '?').join(',') + ")") : "";
        let pending = await this.db.doQuery(
            "SELECT d.* FROM cross_chain_calls d " +
            "LEFT JOIN cross_chain_calls r ON r.call_id = d.call_id AND r.phase = 'result' AND r.status <> 'retracted' " +
            "WHERE d.phase = 'dispatch' AND d.status = 'finalized' AND d.target_chain = ? AND r.id IS NULL" + exclude +
            " ORDER BY d.id ASC LIMIT 100", [coin, ...parked]);
        for(let d of pending){
            let callId = String(d.call_id).toLowerCase();
            try {
                // _maybeRelayResult returns false when the result is not yet available
                // (missing / below depth): park it so it leaves the hot window. Any
                // other outcome (round proposed, or already in flight) clears backoff.
                let relayed = await this._maybeRelayResult(coin, d);
                if(relayed === false) this._parkResult(callId);
                else this._resultBackoff.delete(callId);
            } catch(e){
                this._resultAttemptFailures++;
                this._parkResult(callId);
                console.warn('CrossChainCall: result attempt failed for ' +
                             callId.substring(0, 16) + '...: ' + (e && e.message));
            }
        }
    }

    // Park a result-less dispatch with exponential backoff so it exits the hot poll
    // window; it re-enters once nextAt elapses. See RESULT_BACKOFF_* rationale.
    _parkResult(callId){
        let evicting = !this._resultBackoff.has(callId) && this._resultBackoff.size >= RESULT_BACKOFF_MAP_MAX;
        if(evicting){
            let oldest = this._resultBackoff.keys().next().value;
            if(oldest !== undefined) this._resultBackoff.delete(oldest);
        }
        let b = this._resultBackoff.get(callId) || { attempts: 0, nextAt: 0 };
        b.attempts++;
        let delay = Math.min(RESULT_BACKOFF_BASE_MS * Math.pow(2, b.attempts - 1), RESULT_BACKOFF_MAX_MS);
        b.nextAt = Date.now() + delay;
        this._resultBackoff.set(callId, b);
    }

    // Returns true when the result exists and a relay round was proposed (or is
    // already in flight); false when the result is not yet available (missing on the
    // target indexer, or not yet at confirmation depth) so the caller can park it (M-14).
    async _maybeRelayResult(coin, dispatch){
        let callId = String(dispatch.call_id).toLowerCase();
        let roundId = this._roundId('result', callId);
        if(this._inflight.has(roundId)) return true;   // round already progressing; don't park

        let res;
        try { res = await this._indexerCall(coin, 'getcrosschaincallresult', { call_id: callId }); }
        catch(e){ return false; }
        if(!res || res.exists !== true) return false;

        // Execution must be at confirmation depth on the target chain before the
        // federation vouches for it back to the source chain (a shallow target
        // reorg would otherwise relay an outcome that never finalized).
        let latest = Number(res.latest_block_index);
        let depth  = latest - Number(res.executed_block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[coin]) return false;

        let resultStatus = RESULT_STATUSES.includes(res.status) ? String(res.status) : 'error';

        let snapshotBlock = await this._resolveSnapshotBlock();
        if(snapshotBlock == null) throw new Error('cannot resolve snapshot block');

        let row = {
            round_id:              roundId,
            call_id:               callId,
            phase:                 'result',
            snapshot_block:        Number(snapshotBlock),
            network:               String(dispatch.network),
            source_chain:          String(dispatch.source_chain),
            source_action_index:   Number(dispatch.source_action_index),
            source_contract_index: Number(dispatch.source_contract_index),
            target_chain:          coin,
            target_contract_index: Number(dispatch.target_contract_index),
            method:                String(dispatch.method),
            params_json:           String(dispatch.params_json),
            gas_limit:             Number(dispatch.gas_limit),
            cross_hops:            Number(dispatch.cross_hops) || 0,
            effective_time:        this._relayEffectiveTime(String(dispatch.source_chain)),
            result_status:         resultStatus,
            return_payload_b64:    (res.return_payload_b64 == null) ? '' : String(res.return_payload_b64),
            // Inherit the source generation from the dispatch row so the source-keyed
            // reorg retraction fences this result phase by the same generation.
            push_generation:       Number(dispatch.push_generation) || 0
        };

        let validators = await this._resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);
        this._inflight.add(roundId);
        try {
            await this.consensus.propose(roundId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(roundId);
            throw e;
        }
        return true;   // result found and a relay round proposed; clear any backoff
    }

    // Canonical signing strings. MUST byte-match the indexer's verifiers
    // (xexec.js for dispatch, the callback pass for result). Variable-length
    // fields (params, return payload) enter as sha256 so the canonical stays
    // fixed-arity and '|'-safe.
    // `view` = the live pending.view (consensus) / persisted finalizing_view (twins). At/above
    // the EQUIV flag-day the content is wrapped (TAG=XCALL, ROUND_ID = the sha256 round id,
    // which folds in `phase` so dispatch and result get DISTINCT keys, VIEW=view). The view
    // lives in the header only (not a content field).
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
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, this._roundId(r.phase, r.call_id), (view != null ? view : 0), raw);
        return raw;
    }

    // Independent confirmation a peer runs before signing a leader's proposed
    // row. Dispatch: the request must exist on OUR source-chain indexer, field-
    // for-field, at confirmation depth. Result: the execution outcome must
    // exist on OUR target-chain indexer, byte-for-byte, at confirmation depth.
    // A Byzantine leader cannot get us to sign a relay we can't independently see.
    async validateProposedMatch(row){
        if(!row || !ALLOWED_CHAINS.includes(row.source_chain) || !ALLOWED_CHAINS.includes(row.target_chain)) return false;
        if(row.source_chain === row.target_chain) return false;
        if(String(row.round_id).toLowerCase() !== this._roundId(row.phase, String(row.call_id).toLowerCase())) return false;

        // Canonical integer spellings. These fields are signed verbatim but
        // re-derived from a BIGINT round-trip by xexec.js and the archive verifier, so
        // a leader-supplied '041' would pass every Number()-based check below, collect
        // an honest quorum, and finalize a row whose signatures no verifier can ever
        // rebuild - permanently stranding the call, because _rowExists still sees it.
        // Fail closed BEFORE any numeric comparison; honest leaders build these with
        // Number(), so this never fires on an honest round.
        if(!CANONICAL_INT_FIELDS[row.phase]) return false;
        if(!allCanonicalInts(row, CANONICAL_INT_FIELDS[row.phase])) return false;

        // Leader-choice fields are adopted (not byte-matched) by followers, so
        // bound them: effective_time in a window ahead of our clock, snapshot_block
        // within a day of BTC blocks of our own tip view (when we can resolve
        // one). Pinning an ancient snapshot_block would let a Byzantine leader
        // select a stale validator set for indexer-side signature verification.
        //
        // The window is ASYMMETRIC. The upper guard is the old griefing
        // bound: a far-future row would never settle. The lower guard is a
        // propagation floor: an effective_time at or behind our clock makes the row
        // eligible the instant it finalizes, so an indexer that already holds it
        // injects a block earlier than one still receiving it, and their action-index
        // counters (which feed the call_id preimage) fork for good. A faulty leader,
        // or one whose XCALL_RELAY_MARGIN_BLOCKS was zeroed, is refused here even
        // though its own producer-side floor was bypassed. RELAY_MIN_FUTURE_S is far
        // below any producer margin, so this costs an honest round nothing: it still
        // tolerates 3600 - RELAY_MIN_FUTURE_S seconds of adverse clock skew.
        let now = this._nowSeconds();
        if(!Number.isFinite(Number(row.effective_time)) ||
           Number(row.effective_time) - now > 3600 ||
           Number(row.effective_time) - now < RELAY_MIN_FUTURE_S) return false;
        let myBlock = await this._resolveSnapshotBlock();
        if(myBlock != null && Math.abs(Number(row.snapshot_block) - Number(myBlock)) > 144) return false;

        if(row.phase === 'dispatch') return await this._validateDispatch(row);
        if(row.phase === 'result')   return await this._validateResult(row);
        return false;
    }

    async _validateDispatch(row){
        let res;
        try { res = await this._indexerCall(row.source_chain, 'getcrosschaincall', { call_id: String(row.call_id) }); }
        catch(e){ return false; }
        if(!res || res.exists !== true || !res.call) return false;
        if(String(res.network || '') !== String(row.network || '')) return false;

        let call  = res.call;
        let latest = Number(res.latest_block_index);
        let depth  = latest - Number(call.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[row.source_chain]) return false;

        // Lifecycle gates, mirroring _maybeDispatch. The leader path never
        // even sees an expired or settled request: it polls getpendingcrosschaincalls
        // (SQL-filtered to request_status='pending') and refuses to START a round once
        // the deadline is reached. The follower path re-fetches by call_id through
        // getcrosschaincall, which serves the row whatever its lifecycle state, so
        // without these two lines a round begun just before expiry finalizes after it:
        // honest followers co-sign, the target executes the dispatch, and the source
        // has meanwhile fired the terminal 'expired' callback for the same request.
        // The deadline predicate is the leader's byte-for-byte, so a follower can only
        // ever be as strict as the hub that proposed the round, never stricter.
        if(call.deadline_block != null && Number(call.deadline_block) <= latest) return false;
        if(call.request_status != null && String(call.request_status) !== 'pending') return false;

        return Number(call.action_index)           === Number(row.source_action_index) &&
               Number(call.source_contract_index)  === Number(row.source_contract_index) &&
               String(call.target_chain)           === String(row.target_chain) &&
               Number(call.target_contract_index)  === Number(row.target_contract_index) &&
               String(call.method)                 === String(row.method) &&
               String(call.params_json || '[]')    === String(row.params_json) &&
               Number(call.gas_limit)              === Number(row.gas_limit) &&
               (Number(call.cross_hops) || 0)      === (Number(row.cross_hops) || 0) &&
               // Pin the source-reorg fence generation to the value our own source
               // indexer reports for this call (mirrors the DEX validateProposedMatch
               // per-leg pin). push_generation is stamped onto the row but never
               // enters the signed canonical, so without this a Byzantine leader
               // could inflate it and evade a later source-keyed retraction fence.
               (Number(call.push_generation) || 0) === (Number(row.push_generation) || 0);
    }

    async _validateResult(row){
        // The dispatch row must already be finalized in our own DB (we never
        // vouch for a result of a dispatch we don't know).
        // Treat a retracted dispatch as absent, exactly as the sibling dispatch lookups
        // do (a reorg marks status='retracted' + broadcasts a deletion). Without this
        // filter a follower co-signs a result round bound to a dispatch its own reorg
        // already retracted.
        let d = await this.db.doQuery(
            "SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = 'dispatch' AND status <> 'retracted' LIMIT 1",
            [String(row.call_id).toLowerCase()]);
        if(!d.length) return false;
        if(String(d[0].source_chain) !== String(row.source_chain) ||
           String(d[0].target_chain) !== String(row.target_chain) ||
           String(d[0].network)      !== String(row.network || '')) return false;
        // Pin the dispatch-inherited reorg-fence metadata to our OWN dispatch row.
        // source_action_index and push_generation are NOT in the signed result
        // canonical, yet retractCallsForReorg selects by source_action_index and
        // fences by push_generation. A Byzantine round leader could otherwise stamp
        // a divergent value here; followers would co-sign and persist it, and a
        // later source-chain reorg retraction could then miss the sibling result
        // row while catching the dispatch (breaking the both-phases-retracted
        // invariant). Reject any result row whose inherited metadata does not match
        // the dispatch row we independently finalized.
        if(Number(d[0].source_action_index)   !== Number(row.source_action_index) ||
           Number(d[0].push_generation || 0)  !== Number(row.push_generation || 0)) return false;

        let res;
        try { res = await this._indexerCall(row.target_chain, 'getcrosschaincallresult', { call_id: String(row.call_id) }); }
        catch(e){ return false; }
        if(!res || res.exists !== true) return false;

        let latest = Number(res.latest_block_index);
        let depth  = latest - Number(res.executed_block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[row.target_chain]) return false;

        let resultStatus = RESULT_STATUSES.includes(res.status) ? String(res.status) : 'error';
        let payload = (res.return_payload_b64 == null) ? '' : String(res.return_payload_b64);
        return resultStatus === String(row.result_status) &&
               this._sha256(payload) === this._sha256(String(row.return_payload_b64 == null ? '' : row.return_payload_b64));
    }

    async _writeFinalizedRow(ev){
        let row = ev.row;
        row.validator_signatures = JSON.stringify(ev.signatures || []);
        row.finalizing_view = ev.view != null ? ev.view : 0;   // PBFT view at finalization; signed into the EQUIV canonical
        // EVERY hub persists the capability snapshot for the row's snapshot_block,
        // not just the round leader: the indexers verify the row's signatures
        // against capability_snapshots in whichever hub DB they mirror, and a
        // follower's DB may be the only one they read. Deterministic from BTC
        // stakes + idempotent (INSERT IGNORE), so all hubs write identical rows.
        //
        // FAIL CLOSED, on the rationale CrossChainDexEngine._writeFinalizedMatch spells
        // out in full (item 2385): the persist is a PRECONDITION of the row below, not a
        // best-effort side-write. A swallowed DB throw, or a silent zero-row persist (the
        // sentinel snapshot degrades to [] on an indexer RPC error / 401-403, so the
        // INSERT loop never runs, never throws, never warns), would commit and broadcast
        // a finalized XCALL/XEXEC row whose validator_signatures no capability_snapshot
        // in this hub's DB can verify. On either failure skip the insert/broadcast, drop
        // the in-flight reservation, and forget the finalized round so a later poll
        // re-proposes cleanly, exactly as retractCallsForReorg does. The two engines are
        // kept in lockstep by design; this is the error path that had drifted.
        let persistedRows = 0;
        try {
            persistedRows = await this._persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block), row.network);
        } catch(e){
            console.error('CrossChainCall: snapshot persist on finalize FAILED (fail-closed; deferring ' +
                          row.phase + ' ' + String(row.call_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this._deferFinalize(row);
            return;
        }
        if(!persistedRows){
            console.error('CrossChainCall: snapshot persist wrote ZERO capability rows for snapshot_block ' +
                          row.snapshot_block + ' (degraded/empty validator set; fail-closed, deferring ' +
                          row.phase + ' ' + String(row.call_id).substring(0, 16) + '... to a later round)');
            this._deferFinalize(row);
            return;
        }
        let cols = ['call_id','phase','snapshot_block','network',
                    'source_chain','source_action_index','source_contract_index',
                    'target_chain','target_contract_index','method','params_json',
                    'gas_limit','cross_hops','effective_time','result_status','return_payload_b64',
                    'finalizing_view','validator_signatures','push_generation'];
        let vals = cols.map(c => row[c]);
        // A retracted row for the same (call_id, phase) can exist after a reorg.
        // INSERT IGNORE would silently discard the re-finalized content, leaving
        // the call permanently stranded in 'retracted'. Use ON DUPLICATE KEY UPDATE
        // to overwrite a retracted row with the current quorum's content so the
        // re-mined call can proceed normally.
        let updateCols = cols.filter(c => c !== 'call_id' && c !== 'phase');
        // The row write sits OUTSIDE the recovery the snapshot persist above gets, and it
        // is the same precondition: a throw here means this hub finalized nothing, yet the
        // listener's bare .catch left _inflight set and the round retired in consensus.
        // The round id is derived from phase + call_id alone, so every later dispatch poll
        // returned at `if(this._inflight.has(roundId)) return` and no poll could ever
        // recover the dispatch or the result, even after the DB came back. Defer instead:
        // the upsert wrote nothing, so _rowExists still reports the call open and the next
        // poll re-proposes cleanly.
        try {
            await this.db.doQuery(
                'INSERT INTO cross_chain_calls (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')' +
                ' ON DUPLICATE KEY UPDATE ' + updateCols.map(c => c + ' = VALUES(' + c + ')').join(', ') +
                ", status = 'finalized'",
                vals);
        } catch(e){
            console.error('CrossChainCall: finalized ' + row.phase + ' row write FAILED (fail-closed; deferring ' +
                          String(row.call_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this._deferFinalize(row);
            return;
        }
        // Release the in-flight slot BEFORE the mirror: the row is durable, so a delivery
        // failure must not wedge the round. _mirrorCallRow cannot throw.
        this._inflight.delete(row.round_id);
        await this._mirrorCallRow(row);
        console.log('CrossChainCall: finalized ' + row.phase + ' ' + String(row.call_id).substring(0, 16) + '... ' +
                    row.source_chain + ':' + row.source_action_index + ' -> ' + row.target_chain + ':' + row.target_contract_index +
                    (row.phase === 'result' ? (' [' + row.result_status + ']') : '') +
                    ' (' + (ev.signatures ? ev.signatures.length : 0) + ' sigs)');
        this.emit('call:' + row.phase, { callId: row.call_id });
    }

    // Release a round that finalized in PBFT but whose fail-closed precondition refused
    // the write, so the next poll can re-propose it. Both releases are needed: _inflight
    // gates the poll (`if(this._inflight.has(roundId)) return;`) and the consensus
    // finalized-ring refuses to re-run a round id it has already retired. No 'call:'
    // event is emitted, because nothing was finalized in this hub's DB.
    _deferFinalize(row){
        this._inflight.delete(row.round_id);
        if(this.consensus && typeof this.consensus.forgetFinalized === 'function')
            this.consensus.forgetFinalized(row.round_id);
    }

    // Stream a cross_chain_calls row this hub has ALREADY committed to hub-DB mirror
    // subscribers. Never throws: the row is durable and the in-flight slot released, so a
    // delivery failure must not wedge the round or skip the caller's tail. A throw from
    // the re-read and a zero-row result are the same undeliverable-row event, and
    // dropAllForResync is the sanctioned repair (StateCheckpointEngine
    // ._broadcastRowOrResync and the OracleConsensus price-round path are the in-repo
    // precedents), because the watermark heartbeat would otherwise certify completeness
    // past a committed, quorum-signed call row until the socket happened to reconnect.
    async _mirrorCallRow(row){
        let b = this.broadcaster;
        if(!b) return;
        if(b.subscribers && b.subscribers.size === 0) return;   // nothing to gap
        let failure = null;
        try {
            let read = await this.db.doQuery(
                'SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ? LIMIT 1',
                [row.call_id, row.phase]);
            if(read && read.length){
                b.broadcastRow({ table: 'cross_chain_calls', row: read[0] });
                return;
            }
            failure = 'the committed row read back empty';
        } catch(e){
            failure = (e && e.message) ? e.message : String(e);
        }
        console.error('CrossChainCall: could not stream a committed cross_chain_calls row to mirror ' +
                      'subscribers (' + failure + '); forcing subscriber resync');
        try { if(typeof b.dropAllForResync === 'function') b.dropAllForResync('cross_chain_calls mirror gap'); }
        catch(_e){ /* the repair itself must never fail a committed call row */ }
    }

    // Persist + mirror the qualifying validator set (consensus leader path,
    // same contract as CrossChainDexEngine._persistCapabilitySnapshot).
    // Returns the number of capability rows resolved (and persisted) for this
    // (capability, block). A return of 0 means the set degraded to empty (an
    // indexer RPC error / auth mismatch surfaces as a null snapshot, which
    // _resolveCapabilityValidators normalizes to []) or was refused as truncated,
    // so money-path callers can fail closed rather than committing a row whose
    // signatures no mirror can verify against capability_snapshots.
    async _persistCapabilitySnapshot(capability, block, network){
        let validators = await this._resolveCapabilityValidators(capability, block, network);
        // SWQ-TRUNC-MIRROR: a TRUNCATED set is never mirrored, for the reason
        // spelled out in CrossChainDexEngine._persistCapabilitySnapshot. Mirroring the
        // capped rows would let the off-BTC cross_chain verifiers finalize over an
        // under-counted stake denominator that this hub's own meetsStakeThreshold rejects.
        // Keep the three engines' guards in lockstep.
        if(validators && validators.truncated === true){
            console.warn('CrossChainCall: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return 0;
        }
        // One statement for the whole set: a per-row loop left the mirror PARTIAL on any
        // single INSERT throw, and a partial set has no completeness marker so a verifier
        // reads it as COMPLETE. Rationale in lib/capability_snapshot_write.js. Parity with
        // StateCheckpointEngine and the other four writers.
        let rows = await snapWrite.writeCapabilitySnapshotRows(this.db, capability, block, validators);
        for(let row of rows){
            if(this.broadcaster){
                // Select back on the full widened uq_cap_snap
                // (snapshot_block, capability, signing_pubkey, source). A pubkey-only
                // select-back re-read the SAME row for every source of a delegated key
                // (LIMIT 1), so the mirror stream carried one source and the downstream
                // verifier tallied an under-counted denominator. Inert below SWQ, where
                // source='' and there is one row per key. Parity with StateCheckpointEngine.
                let r = await this.db.doQuery(
                    'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
                    [block, capability, row.signing_pubkey, row.source]);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
    }

    // Source-keyed at/above STAKE_WEIGHTED_QUORUM activation, legacy count set below
    // it (source='' , weight=amount). Mirrors CrossChainDexEngine._resolveCapabilityValidators.
    async _resolveCapabilityValidators(capability, block, network){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0'), amount: String(v.weight != null ? v.weight : '0') }));
                    // Carry the truncation flag through the .map so the consensus fails
                    // closed on an over-cap weighted snapshot (SWQ-TRUNC parity with the
                    // indexer consumers; meetsStakeThreshold under-counts a truncated S).
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

    // Should be unreachable past the confirmation gate; kept as the same
    // defense-in-depth the DEX has. Marks BOTH phases retracted (a dispatch
    // whose request vanished must not produce a callback) and broadcasts a
    // mirror deletion so indexers that have not yet injected skip the rows.
    // The hub row is kept (status='retracted', match model) so the ANCHOR
    // archive re-archives the status drift and recovery never resurrects a
    // retracted call as injectable.
    // toActionIndex (optional) bounds the retraction to a CLOSED range [from, to] for a DEFERRED
    // retraction, so a relay row re-published inside the original open-ended range is not retracted.
    // Absent => open-ended, the live behavior. The bound rides the broadcastDeletion so
    // replicas mirror the same delete.
    // retractionGeneration (optional): when present, only rows stamped push_generation <=
    // it are retracted, so a relay row re-finalized at a recycled source action_index (higher
    // generation, post-rollback) survives even inside [from, to]. Omitted (older indexer) => no fence.
    async retractCallsForReorg(chain, fromActionIndex, toActionIndex, retractionGeneration){
        // Fail-closed on a SUPPLIED-but-invalid bound: a malformed to/generation used to
        // collapse into the absent branch and drop the range/fence clause, and the raw lower bound
        // was bound into SQL where MariaDB coerces a nonnumeric to 0 (retracting the whole chain).
        let bounds = normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration);
        if(bounds.error) throw new Error(bounds.error);
        let { from, to, gen, bounded, fenced } = bounds;
        let tail = " AND source_chain = ? AND source_action_index >= ?" +
                   (bounded ? " AND source_action_index <= ?" : "") +
                   (fenced ? " AND push_generation <= ?" : "");
        let params = [chain, from];
        if(bounded) params.push(to);
        if(fenced) params.push(gen);
        let rows = await this.db.doQuery("SELECT id, call_id, phase FROM cross_chain_calls WHERE status = 'finalized'" + tail, params);
        if(!rows.length) return;
        await this.db.doQuery("UPDATE cross_chain_calls SET status = 'retracted' WHERE status = 'finalized'" + tail, params);
        for(let r of rows){
            let rid = this._roundId(r.phase, String(r.call_id));
            this._inflight.delete(rid);
            // Clear the consensus finalized-ring entry too (M-13): without this the
            // round can never re-run, so a call re-confirmed after this reorg stays
            // stranded in 'retracted'. Also drops any result-relay backoff so the
            // re-confirmed call re-enters the hot poll window immediately.
            this.consensus.forgetFinalized(rid);
            this._resultBackoff.delete(String(r.call_id).toLowerCase());
        }
        if(this.broadcaster){
            let evt = { table: 'cross_chain_calls', source_chain: chain, from_action_index: from };
            if(bounded) evt.to_action_index = to;
            if(fenced) evt.retraction_generation = gen;
            // Quorum-class deletions ride the retraction-signing round when
            // active (2f+1 co-signatures before mirrors will delete); legacy unsigned
            // broadcast otherwise. submitLocal always records the local intent so this
            // hub can co-sign peers' rounds for the same reorg.
            if(this.hub && this.hub.retractionConsensus)
                this.hub.retractionConsensus.submitLocal(evt).catch(e => console.error('CrossChainCall: retraction submit error: ' + (e && e.message)));
            else
                this.broadcaster.broadcastDeletion(evt);
        }
        console.warn('CrossChainCall: retracted ' + rows.length + ' relay row(s) for ' + chain +
                     ' reorg below action ' + from + (bounded ? ' (bounded <= ' + to + ')' : '') +
                     (fenced ? ' (gen <= ' + gen + ')' : '') + ' (should not happen past confirmation depth)');
    }

    async _rowExists(callId, phase){
        let rows = await this.db.doQuery(
            "SELECT 1 FROM cross_chain_calls WHERE call_id = ? AND phase = ? AND status <> 'retracted' LIMIT 1", [callId, phase]);
        return rows.length > 0;
    }

    _roundId(phase, callId){
        return this._sha256('XCALLROUND|' + phase + '|' + callId);
    }

    _sha256(s){
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
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

    _nowSeconds(){ return Math.floor(Date.now() / 1000); }

    // effective_time to stamp on a relayed row: now + a forward margin sized to
    // the chain that GATES the row (dispatch -> the TARGET chain injects the
    // execution; result -> the SOURCE chain delivers the callback). Putting it in
    // the future of every chain's tip guarantees the row is present everywhere
    // before any chain reaches the block it applies at, so a live node and a
    // replaying node always inject at the same block. Capped under the follower
    // clock-skew bound (RELAY_MARGIN_MAX_S) so a large XCALL_RELAY_MARGIN_BLOCKS
    // can never produce a row a peer would reject, and FLOORED at the default
    // margin so XCALL_RELAY_MARGIN_BLOCKS=0 can no longer stamp the bare clock
    // second and re-open the very race the margin exists to close. The
    // operator tunes the margin up; the floor is not tunable, because followers
    // enforce a fixed floor of their own and a hub stamping under it would never
    // collect a quorum.
    _relayEffectiveTime(gatingChain){
        return this._nowSeconds() + relayMarginS(gatingChain, this.relayMarginBlocks);
    }
}

module.exports = CrossChainCallEngine;
