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
 * XChain Hub - Attestation cross-chain relay driver
 *
 * Materializes an LTC/DOGE-origin ATTEST v0 onto BTC as an ATTEST v3, so the
 * existing BTC attestation machinery can service it unchanged.
 *
 * WHY MATERIALIZE INSTEAD OF POLLING THE ORIGIN CHAIN DIRECTLY (spec §12, the
 * model the operator ratified on 2026-07-29): CapabilitySnapshot always keys the
 * responsible set on a BTC block height. A foreign-origin block_index (LTC ~3.16M,
 * DOGE ~6.3M against BTC ~962K) has no deterministic anchor on the BTC plane, so
 * the block-echo determinism check cannot resolve it. Putting the request on BTC
 * as a real action gives it a genuine BTC block_index, and from there the request
 * is indistinguishable from a natively emitted one. This is also why
 * AttestationRound correctly stays BTC-only forever under this model: the
 * materialized row lands in the BTC indexer's own pending queue.
 *
 * The REQUEST leg (origin -> BTC, ATTEST v3):
 *   1. Poll each origin chain's indexer for pending requests it admitted for
 *      relay (origin_chain stamped == that chain, the ATTEST_RELAY_ORIGIN
 *      admission relaxation).
 *   2. Hold each request until it reaches that chain's confirmation depth: a
 *      reorg-able origin request must never be materialized, because the BTC-side
 *      row cannot be retracted.
 *   3. Run a PBFT round over the v3 canonical, pinned at snapshot_block =
 *      hub._resolveBtcLatestBlock(). Each follower re-verifies the origin request
 *      against its OWN origin indexer before signing, so a Byzantine leader
 *      cannot get the federation to vouch for a request nobody else can see.
 *   4. The round leader broadcasts ATTEST v3 on BTC carrying the quorum's
 *      cross_chain signatures.
 *
 * The RESPONSE leg (BTC -> origin, ATTEST v4) closes the round trip:
 *   5. The existing Phase 2 machinery fulfills the materialized request on BTC as
 *      an ordinary ATTEST v1, with local callback injection suppressed because the
 *      contract lives on the origin chain.
 *   6. Poll BTC for the requests it holds as a materialized relay leg, take the ones
 *      carrying a TERMINAL response, hold each to BTC's own confirmation depth, and
 *      run a second PBFT round over the v4 canonical. A follower re-verifies BOTH
 *      ends: the response on its own BTC indexer and the still-pending request on its
 *      own origin indexer.
 *   7. The round leader broadcasts ATTEST v4 on the ORIGIN chain, where the origin
 *      indexer settles the request and fires the contract's callback.
 *
 * The two legs share every mechanism (round rail, capability snapshot, wire-fault
 * screen, spend guard, WAL, rank-ordered failover) and differ only in what they
 * read, what they sign and which chain they broadcast on. Idempotency keys on
 * (request_id, phase), which is why the round id and the WAL both fold the leg in.
 *
 * The `cross_chain` quorum rail (which snapshot, which threshold) is the one
 * xexec.js applies to an XCALL dispatch, mirrored rather than reinvented: both
 * are the same trust decision on the same capability set.
 *
 * WHAT BOUNDS THE AT-MOST-ONCE STATE. Both legs' idempotency sets and the
 * WAL behind them used to grow for the process lifetime: every relayed leg stayed
 * remembered forever, and the WAL was append-only with a whole-file read at startup.
 * The bound is DEADLINE-ANCHORED (the operator's 2026-08-11 ruling, proposal A over
 * proposal B's landed-signal compaction, which would need a confirmation-depth guard
 * or it evicts on indexer lag and re-broadcasts, burning a fee):
 *
 *   - Each leg is indexed by the ORIGIN request's own ABSOLUTE deadline_block, on the
 *     origin chain that issued it. For the request leg that value is read straight off
 *     the origin row the v3 is built from; for the response leg the home chain's
 *     relayed-request row carries no deadline at all, so it is THREADED ONTO THE
 *     RESPONSE ROUND ROW as origin_deadline_block + origin_chain and re-derived by
 *     every follower from its own origin indexer.
 *   - A leg is forgotten only once the ORIGIN chain's tip is past that deadline by the
 *     chain's confirmation depth plus a grace window. That is the point after which no
 *     spend can follow: the origin indexer's expiry sweep has taken the request out of
 *     'pending', and both re-entry paths here (materialize, relay-response) require a
 *     row that is still pending. Forgetting earlier is what would re-broadcast.
 *   - Eviction then COMPACTS the WAL: it is rewritten atomically to one record per
 *     surviving key, so the file tracks the live set instead of the whole history.
 *
 * Opt-in via ATTEST_RELAY_ENABLED=1, default OFF. That default is the response
 * to the deploy-order hazard: v3 and v4 are NEW VERSION values, so an un-upgraded
 * indexer rejects what an upgraded one accepts. If BTC crosses
 * ATTEST_RELAY_ACTIVATION before the whole fleet is upgraded, the correct action
 * is to leave this driver disabled, never to move the constant.
 *
 ********************************************************************/

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');

const eq          = require('./equivocation_header.js');
const swq         = require('./stake_weighted_quorum.js');
const attestRelay = require('./attest_relay_activation.js');
const snapWrite   = require('./lib/capability_snapshot_write.js');
const coins       = require('./coins');

const EncoderClient          = require('./EncoderClient.js');
const SpendGuard             = require('./lib/spend_guard.js');
const CrossChainDexConsensus = require('./CrossChainDexConsensus.js');
const { AtMostOnce, isAmbiguousSendError } = require('./lib/idempotent_broadcast.js');
const { allCanonicalInts } = require('./lib/canonical_int.js');
const { forwardableUtxos } = require('./lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('./lib/two_phase_guard.js');

// The integer fields each relay leg signs VERBATIM and the indexer re-derives with
// parseInt() off the v3/v4 wire. request_id / response_hash are hex, and
// provider_id / status / meta are string compares, so none of them belong here.
const RELAY_CANONICAL_INT_FIELDS = {
    request:  ['snapshot_block', 'origin_action_index', 'redundancy', 'deadline_blocks'],
    response: ['snapshot_block', 'home_response_action_index']
};

// The chain attestation staking lives on, and therefore the only chain a
// responsible set can be keyed on. Must equal HOME_CHAIN in the indexer's attest.js.
const HOME_CHAIN    = 'BTC';
const ORIGIN_CHAINS = coins.ALLOWED_COINS.filter(c => c !== HOME_CHAIN);

const DEFAULT_POLL_MS = 15000;
const PAGE_LIMIT      = 500;   // the indexer's own per-call ceiling
const MAX_PAGES       = 20;    // bounds any one sweep at 10k rows

// The only two TERMINAL response statuses. The retryable ones (no_quorum, timeout,
// provider_error) leave the BTC request pending for another round, so relaying one
// would close an origin request the home chain still intends to fulfill. The origin
// indexer enforces the same list, so anything else is refused there anyway.
const RELAYABLE_STATUSES = ['ok', 'expired'];

// Must equal MAX_DATA_BYTES in xchain-encoder/src/validator.js, as in
// AttestationPublisher: an oversized payload is rejected by createTx, and finding
// that out after the round has finalized wastes the whole round.
const ATTEST_WIRE_MAX_BYTES = 8189;

// How far a leader's proposed snapshot_block may sit from our own view of the BTC
// tip before we refuse to co-sign. Same bound (about a day of BTC blocks) the
// XCALL relay uses: an ancient snapshot_block would let a Byzantine leader select
// a stale cross_chain validator set for the indexer's signature check.
const SNAPSHOT_DRIFT_BLOCKS = 144;

// Wall-clock silence, per rank, before a non-leader steps in and broadcasts the
// round it already co-signed. Rank 0 (the leader) sends immediately; rank 1 waits
// one window, rank 2 two, so a silent leader costs one window, not the request's
// whole deadline. Matches AttestationPublisher's failover shape.
const DEFAULT_FAILOVER_WINDOW_MS = 20 * 60 * 1000;

// How far past an origin request's own absolute deadline_block that chain's tip must
// travel before this driver forgets the request's at-most-once records.
// Added to the chain's confirmation depth, so the total covers both a reorg that
// could un-expire the request and the indexer's own expiry lag: the deadline sweep
// (xchain-indexer getExpiredAttestationRequests) is capped per block, so a batch of
// requests sharing one deadline drains over several blocks rather than all at once.
// Blocks, not wall clock, because the thing being outlived is a chain height.
const DEFAULT_EVICTION_GRACE_BLOCKS = 144;

// Safety valve on the deadline index itself. It is populated only for legs this node
// actually took part in, so it tracks the at-most-once sets rather than the chain, but
// an unbounded map is the very defect being fixed. At the cap new deadlines are
// refused, which costs RETENTION (those legs are never evicted) and never a re-spend.
const MAX_TRACKED_DEADLINES = 50000;

class AttestationRelay {

    constructor(hub){
        this.hub         = hub;
        this.db          = hub.db;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.capSnapshot = hub.capabilitySnapshot || null;
        this.broadcaster = hub.hubDbBroadcaster || null;
        this.network     = (hub && hub.network) ? hub.network : '';

        let cfg = hub.p2pConfig || {};
        this.config = cfg;

        // Opt-in, not a kill switch: a fleet that has merely DEPLOYED this code must
        // run nothing at all. See the deploy-order note in the file header.
        this.enabled = String(process.env.ATTEST_RELAY_ENABLED || cfg.ATTEST_RELAY_ENABLED || '0') === '1';

        this.pollMs = parseInt(process.env.ATTEST_RELAY_POLL_MS || cfg.ATTEST_RELAY_POLL_MS || DEFAULT_POLL_MS);

        // Per-chain confirmation depth, shared with the swap/XCALL engines so an
        // operator tunes ONE depth per chain (mainnet floor-clamped).
        this.confirmations = coins.resolveConfirmations(cfg, this.network);

        this.failoverWindowMs = parseInt(process.env.ATTEST_RELAY_FAILOVER_MS ||
                                         cfg.ATTEST_RELAY_FAILOVER_MS || DEFAULT_FAILOVER_WINDOW_MS);

        // Origin blocks past a request's deadline before its records are evicted.
        // A garbage or negative value falls back rather than shrinking the
        // window: this is the guard that stops an early eviction from re-spending.
        this.evictGraceBlocks = parseInt(process.env.ATTEST_RELAY_EVICT_GRACE_BLOCKS ||
                                         cfg.ATTEST_RELAY_EVICT_GRACE_BLOCKS || DEFAULT_EVICTION_GRACE_BLOCKS);
        if(!Number.isFinite(this.evictGraceBlocks) || this.evictGraceBlocks < 0)
            this.evictGraceBlocks = DEFAULT_EVICTION_GRACE_BLOCKS;

        // Per-coin indexer endpoints; filled from the hub's configs-aware resolver
        // in start() for hubs provisioned without env vars.
        this.indexers = {};
        for(let coin of [HOME_CHAIN, ...ORIGIN_CHAINS]){
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_API_URL'] || process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        // BTC (home) broadcast rail, for the v3 request leg. Mirrors
        // AttestationPublisher: an operator signer hook wins, otherwise the
        // encoder + wallet-sign pipeline.
        let encoderUrl = process.env.BTC_ENCODER_URL || cfg.BTC_ENCODER_URL || '';
        let encoderKey = process.env.BTC_ENCODER_API_KEY || cfg.BTC_ENCODER_API_KEY || '';
        this.encoder      = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;
        this.btcAddress   = process.env.BTC_ADDRESS    || cfg.BTC_ADDRESS    || '';
        this.btcPubkeyHex = process.env.BTC_PUBKEY_HEX || cfg.BTC_PUBKEY_HEX || '';
        this.broadcastFn  = null;
        this.walletSignFn = null;

        // ORIGIN-chain broadcast rails, for the v4 response leg. Every other hub
        // publisher is single-chain (the oracle publishes on DOGE, the attestation
        // publisher on BTC), so this is the first rail that has to pick a chain at
        // send time, and it is deliberately kept SEPARATE from the home rail rather
        // than generalized over it. An operator's HUB_SIGNER_MODULE broadcast hook
        // does its own build/sign/send on the ONE chain it was configured for; handing
        // it an LTC payload would put a v4 on BTC, where it is rejected outright
        // ('relay responses land on origin chains only') after burning a real BTC fee.
        // So the home hooks never serve an origin chain: an origin rail exists only
        // where the operator configured <COIN>_ENCODER_URL + <COIN>_ADDRESS, or wired
        // setChainBroadcastHook(coin, fn) explicitly.
        //
        // The wallet-sign hook DOES fall back to the shared one, because signing is
        // chain-agnostic in shape and the config above is already the explicit opt-in.
        // It is called as fn(psbtHex, coin) so a multi-chain operator module can pick
        // the right key; a single-key module ignores the argument and produces a
        // signature the origin node rejects, which surfaces as an 'Encoder RPC error'
        // and is therefore classified NOT ambiguous and stays retryable.
        this.chainRails = {};
        for(let coin of ORIGIN_CHAINS){
            let url = process.env[coin + '_ENCODER_URL'] || cfg[coin + '_ENCODER_URL'] || '';
            let key = process.env[coin + '_ENCODER_API_KEY'] || cfg[coin + '_ENCODER_API_KEY'] || '';
            this.chainRails[coin] = {
                encoder:      url ? new EncoderClient(url, key) : null,
                address:      process.env[coin + '_ADDRESS']    || cfg[coin + '_ADDRESS']    || '',
                pubkeyHex:    process.env[coin + '_PUBKEY_HEX'] || cfg[coin + '_PUBKEY_HEX'] || '',
                broadcastFn:  null,
                walletSignFn: null
            };
        }

        this.spendGuard = new SpendGuard('ATTEST_RELAY', cfg, 'AttestationRelay');

        // Durable at-most-once record of v3 broadcasts. A duplicate v3 is rejected
        // on-chain ('REQUEST_ID already present'), so replaying one only burns a real
        // BTC fee; the WAL is what stops a restart from doing that. See _loadWal for
        // why a crash between intent and outcome is treated as sent.
        this.walPath   = process.env.ATTEST_RELAY_QUEUE_PATH || cfg.ATTEST_RELAY_QUEUE_PATH || './data/attest-relay-queue.jsonl';
        this._published = new AtMostOnce();

        // The response leg's own at-most-once set. Idempotency keys on
        // (request_id, phase), so the two legs never share a slot: one request_id
        // legitimately gets one v3 AND one v4.
        this._publishedResponses = new AtMostOnce();

        // Rounds finalized but not yet observed on their destination chain:
        // request_id -> { wire, rid, coin, phase, finalizedAt, rank }. Drives the
        // rank-ordered failover step-in. One map per leg, same reason as above.
        this._finalizedWire     = new Map();
        this._finalizedResponse = new Map();

        // Round ids in PBFT but not yet finalized (mirrors CrossChainCallEngine).
        this._inflight = new Set();

        // request_ids currently present in the home chain's pending queue, refreshed
        // once per poll: a v3 that lands shows up here immediately.
        this._homePending = new Set();

        // request_ids the home chain holds as a materialized relay leg at ANY status,
        // from the relayed-requests read. This is the authoritative "already
        // materialized" answer and _homePending is the narrower one: a fulfilled or
        // expired BTC row leaves the pending queue while the ORIGIN row stays pending
        // until the v4 lands, and on the pending view alone that window reads as never
        // materialized and draws a duplicate v3 (rejected on chain, fee spent). Both
        // are kept and OR'd because each is refreshed independently and each fails
        // closed by retaining its previous value, so either surviving a failed read
        // still suppresses the duplicate.
        this._homeRelayed = new Set();

        // Per-origin pending views, request_id -> row, same role for the response leg:
        // a v4 that lands flips its origin request out of 'pending', so this is the
        // authoritative "already relayed back" signal and it also catches a PEER's
        // broadcast. The rows are kept, not just the ids, so the leg can be checked
        // against the ORIGIN's own copy of the request before a round is proposed.
        // null means "not refreshed this tick": that chain's response leg is then
        // skipped entirely rather than acted on blind.
        this._originPending = {};
        for(let coin of ORIGIN_CHAINS) this._originPending[coin] = null;

        // request_id -> { coin, block }: the ABSOLUTE deadline_block of the
        // origin request behind a leg, on the chain that issued it. This is what the
        // at-most-once sets are evicted against, and it is deliberately keyed on the
        // request rather than on (leg, request): one request has ONE origin deadline,
        // and when it passes, both of its legs are equally dead.
        this._deadlines = new Map();

        // Last tip observed on each origin chain, from the same paged read the pending
        // views come from. Only ever written from a SUCCESSFUL read: an unread chain
        // must stall eviction, never advance it.
        this._originLatest = {};

        this.consensus = new CrossChainDexConsensus(this, {
            messageTypes: {
                PROPOSE:     'ATTEST_RELAY_PROPOSE',
                PREPARE:     'ATTEST_RELAY_PREPARE',
                COMMIT:      'ATTEST_RELAY_COMMIT',
                VIEW_CHANGE: 'ATTEST_RELAY_VIEW_CHANGE',
                NEW_VIEW:    'ATTEST_RELAY_NEW_VIEW',
                FINAL_SYNC:  'ATTEST_RELAY_FINAL_SYNC'
            },
            controlTags: { vc: 'ATTRELAYVC', nv: 'ATTRELAYNV' },
            idField: 'round_id'
        });
        this.consensus.on('match:finalized', (ev) => {
            this._onRoundFinalized(ev).catch(err =>
                console.error('AttestationRelay: finalize handler error: ' + (err && err.message)));
        });
        // An abandoned round must release its inflight slot or the request wedges:
        // the poll's inflight guard would skip it forever.
        this.consensus.on('match:abandoned', (ev) => {
            this._inflight.delete(String(ev.matchId));
        });

        this._pollTimer = null;
        this._polling   = false;

        this._broadcastSucceeded = 0;
        this._broadcastFailed    = 0;
        this._walFailures        = 0;
        this._evicted            = 0;
        this._walCompactions     = 0;
    }

    setBroadcastHook(fn){ this.broadcastFn  = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setEncoder(encoder){ this.encoder = encoder; }

    // Per-origin-chain wiring for the v4 leg. Separate setters rather than an
    // overload of the home ones, for the reason spelled out on chainRails.
    setChainBroadcastHook(coin, fn){  if(this.chainRails[coin]) this.chainRails[coin].broadcastFn  = fn; }
    setChainWalletSignHook(coin, fn){ if(this.chainRails[coin]) this.chainRails[coin].walletSignFn = fn; }
    setChainEncoder(coin, encoder){   if(this.chainRails[coin]) this.chainRails[coin].encoder      = encoder; }

    async start(){
        if(!this.enabled){
            console.log('AttestationRelay: disabled (set ATTEST_RELAY_ENABLED=1 to opt in); cross-chain relay inactive');
            return;
        }
        if(!this.peerManager){
            console.log('AttestationRelay: no peer manager; skipping start');
            return;
        }

        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers)){
                if(this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u) this.indexers[coin].url = u;
                } catch(_){ /* unresolvable: warned below */ }
            }
        }
        for(const coin of Object.keys(this.indexers)){
            if(!this.indexers[coin].url)
                console.warn('AttestationRelay: no indexer URL for ' + coin + ' (set ' + coin +
                    '_INDEXER_API_URL, or push it via xchain-node updateconfig); this chain is skipped every tick');
        }

        let wal = this._loadWal();
        // Fold the file down as soon as it carries more than one record per
        // surviving key. Without this a long-lived hub re-reads (whole-file, readFileSync)
        // an ever-growing history of intent/sent/failed pairs at every restart, even on a
        // fleet whose legs all evict cleanly.
        if(wal.records > wal.keys) this._compactWal('startup');
        // The WAL kept at-most-once sends across a restart, but the spend
        // ceilings behind them did not; reload the saved window from the same idiom.
        this.spendGuard.persistTo();
        await this.consensus.start();

        this._pollTimer = setInterval(() => {
            this._poll().catch(err => console.error('AttestationRelay: poll error: ' + (err && err.message)));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();

        for(let coin of ORIGIN_CHAINS){
            if(!this._getBroadcaster(coin))
                console.warn('AttestationRelay: no ' + coin + ' broadcast rail (set ' + coin + '_ENCODER_URL + ' +
                    coin + '_ADDRESS, or wire setChainBroadcastHook); relay RESPONSES for ' + coin +
                    '-origin requests are held, never dropped');
        }

        console.log('AttestationRelay: started (poll ' + this.pollMs + 'ms, origins ' +
                    ORIGIN_CHAINS.map(c => c + '=' + this.confirmations[c] + ' conf').join(' ') +
                    ', home ' + HOME_CHAIN + '=' + this.confirmations[HOME_CHAIN] + ' conf, ' +
                    this._published.size + ' request(s) and ' + this._publishedResponses.size +
                    ' response(s) already relayed per the WAL)');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        if(this.consensus) await this.consensus.stop();
        this._finalizedWire.clear();
        this._finalizedResponse.clear();
        this._homePending.clear();
        this._homeRelayed.clear();
        for(let coin of ORIGIN_CHAINS) this._originPending[coin] = null;
        this._polling = false;
    }

    getStats(){
        return {
            enabled:              this.enabled,
            broadcast_succeeded:  this._broadcastSucceeded,
            broadcast_failed:     this._broadcastFailed,
            wal_failures:         this._walFailures,
            relayed_count:        this._published.size,
            responses_relayed:    this._publishedResponses.size,
            awaiting_broadcast:   this._finalizedWire.size + this._finalizedResponse.size,
            inflight_rounds:      this._inflight.size,
            // The three numbers that show the bound is working. tracked_deadlines
            // is the eviction index; legs_evicted and wal_compactions should both climb on
            // a fleet that is actually relaying, and a flat legs_evicted next to a rising
            // relayed_count means deadlines are not reaching the index.
            tracked_deadlines:    this._deadlines.size,
            legs_evicted:         this._evicted,
            wal_compactions:      this._walCompactions,
            spend_guard:          this.spendGuard.stats()
        };
    }

    async _poll(){
        if(this._polling) return;
        this._polling = true;
        try {
            // Read both home views BEFORE either leg acts, then act. The order is not
            // cosmetic: the request leg must see this tick's home relay state or it
            // re-materializes a request BTC has already fulfilled, and the response leg
            // must see this tick's origin pending sets, since an origin request still
            // pending is precisely one still owed its v4.
            await this._refreshHomePending();
            let home = await this._refreshHomeRelayed();
            for(let coin of ORIGIN_CHAINS){
                if(!this.indexers[coin] || !this.indexers[coin].url) continue;
                try { await this._pollOriginRequests(coin); }
                catch(e){ console.warn('AttestationRelay: ' + coin + ' poll failed: ' + (e && e.message)); }
            }
            if(home){
                try { await this._relayHomeResponses(home); }
                catch(e){ console.warn('AttestationRelay: response relay pass failed: ' + (e && e.message)); }
            }
            await this._sweepFinalized();
            // Last, on the tips this tick just read: a leg is only evictable once its
            // origin chain has buried the request's deadline, so eviction wants the
            // freshest view and must never run ahead of the legs it might retire.
            this._evictExpired();
        } finally {
            this._polling = false;
        }
    }

    // Page a federation list read to exhaustion under the keyset cursor both attest
    // reads expose. Returns ok:false when the indexer is unreachable, which every
    // caller treats as "keep the previous view" rather than "the set is empty":
    // acting on a blind view is what double-broadcasts a fee.
    async _fetchAllPages(coin, method, listField){
        let rows   = [];
        let latest = null;
        let cursor = null;
        for(let page = 0; page < MAX_PAGES; page++){
            let params = { limit: PAGE_LIMIT };
            if(cursor){
                params.after_block_index  = cursor.block_index;
                params.after_action_index = cursor.action_index;
            }
            let res;
            try { res = await this._indexerCall(coin, method, params); }
            catch(e){ return { ok: false, rows: [], latest: null }; }
            if(!res || !Array.isArray(res[listField])) return { ok: false, rows: [], latest: null };
            if(page === 0) latest = Number(res.latest_block_index);
            let pageRows = res[listField];
            rows = rows.concat(pageRows);
            if(pageRows.length < PAGE_LIMIT) break;
            let last = pageRows[pageRows.length - 1];
            cursor = { block_index: Number(last.block_index), action_index: Number(last.action_index) };
        }
        return { ok: true, rows: rows, latest: latest };
    }

    // Snapshot the home chain's pending request_ids. A materialized v3 lands here the
    // moment it is indexed (as an ordinary pending request row), which is why this is
    // kept alongside the wider _homeRelayed view: it answers "already materialized"
    // from a second, independently refreshed source, and from the chain itself rather
    // than from local bookkeeping, so it also covers a v3 broadcast by a PEER.
    async _refreshHomePending(){
        if(!this.indexers[HOME_CHAIN] || !this.indexers[HOME_CHAIN].url) return;
        let res = await this._fetchAllPages(HOME_CHAIN, 'getpendingattestation_requests', 'requests');
        if(!res.ok) return;   // home indexer unreachable: keep the previous view rather than relaying blind
        this._homePending = new Set(res.rows.map(r => String(r.request_id || '').toLowerCase()));
    }

    async _pollOriginRequests(coin){
        let res = await this._fetchAllPages(coin, 'getpendingattestation_requests', 'requests');
        if(!res.ok){
            // Same fail-closed stance as the home view, and it is what makes the
            // response leg safe: a stale-but-absent origin row would read as "the v4
            // already landed" and silently retire a relay that never happened.
            this._originPending[coin] = null;
            return;
        }
        this._originPending[coin] = new Map(res.rows.map(r => [String(r.request_id || '').toLowerCase(), r]));

        let latest = Number(res.latest);
        if(!Number.isFinite(latest)) return;
        // The tip the eviction pass measures this chain's deadlines against.
        this._originLatest[coin] = latest;
        for(let req of res.rows){
            try { await this._maybeMaterialize(coin, latest, req); }
            catch(e){
                console.warn('AttestationRelay: materialize attempt failed for ' +
                    String(req && req.request_id).substring(0, 16) + '...: ' + (e && e.message));
            }
        }
    }

    // The response leg's discovery half, and the request leg's authoritative
    // already-materialized view. The home indexer answers with every request it holds
    // as a materialized relay leg, each carrying its terminal response when one
    // exists; a row that carries one is work this driver owes back to an origin chain.
    // Returns the rows for the acting pass, or null when the read failed, which leaves
    // the previous view standing rather than relaying blind.
    async _refreshHomeRelayed(){
        if(!this.indexers[HOME_CHAIN] || !this.indexers[HOME_CHAIN].url) return null;
        let res = await this._fetchAllPages(HOME_CHAIN, 'getrelayedattestation_requests', 'requests');
        if(!res.ok) return null;
        this._homeRelayed = new Set(res.rows.map(r => String(r.request_id || '').toLowerCase()));
        return res;
    }

    async _relayHomeResponses(home){
        let latest = Number(home.latest);
        if(!Number.isFinite(latest)) return;
        for(let row of home.rows){
            if(row.response_action_index == null) continue;   // nothing fulfilled yet
            try { await this._maybeRelayResponse(latest, row); }
            catch(e){
                console.warn('AttestationRelay: response relay attempt failed for ' +
                    String(row && row.request_id).substring(0, 16) + '...: ' + (e && e.message));
            }
        }
    }

    async _maybeRelayResponse(latestHomeBlock, res){
        let rid = String(res.request_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(rid)) return;

        let coin = String(res.origin_chain || '');
        if(ORIGIN_CHAINS.indexOf(coin) === -1) return;
        if(!this.indexers[coin] || !this.indexers[coin].url) return;

        // The origin must still be waiting for it. A refresh that failed leaves the
        // set null, and a null set is not evidence of anything, so the chain waits a
        // tick rather than being relayed to blind.
        let pending = this._originPending[coin];
        if(!pending || !pending.has(rid)) return;
        let originReq = pending.get(rid);

        // Index the origin's ABSOLUTE deadline BEFORE the already-relayed guards below.
        // Eviction can only forget a record it holds a deadline for, and the
        // record most in need of forgetting is precisely one already marked published:
        // indexing after those returns would leave every relayed leg pinned forever.
        this._noteDeadline(coin, rid, originReq && originReq.deadline_block);

        // Same horizon, same reason as the request leg, and here it also saves a real
        // fee outright: the origin indexer rejects a v4 for a request past its own
        // deadline_block ('invalid: REQUEST expired'), so the broadcast could only burn.
        if(this._pastEvictionHorizon(coin, originReq && originReq.deadline_block)) return;

        if(this._publishedResponses.has(rid)) return;
        if(this._finalizedResponse.has(rid)) return;

        // BTC confirmation depth on the RESPONSE row, not the request. The v4 closes
        // the origin request irreversibly, so relaying a response that a BTC reorg can
        // still take back would leave the origin settled against a fulfillment the
        // home chain no longer has.
        let depth = latestHomeBlock - Number(res.response_block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[HOME_CHAIN]) return;

        let roundId = this._roundId('response', rid);
        if(this._inflight.has(roundId)) return;

        let snapshotBlock = await this._resolveSnapshotBlock();
        if(snapshotBlock == null) return;
        if(!attestRelay.isAttestRelayActive(snapshotBlock, this.network)){
            this._logGateOnce(snapshotBlock);
            return;
        }

        let fields = this._responseFieldsFromHome(res);
        if(!fields) return;

        // The origin indexer builds its canonical from ITS OWN request row's
        // provider_id, so the two copies must agree or every peer refuses the round
        // and it wedges silently. They agree by construction (the v3 carried the
        // provider from the origin), which is exactly why a disagreement is worth
        // saying out loud rather than proposing into a round that cannot finalize.
        if(originReq && String(originReq.provider_id || '') !== fields.providerId){
            console.error('AttestationRelay: refusing to relay ' + rid.substring(0, 16) +
                          '...: ' + coin + ' names provider "' + originReq.provider_id +
                          '" but ' + HOME_CHAIN + ' holds "' + fields.providerId + '"');
            return;
        }

        let row = {
            round_id:                   roundId,
            request_id:                 rid,
            phase:                      'response',
            snapshot_block:             Number(snapshotBlock),
            network:                    this.network,
            origin_chain:               coin,
            // The operator's proposal-A record-shape change. The home chain's
            // relayed-request row carries no deadline of its own (the v3 put a RELATIVE
            // block count on BTC), so the origin's absolute deadline_block travels on the
            // round row, paired with the origin_chain it is a height on. It is BOOKKEEPING,
            // NOT CONSENSUS: it is deliberately absent from _relayResponseCanonical, which
            // must byte-match the indexer's, and every follower re-derives it from its own
            // origin indexer instead of trusting the leader's copy.
            origin_deadline_block:      this._absoluteOriginDeadline(originReq),
            home_response_action_index: fields.homeResponseActionIndex,
            provider_id:                fields.providerId,
            response_hash:              fields.responseHash,
            response_payload_b64:       fields.payloadB64,
            status:                     fields.status,
            meta:                       fields.meta
        };

        let wireFault = this._wireFault(row, 1);
        if(wireFault){
            console.error('AttestationRelay: cannot relay the response for ' + rid.substring(0, 16) + '... : ' + wireFault);
            return;
        }

        let validators = await this._resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);
        this._inflight.add(roundId);
        try {
            await this.consensus.propose(roundId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(roundId);
            throw e;
        }
    }

    // Project a home relayable-response row onto the v4 wire fields, or null when the
    // response cannot be relayed faithfully.
    //
    // THE BODY MUST SURVIVE A ROUND TRIP. The indexer stores response_payload as the
    // UTF-8 DECODE of the bytes the v1 carried and hashes those raw bytes, so a
    // non-UTF-8 attested body cannot be re-encoded to the same bytes: base64 of the
    // stored text would deliver a MANGLED payload to the origin contract, under a
    // quorum signature. The stored response_hash is what makes that detectable, and a
    // mismatch refuses the relay outright. Such a request expires on the origin's own
    // deadline, which is the honest outcome.
    _responseFieldsFromHome(res){
        let homeResponseActionIndex = Number(res.response_action_index);
        let providerId              = String(res.provider_id || '');
        let status                  = String(res.response_status || '');
        let meta                    = (res.meta == null) ? '' : String(res.meta);
        let payload                 = (res.response_payload == null) ? '' : String(res.response_payload);

        if(!Number.isInteger(homeResponseActionIndex) || homeResponseActionIndex <= 0) return null;
        if(!providerId) return null;
        if(RELAYABLE_STATUSES.indexOf(status) === -1) return null;

        let bytes        = Buffer.from(payload, 'utf8');
        let payloadB64   = bytes.toString('base64');
        let responseHash = crypto.createHash('sha256').update(bytes).digest('hex');

        let stored = String(res.response_hash || '').toLowerCase();
        if(stored && stored !== responseHash){
            console.error('AttestationRelay: refusing to relay ' + String(res.request_id).substring(0, 16) +
                          '...: the stored response body does not re-encode to its own hash ' +
                          '(a non-UTF-8 attested body cannot cross chains)');
            return null;
        }

        return { homeResponseActionIndex, providerId, status, meta, payloadB64, responseHash };
    }

    async _maybeMaterialize(coin, latestBlock, req){
        let rid = String(req.request_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(rid)) return;

        // Only a request this chain admitted FOR RELAY is ours to materialize. A
        // native request on an origin chain (there are none today, since an empty
        // responsible set rejects it at admission) carries no origin_chain stamp.
        if(String(req.origin_chain || '') !== coin) return;

        // Index the absolute deadline BEFORE the already-relayed guards, for the reason
        // spelled out in _maybeRelayResponse: the record that most needs evicting is one
        // this node has already published, and those returns are hit on every later tick.
        this._noteDeadline(coin, rid, req.deadline_block);

        // Never materialize a request whose deadline the origin has already buried. This
        // is the same horizon eviction uses, and it is what makes eviction safe: a
        // forgotten key cannot come back through this path and spend a second fee. The
        // request is dead anyway (the origin's expiry sweep is simply behind).
        if(this._pastEvictionHorizon(coin, req.deadline_block)) return;

        if(this._published.has(rid)) return;
        if(this._homeHasRequest(rid)) return;
        if(this._finalizedWire.has(rid)) return;

        let depth = latestBlock - Number(req.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[coin]) return;

        let roundId = this._roundId('request', rid);
        if(this._inflight.has(roundId)) return;

        let snapshotBlock = await this._resolveSnapshotBlock();
        if(snapshotBlock == null) return;

        // The flag-day gate, evaluated on the BTC-anchored snapshot we are about to
        // pin. Below it the fleet's indexers reject a v3 outright, so proposing a
        // round would only burn a BTC fee on a guaranteed-invalid action.
        if(!attestRelay.isAttestRelayActive(snapshotBlock, this.network)){
            this._logGateOnce(snapshotBlock);
            return;
        }

        let fields = this._relayFieldsFromOrigin(coin, req);
        if(!fields) return;

        let row = {
            round_id:            roundId,
            request_id:          rid,
            phase:               'request',
            snapshot_block:      Number(snapshotBlock),
            network:             this.network,
            origin_chain:        coin,
            origin_action_index: fields.originActionIndex,
            provider_id:         fields.providerId,
            request_payload:     fields.requestPayload,
            redundancy:          fields.redundancy,
            deadline_blocks:     fields.deadlineBlocks
        };

        // Reject here rather than after finalization: the wire is assembled from the
        // signed fields, so an oversized or unsplittable payload dooms the round.
        let wireFault = this._wireFault(row, 1);
        if(wireFault){
            console.error('AttestationRelay: cannot materialize ' + rid.substring(0, 16) + '... : ' + wireFault);
            return;
        }

        let validators = await this._resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);
        this._inflight.add(roundId);
        try {
            await this.consensus.propose(roundId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(roundId);
            throw e;
        }
    }

    // Project an origin pending-request row onto the v3 wire fields, or null when it
    // cannot be represented. DEADLINE travels as a BLOCK COUNT because the BTC-side
    // deadline must be relative to the v3's own BTC height; the origin's absolute
    // deadline_block is a height on a different chain. The count is NOT rescaled for
    // the chains' differing block intervals: the indexer's provider deadline window
    // is the authority on what BTC-side span is acceptable and rejects the rest.
    _relayFieldsFromOrigin(coin, req){
        let originActionIndex = Number(req.action_index);
        let redundancy        = Number(req.redundancy);
        let deadlineBlocks    = Number(req.deadline_block) - Number(req.block_index);
        let providerId        = String(req.provider_id || '');
        let requestPayload    = (req.payload == null) ? '' : String(req.payload);

        if(!Number.isInteger(originActionIndex) || originActionIndex <= 0) return null;
        if(!Number.isInteger(redundancy) || redundancy < 1) return null;
        if(!Number.isInteger(deadlineBlocks) || deadlineBlocks <= 0) return null;
        if(!providerId) return null;

        return { originActionIndex, redundancy, deadlineBlocks, providerId, requestPayload };
    }

    // Fields reach the chain through a positional `split('|')` with no escaping
    // (xchain-indexer/src/actions.js), so a literal pipe anywhere in a variable field
    // silently shifts every field after it. Such a request cannot be relayed at all;
    // it expires on its origin deadline, which is the honest outcome versus spending
    // a BTC fee on an action every indexer will misparse.
    _wireFault(row, sigCount){
        let response = (row.phase === 'response');
        // v4 carries the body as base64, whose alphabet excludes '|', so only the
        // free-form META can shift the positional fields on that leg.
        let variable = response
            ? [['META', row.meta == null ? '' : row.meta]]
            : [['PROVIDER_ID', row.provider_id], ['REQUEST_PAYLOAD', row.request_payload]];
        for(let [name, value] of variable){
            if(String(value).indexOf('|') !== -1)
                return name + ' contains a "|", which the positional wire cannot carry';
        }
        let stub  = new Array(sigCount).fill({ pubkey: '0'.repeat(64), sig: '0'.repeat(128) });
        let wire  = response ? this._buildResponseWire(row, stub) : this._buildRequestWire(row, stub);
        let bytes = Buffer.byteLength(wire, 'utf8');
        if(bytes > ATTEST_WIRE_MAX_BYTES)
            return 'ATTEST v' + (response ? '4' : '3') + ' wire is ' + bytes + ' bytes with ' + sigCount +
                   ' signature(s), over the encoder limit of ' + ATTEST_WIRE_MAX_BYTES;
        return null;
    }

    // ----- canonical (the cross-service contract) -----

    // MUST byte-match the indexer's Attest._relayRequestCanonical /
    // _relayResponseCanonical. A one-byte disagreement is not a visible failure: the
    // signatures simply never verify and every peer's v3 is dropped as unquorate.
    // Pinned by xchain-indexer/test/unit/actions/attest-relay.test.js and cross-checked
    // against the indexer's own implementation in AttestationRelay.canonical.test.js.
    //
    // `view` is deliberately IGNORED. The EQUIV header's VIEW is pinned at 0 because
    // the on-chain action carries no view field, so a verifier replaying the action
    // has no way to learn one. The signature therefore stays valid across a PBFT view
    // change, which is correct here: the round's VALUE never changes with the view.
    _canonicalMatch(row, view){   // eslint-disable-line no-unused-vars
        if(row.phase === 'response') return this._relayResponseCanonical(row);
        return this._relayRequestCanonical(row);
    }

    _relayRequestCanonical(r){
        let raw = [
            'ATTEST', 'RELAY_REQUEST', String(r.request_id), String(r.snapshot_block), String(r.network),
            String(r.origin_chain), String(r.origin_action_index), String(r.provider_id),
            this._sha256(r.request_payload == null ? '' : r.request_payload),
            String(r.redundancy), String(r.deadline_blocks)
        ].join('|');
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST,
                this._sha256('ATTESTRELAY|request|' + String(r.request_id)), 0, raw);
        return raw;
    }

    // The response leg's canonical. Note the asymmetry with the request leg: the
    // response body enters ALREADY HASHED, and the indexer hashes the raw
    // base64-DECODED bytes, not the base64 text, which is why _responseFieldsFromHome
    // hashes the bytes it is about to encode rather than the string it read.
    _relayResponseCanonical(r){
        let raw = [
            'ATTEST', 'RELAY_RESPONSE', String(r.request_id), String(r.snapshot_block), String(r.network),
            String(r.origin_chain), String(r.home_response_action_index), String(r.provider_id),
            String(r.response_hash), String(r.status), String(r.meta == null ? '' : r.meta)
        ].join('|');
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST,
                this._sha256('ATTESTRELAY|response|' + String(r.request_id)), 0, raw);
        return raw;
    }

    // ----- follower verification -----

    // What a peer checks before co-signing a leader's proposed row. The federation
    // must never vouch for a leg it cannot independently reconstruct from its OWN
    // indexers, which is the same fail-closed stance the XCALL relay takes. Anything
    // unrecognised is refused rather than falling through to a permissive default.
    async validateProposedMatch(row){
        if(!row) return false;
        // Canonical integer spellings. These fields are signed verbatim into
        // _relayRequestCanonical / _relayResponseCanonical and ride the v3/v4 wire, but
        // the indexer re-parses them with parseInt() before rebuilding the canonical it
        // verifies against. A leader-supplied '041' therefore passes the Number()-based
        // field checks below, collects an honest quorum, and lands an action the origin
        // chain stores as invalid ('cross_chain quorum') with no path to re-relay: the
        // request sits until its deadline expires. Fail closed before either leg runs.
        if(!RELAY_CANONICAL_INT_FIELDS[row.phase]) return false;
        if(!allCanonicalInts(row, RELAY_CANONICAL_INT_FIELDS[row.phase])) return false;
        if(row.phase === 'request')  return await this._validateRequestRow(row);
        if(row.phase === 'response') return await this._validateResponseRow(row);
        return false;
    }

    // Checks common to both legs: the row identifies itself consistently, its round
    // id binds the leg it claims to be, and the leader's snapshot choice is close
    // enough to our own tip view. An ancient snapshot_block would let a Byzantine
    // leader select a stale cross_chain validator set for the indexer's check.
    async _validateRowEnvelope(row, phase, rid){
        if(!/^[0-9a-f]{64}$/.test(rid)) return false;
        if(ORIGIN_CHAINS.indexOf(String(row.origin_chain)) === -1) return false;
        if(String(row.network || '') !== String(this.network || '')) return false;
        if(String(row.round_id).toLowerCase() !== this._roundId(phase, rid)) return false;
        if(!attestRelay.isAttestRelayActive(row.snapshot_block, this.network)) return false;
        let myBlock = await this._resolveSnapshotBlock();
        if(myBlock != null && Math.abs(Number(row.snapshot_block) - Number(myBlock)) > SNAPSHOT_DRIFT_BLOCKS) return false;
        return true;
    }

    async _validateRequestRow(row){
        let rid = String(row.request_id || '').toLowerCase();
        if(!await this._validateRowEnvelope(row, 'request', rid)) return false;

        // A request already on the home chain must not be materialized twice; the
        // indexer would reject the duplicate, so co-signing it only wastes a fee.
        if(this._homeHasRequest(rid)) return false;

        let coin = String(row.origin_chain);
        let res  = await this._fetchAllPages(coin, 'getpendingattestation_requests', 'requests');
        if(!res.ok) return false;

        let mine = res.rows.find(r => String(r.request_id || '').toLowerCase() === rid);
        if(!mine) return false;
        if(String(mine.origin_chain || '') !== coin) return false;

        // The request leg needs no deadline field on the row: this node is looking at
        // the origin row itself, which carries the absolute deadline. Index it here so a
        // node that only ever CO-SIGNS (and therefore never runs _maybeMaterialize for
        // this request) can still evict the record its own broadcast may create.
        this._noteDeadline(coin, rid, mine.deadline_block);
        if(Number.isFinite(Number(res.latest))) this._originLatest[coin] = Number(res.latest);
        if(this._pastEvictionHorizon(coin, mine.deadline_block)) return false;

        let depth = Number(res.latest) - Number(mine.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[coin]) return false;

        let fields = this._relayFieldsFromOrigin(coin, mine);
        if(!fields) return false;

        return fields.originActionIndex === Number(row.origin_action_index) &&
               fields.providerId        === String(row.provider_id) &&
               fields.redundancy        === Number(row.redundancy) &&
               fields.deadlineBlocks    === Number(row.deadline_blocks) &&
               this._sha256(fields.requestPayload) === this._sha256(String(row.request_payload == null ? '' : row.request_payload));
    }

    // The response leg's re-verification, which is what replaces the old blanket
    // refusal of phase != 'request'. It has to confirm BOTH ends independently,
    // because the v4 is the only leg that irreversibly SETTLES anything: it closes
    // the origin request, releases its escrow and fires the contract's callback.
    //
    //   home side   the terminal response really exists on OUR BTC indexer, at the
    //               action_index the row names, for a request BTC holds as a foreign-
    //               origin relay leg, and deep enough that a BTC reorg cannot take it
    //               back after the origin has already settled against it;
    //   origin side the request is one OUR origin indexer still has PENDING and still
    //               marks relay-eligible, so a v4 the origin will reject (or one that
    //               would close a request the federation was never asked to service)
    //               is never signed;
    //   the body    re-derived here rather than trusted, so the payload, hash, status
    //               and meta a follower signs are its own reading of BTC and not the
    //               leader's claim about it.
    async _validateResponseRow(row){
        let rid = String(row.request_id || '').toLowerCase();
        if(!await this._validateRowEnvelope(row, 'response', rid)) return false;

        let coin = String(row.origin_chain);

        let origin = await this._fetchAllPages(coin, 'getpendingattestation_requests', 'requests');
        if(!origin.ok) return false;
        let originReq = origin.rows.find(r => String(r.request_id || '').toLowerCase() === rid);
        if(!originReq) return false;
        if(String(originReq.origin_chain || '') !== coin) return false;
        // The origin indexer builds its canonical from ITS OWN request row's
        // provider_id, so a row naming a different one signs bytes the origin will
        // never reproduce, and the v4 would be dropped as unquorate.
        if(String(originReq.provider_id || '') !== String(row.provider_id)) return false;

        // Re-derive the threaded deadline rather than trusting it. A leader that
        // named a deadline this node's own origin indexer does not hold is refused, so the
        // eviction clock can never be moved forward by a peer. An ABSENT field is tolerated
        // (a leader running code that predates this field): the value is bookkeeping,
        // and refusing over it would wedge a mixed-version fleet on the leg that settles.
        if(!this._checkOriginDeadline(row, originReq)) return false;
        if(Number.isFinite(Number(origin.latest))) this._originLatest[coin] = Number(origin.latest);
        // The leg the leader proposed is past recall on this node's own view of the
        // origin: co-signing it would fund a v4 the origin rejects as expired.
        if(this._pastEvictionHorizon(coin, originReq.deadline_block)) return false;

        let res;
        try { res = await this._indexerCall(HOME_CHAIN, 'getrelayedattestation_requests', { request_id: rid, limit: 1 }); }
        catch(e){ return false; }
        if(!res || !Array.isArray(res.requests)) return false;

        let home = res.requests.find(r => String(r.request_id || '').toLowerCase() === rid);
        if(!home) return false;
        if(String(home.origin_chain || '') !== coin) return false;
        if(home.response_action_index == null) return false;
        if(Number(home.response_action_index) !== Number(row.home_response_action_index)) return false;

        let depth = Number(res.latest_block_index) - Number(home.response_block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[HOME_CHAIN]) return false;

        let fields = this._responseFieldsFromHome(home);
        if(!fields) return false;

        return fields.providerId   === String(row.provider_id) &&
               fields.responseHash === String(row.response_hash || '').toLowerCase() &&
               fields.payloadB64   === String(row.response_payload_b64 == null ? '' : row.response_payload_b64) &&
               fields.status       === String(row.status) &&
               fields.meta         === String(row.meta == null ? '' : row.meta);
    }

    // Every hub persists the snapshot the row's signatures verify against, not just
    // the leader: indexers read whichever hub DB they mirror, and a follower's may be
    // the only one they see. Deterministic + INSERT IGNORE, so all hubs write the
    // same rows. Same contract as CrossChainCallEngine._persistCapabilitySnapshot.
    async _persistCapabilitySnapshot(capability, block, network){
        let validators = await this._resolveCapabilityValidators(capability, block, network);
        // SWQ-TRUNC-MIRROR: a TRUNCATED set is never mirrored, for the reason
        // spelled out in CrossChainDexEngine._persistCapabilitySnapshot. This writer has no
        // caller today, which is exactly why the guard goes in now: the next caller would
        // otherwise inherit the fifth unguarded path into the shared capability_snapshots
        // mirror. Keep every writer's guard in lockstep.
        if(validators && validators.truncated === true){
            console.warn('AttestationRelay: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return;
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
                // (LIMIT 1), so the mirror stream carried one source. This writer has no
                // caller today; the widening goes in now so the next one does not inherit
                // the drift. Inert below SWQ, where source='' and there is one row per key.
                let r = await this.db.doQuery(
                    'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
                    [block, capability, row.signing_pubkey, row.source]);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
    }

    // Source-keyed at/above STAKE_WEIGHTED_QUORUM, legacy count set below it. Mirrors
    // CrossChainCallEngine so the relay resolves the identical cross_chain set the
    // XCALL rail does at the same block.
    async _resolveCapabilityValidators(capability, block, network){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({
                        pubkey: v.pubkey, source: String(v.source != null ? v.source : ''),
                        weight: String(v.weight != null ? v.weight : '0'),
                        amount: String(v.weight != null ? v.weight : '0')
                    }));
                    // Carry truncation through so the consensus fails closed on an
                    // over-cap weighted snapshot (SWQ-TRUNC parity).
                    if(snap.truncated === true) validators.truncated = true;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators))
                    validators = snap.validators.map(v => ({
                        pubkey: v.pubkey, source: '',
                        weight: String(v.amount != null ? v.amount : '0'),
                        amount: String(v.amount != null ? v.amount : '0')
                    }));
            }
        }
        return validators;
    }

    // ----- broadcast -----

    // The two legs' local state, selected by phase. Everything downstream of a
    // finalized round (retention, failover, WAL, spend guard) is one implementation
    // parameterised on this, so the legs cannot drift apart in the money path.
    _legState(phase){
        return (phase === 'response')
            ? { wire: this._finalizedResponse, published: this._publishedResponses }
            : { wire: this._finalizedWire,     published: this._published };
    }

    async _onRoundFinalized(ev){
        let row  = ev.row;
        let sigs = ev.signatures || [];
        this._inflight.delete(String(row.round_id));
        let phase = String(row.phase);
        if(phase !== 'request' && phase !== 'response') return;

        let rid = String(row.request_id).toLowerCase();
        if(sigs.length === 0){
            console.warn('AttestationRelay: finalized ' + rid.substring(0, 16) + '... with no signatures; nothing to broadcast');
            return;
        }

        let fault = this._wireFault(row, sigs.length);
        if(fault){
            console.error('AttestationRelay: dropping finalized ' + rid.substring(0, 16) + '... : ' + fault);
            return;
        }

        let response = (phase === 'response');
        // The request leg lands on BTC; the response leg lands back on the chain the
        // request came from.
        let coin = response ? String(row.origin_chain) : HOME_CHAIN;
        let wire = response ? this._buildResponseWire(row, sigs) : this._buildRequestWire(row, sigs);
        let rank = this._myRank(rid, ev);
        this._legState(phase).wire.set(rid, {
            rid: rid, wire: wire, coin: coin, phase: phase, finalizedAt: Date.now(), rank: rank
        });

        console.log('AttestationRelay: finalized ' + phase + ' ' + rid.substring(0, 16) + '... ' +
                    (response
                        ? HOME_CHAIN + ':' + row.home_response_action_index + ' -> ' + coin + ' (' + row.status + ')'
                        : row.origin_chain + ':' + row.origin_action_index + ' -> ' + HOME_CHAIN) +
                    ' (' + sigs.length + ' sigs, snapshot ' + row.snapshot_block + ', rank ' + rank + ')');

        // Rank 0 is the round's broadcaster; every other rank waits out its failover
        // window in _sweepFinalized so a silent leader costs one window, not the
        // request's whole deadline.
        if(rank === 0) await this._broadcast(phase, rid);
    }

    // This node's position in the hash-ordered signer set for the request. The same
    // sort rule the responsible-set derivations use, so every node computes the same
    // ordering and the step-ins are staggered rather than simultaneous.
    _myRank(rid, ev){
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        if(!myPubkey) return -1;
        let sigs = (ev && ev.signatures) ? ev.signatures : [];
        let ordered = sigs
            .map(s => String(s.pubkey).toLowerCase())
            .map(pk => ({ pubkey: pk, hash: crypto.createHash('sha256').update(rid, 'utf8').update(pk, 'utf8').digest('hex') }))
            .sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        let idx = ordered.findIndex(v => v.pubkey === myPubkey);
        return idx;   // -1 when we did not sign, which _sweepFinalized treats as never eligible
    }

    async _sweepFinalized(){
        for(let phase of ['request', 'response']){
            let state = this._legState(phase);
            for(let [rid, entry] of state.wire){
                if(state.published.has(rid) || this._legLanded(phase, rid, entry)){
                    state.wire.delete(rid);
                    continue;
                }
                if(entry.rank < 0) continue;
                if(entry.rank === 0) continue;   // already attempted at finalization
                if(Date.now() - entry.finalizedAt < entry.rank * this.failoverWindowMs) continue;
                console.warn('AttestationRelay: leader silent for the ' + phase + ' leg of ' +
                             rid.substring(0, 16) + '...; rank ' + entry.rank + ' stepping in');
                await this._broadcast(phase, rid);
            }
        }
    }

    // Has the destination chain accepted this leg, however it got there (our own
    // broadcast, a peer's, or a retry)? For the request leg the v3 shows up in BTC's
    // pending queue; for the response leg the v4 flips the origin request OUT of the
    // origin's pending queue. A pending view we failed to refresh is null and answers
    // "unknown", which retains the round rather than retiring it.
    _legLanded(phase, rid, entry){
        if(phase === 'request') return this._homeHasRequest(rid);
        let pending = this._originPending[String(entry && entry.coin)];
        return Boolean(pending) && !pending.has(rid);
    }

    // Does the home chain already hold this request, at ANY lifecycle status? See the
    // note on _homeRelayed for why the pending queue alone is not that answer.
    _homeHasRequest(rid){
        return this._homePending.has(rid) || this._homeRelayed.has(rid);
    }

    async _broadcast(phase, rid){
        let state = this._legState(phase);
        let entry = state.wire.get(rid);
        if(!entry) return;
        if(state.published.has(rid)) return;

        let broadcaster = this._getBroadcaster(entry.coin);
        if(!broadcaster){
            console.warn('AttestationRelay: no ' + entry.coin + ' broadcast rail configured for the ' + phase +
                         ' leg of ' + rid.substring(0, 16) + '...; retained for a later sweep');
            return;
        }
        // RESERVE rather than allow(): the send below is AWAITED and this method has
        // two concurrent drivers, the rank-0 broadcast inside the unawaited
        // 'match:finalized' handler and the _poll sweep, with nothing serializing them.
        // src/lib/spend_guard.js forbids the pure allow()/record() pair around an
        // awaited send precisely for that shape: every in-flight caller reads the same
        // pre-send budget and they all spend past the ATTEST_RELAY count and USD
        // ceilings by the concurrency width. reserve() consumes the budget in this
        // synchronous turn, so the ceiling holds by construction; the reservation IS
        // the recorded spend, so record() must never be called on this path.
        let spendToken = this.spendGuard.reserve();
        if(!spendToken){
            console.warn(this.spendGuard.noteBlocked() + ' (' + rid.substring(0, 16) + '...); retained for a later window');
            return;
        }

        // The intent record goes down BEFORE the send so a crash mid-flight is
        // recoverable as ambiguous rather than invisible. See _loadWal.
        if(!this._appendWal({ ts: Date.now(), rid: rid, leg: phase, phase: 'intent' })){
            // Nothing goes on the wire without a durable record, so the leg stays
            // retryable and the reserved budget goes back.
            this.spendGuard.release(spendToken);
            console.error('AttestationRelay: durable WAL write FAILED for ' + rid.substring(0, 16) +
                          '...; skipping broadcast (no on-chain spend without a durable record)');
            return;
        }

        let version = (phase === 'response') ? 'v4' : 'v3';
        try {
            let result = await broadcaster(entry.wire);
            this._broadcastSucceeded++;
            this.spendGuard.commit(spendToken);   // the reservation IS the fee charged to the window
            state.published.mark(rid);
            state.wire.delete(rid);
            this._appendWal({ ts: Date.now(), rid: rid, leg: phase, phase: 'sent', txid: (result && result.txid) || null });
            console.log('AttestationRelay: broadcast ATTEST ' + version + ' on ' + entry.coin + ' for ' +
                        rid.substring(0, 16) + '... txid=' + ((result && result.txid) ? result.txid : '?'));
        } catch(e){
            this._broadcastFailed++;
            // An ambiguous failure may still have reached the node. Record it as sent so
            // no rank re-spends on a tx that might already be on the wire; the pending
            // refresh confirms it, or the request expires on its deadline.
            //
            // A PRE-SEND failure is never ambiguous: nothing left this process, so it
            // must stay retryable. The shared classifier cannot tell the difference (it
            // defaults an unrecognised error to ambiguous, which is the right default
            // for an opaque operator hook), so _defaultBroadcast tags the steps it
            // knows ran before the send. Without this a transient "no UTXOs available"
            // would suppress the request permanently.
            if(!e._relayPreSend && isAmbiguousSendError(e)){
                // COMMIT, not release: this branch already treats the tx as possibly on
                // the wire, marks the leg published and never retries it, so the fee may
                // have been paid. Keeping the reservation charges the window for it,
                // which fails closed; releasing would hand budget back for a spend
                // nothing will re-attempt.
                this.spendGuard.commit(spendToken);
                state.published.mark(rid);
                this._appendWal({ ts: Date.now(), rid: rid, leg: phase, phase: 'sent', txid: null, ambiguous: true });
                console.error('AttestationRelay: AMBIGUOUS ' + version + ' broadcast failure for ' + rid.substring(0, 16) +
                              '... (the tx may have reached the ' + entry.coin + ' node); not retrying: ', e);
            } else {
                // A pre-send or clean failure left nothing on the wire and the leg stays
                // retryable, so the reserved budget goes back.
                this.spendGuard.release(spendToken);
                this._appendWal({ ts: Date.now(), rid: rid, leg: phase, phase: 'failed' });
                console.error('AttestationRelay: ' + version + ' broadcast failed for ' + rid.substring(0, 16) + '...: ', e);
            }
        }
    }

    _buildRequestWire(row, sigs){
        let parts = [
            'ATTEST',
            '3',
            String(row.request_id).toLowerCase(),
            String(row.origin_chain),
            String(row.origin_action_index),
            String(row.provider_id),
            String(row.request_payload == null ? '' : row.request_payload),
            String(row.redundancy),
            String(row.deadline_blocks),
            String(row.snapshot_block),
            String(sigs.length)
        ];
        for(let s of sigs){
            parts.push(String(s.pubkey).toLowerCase());
            parts.push(String(s.sig).toLowerCase());
        }
        return parts.join('|');
    }

    _buildResponseWire(row, sigs){
        let parts = [
            'ATTEST',
            '4',
            String(row.request_id).toLowerCase(),
            String(row.home_response_action_index),
            String(row.response_payload_b64 == null ? '' : row.response_payload_b64),
            String(row.status),
            String(row.meta == null ? '' : row.meta),
            String(row.snapshot_block),
            String(sigs.length)
        ];
        for(let s of sigs){
            parts.push(String(s.pubkey).toLowerCase());
            parts.push(String(s.sig).toLowerCase());
        }
        return parts.join('|');
    }

    // Resolve the rail for the chain this leg lands on. The home rail keeps the
    // operator's shared hooks; an origin rail is only ever the explicitly configured
    // one (see chainRails), so a v4 can never be handed to a hook that would put it
    // on BTC.
    _getBroadcaster(coin){
        if(String(coin) === HOME_CHAIN || coin == null){
            if(this.broadcastFn) return (payload) => this.broadcastFn(payload);
            if(this.encoder && this.walletSignFn && this.btcAddress && this.btcPubkeyHex)
                return (payload) => this._defaultBroadcast(payload, this.encoder, this.btcAddress, this.walletSignFn, HOME_CHAIN);
            return null;
        }
        let rail = this.chainRails[String(coin)];
        if(!rail) return null;
        if(rail.broadcastFn) return (payload) => rail.broadcastFn(payload);
        let signFn = rail.walletSignFn || this.walletSignFn;
        if(rail.encoder && signFn && rail.address)
            return (payload) => this._defaultBroadcast(payload, rail.encoder, rail.address, signFn, String(coin));
        return null;
    }

    // The encoder pipeline, mirroring AttestationPublisher._defaultBroadcast: P2SH
    // because a relay leg with several signatures exceeds the 80-byte OP_RETURN.
    // Parameterised on the chain's rail so the v3 (BTC) and v4 (origin) legs share
    // one implementation instead of drifting.
    //
    // Everything up to broadcastTx builds and signs; no money moves and nothing
    // leaves this process, so those failures are tagged _relayPreSend and stay
    // retryable. Only broadcastTx can leave a tx on the wire, so only its failures
    // reach the ambiguity classifier.
    async _defaultBroadcast(payload, encoder, address, walletSignFn, coin){
        encoder      = encoder      || this.encoder;
        address      = address      || this.btcAddress;
        walletSignFn = walletSignFn || this.walletSignFn;
        let txHex;
        try {
            let utxos = await encoder.getUtxos(address);
            if(!utxos || (Array.isArray(utxos) && utxos.length === 0))
                throw new Error('no UTXOs available for ' + address);
            let psbtResult = await encoder.createTx({
                // Forwarded only while inside the encoder's caller-facing
                // MAX_UTXO_COUNT; past it the param is omitted so the encoder selects
                // from its own uncapped fetch of this same address
                // (lib/encoder_utxo_forward.js).
                utxos:    forwardableUtxos(utxos, 'AttestationRelay'),
                pubkey:   address,
                data:     payload,
                change:   address,
                encoding: 'P2SH'
            });
            if(!psbtResult || !psbtResult.psbt) throw new Error('encoder returned no PSBT');
            // Refuse phase 1 of a two-transaction encoding before anything is signed: this
            // pipeline has no reveal, so broadcasting the P2SH funding tx would publish a
            // relay leg no indexer can decode and strand the carrier value
            // (lib/two_phase_guard.js).
            assertSingleTxEncoding(psbtResult, 'AttestationRelay');
            // The coin argument is what lets one operator module hold a key per chain;
            // a single-key module ignores it, exactly as it does today.
            txHex = await walletSignFn(psbtResult.psbt, coin || HOME_CHAIN);
            if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        } catch(e){
            e._relayPreSend = true;
            throw e;
        }
        return await encoder.broadcastTx(txHex);
    }

    // ----- durable at-most-once -----

    _appendWal(entry){
        // Stamp the eviction key from one place rather than at each call site,
        // so no record can be written that a later process cannot re-anchor: a record
        // without a deadline is one the eviction pass can never retire.
        let d = this._deadlines.get(String((entry && entry.rid) || '').toLowerCase());
        if(d) entry = Object.assign({}, entry, { deadline_chain: d.coin, deadline_block: d.block });
        try {
            fs.mkdirSync(path.dirname(this.walPath), { recursive: true });
            let fd = fs.openSync(this.walPath, 'a');
            fs.writeSync(fd, JSON.stringify(entry) + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            return true;
        } catch(e){
            this._walFailures++;
            console.error('AttestationRelay: failed to append the relay WAL at ' + this.walPath + ':', e);
            return false;
        }
    }

    // Seed the at-most-once sets from the WAL. An `intent` with no terminal record is
    // a crash mid-broadcast: treated as SENT, because a duplicate leg burns a real fee
    // for an action the indexer rejects, while a missed relay merely lets the origin
    // request expire on its own deadline. Fail closed toward not spending.
    //
    // Records are keyed on (leg, request_id), the same idempotency key the round ids
    // use, so one request's v3 and v4 never occupy the same slot. A record written
    // before the response leg existed carries no `leg` and is a request-leg record by
    // construction.
    //
    // Each record also carries the eviction key, so the deadline index that
    // bounds these sets survives the restart with them. A record written before this
    // key existed carries none: that leg is simply never evicted, which retains state
    // rather than spending, and the first poll that still sees the request re-indexes
    // it anyway.
    //
    // Returns { records, keys } so start() can tell a file that is one record per live
    // key from a history that has earned a compaction.
    _loadWal(){
        let text;
        try { text = fs.readFileSync(this.walPath, 'utf8'); }
        catch(e){ return { records: 0, keys: 0 }; }   // absent on a first run
        let outcome = new Map();
        let records = 0;
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }
            let rid = String(rec.rid || '').toLowerCase();
            if(!rid) continue;
            records++;
            this._noteDeadline(rec.deadline_chain, rid, rec.deadline_block);
            let leg = (String(rec.leg || '') === 'response') ? 'response' : 'request';
            let key = leg + '|' + rid;
            let prior = outcome.get(key);
            // 'sent' is terminal and sticky; 'failed' only clears a bare intent.
            if(rec.phase === 'sent') outcome.set(key, 'sent');
            else if(rec.phase === 'failed' && prior !== 'sent') outcome.set(key, 'failed');
            else if(rec.phase === 'intent' && prior === undefined) outcome.set(key, 'intent');
        }
        let keys = 0;
        for(let [key, state] of outcome){
            if(state !== 'sent' && state !== 'intent') continue;
            let split = key.indexOf('|');
            this._legState(key.substring(0, split)).published.mark(key.substring(split + 1));
            keys++;
        }
        return { records: records, keys: keys };
    }

    // ----- deadline-anchored eviction -----

    // The absolute deadline_block of an origin request row, or null when the row cannot
    // supply a usable one. Null means "never evict this leg": retention is the safe
    // direction, since the only cost is memory and the cost of the other direction is a
    // duplicate broadcast that burns a real fee.
    _absoluteOriginDeadline(originReq){
        let block = Number(originReq && originReq.deadline_block);
        return (Number.isInteger(block) && block > 0) ? block : null;
    }

    // A follower's re-derivation of the threaded deadline. Indexes its OWN reading first,
    // then accepts the row only if the leader's copy agrees (or is absent, from a
    // leader running code that predates this field). Never adopts the leader's number.
    _checkOriginDeadline(row, originReq){
        let rid  = String(row.request_id || '').toLowerCase();
        let mine = this._absoluteOriginDeadline(originReq);
        this._noteDeadline(row.origin_chain, rid, mine);
        if(row.origin_deadline_block == null) return true;
        return mine != null && Number(row.origin_deadline_block) === mine;
    }

    _noteDeadline(coin, rid, deadlineBlock){
        coin  = String(coin || '');
        rid   = String(rid  || '').toLowerCase();
        let block = Number(deadlineBlock);
        if(ORIGIN_CHAINS.indexOf(coin) === -1) return false;
        if(!/^[0-9a-f]{64}$/.test(rid)) return false;
        if(!Number.isInteger(block) || block <= 0) return false;
        let prior = this._deadlines.get(rid);
        if(prior && prior.coin === coin && prior.block === block) return true;
        if(!prior && this._deadlines.size >= MAX_TRACKED_DEADLINES){
            console.warn('AttestationRelay: deadline index full at ' + MAX_TRACKED_DEADLINES +
                         ' entries; ' + rid.substring(0, 16) + '... will be retained rather than evicted');
            return false;
        }
        this._deadlines.set(rid, { coin: coin, block: block });
        return true;
    }

    // The one definition of "dead beyond recall", shared by the eviction pass and by
    // both re-entry paths. They MUST use the same horizon: if a request could still be
    // proposed after its records were forgotten, eviction would be exactly the
    // double-broadcast it is supposed to prevent. False whenever the chain's tip is
    // unknown, so an unread chain evicts nothing and blocks nothing.
    _pastEvictionHorizon(coin, deadlineBlock){
        let tip   = Number(this._originLatest[String(coin || '')]);
        let block = Number(deadlineBlock);
        if(!Number.isFinite(tip) || !Number.isInteger(block)) return false;
        return tip > block + this.evictGraceBlocks + Number(this.confirmations[String(coin)] || 0);
    }

    // Forget every leg whose origin request is dead beyond recall, and compact the WAL
    // down to what is left. THE SAFETY ARGUMENT, which is the whole of this feature:
    //
    //   a leg is evicted only when the ORIGIN chain's tip is past the request's own
    //   deadline_block by that chain's confirmation depth PLUS the grace window. Past
    //   that point the origin indexer's expiry sweep has taken the row out of 'pending'
    //   and no reorg this driver honours can put it back, and BOTH re-entry paths here
    //   (_maybeMaterialize, _maybeRelayResponse) refuse the same horizon on their way in.
    //   So there is no path from a forgotten key back to a second broadcast.
    //
    // A chain whose tip we have never read is skipped: eviction runs off observed
    // heights only, never off wall clock or off a chain we cannot see.
    _evictExpired(){
        let expired = [];
        for(let [rid, d] of this._deadlines){
            if(!this._pastEvictionHorizon(d.coin, d.block)) continue;
            expired.push(rid);
        }
        if(!expired.length) return 0;

        for(let rid of expired){
            this._deadlines.delete(rid);
            for(let phase of ['request', 'response']){
                let state = this._legState(phase);
                state.published.delete(rid);
                state.wire.delete(rid);
            }
            this._evicted++;
        }
        console.log('AttestationRelay: evicted ' + expired.length + ' relay leg(s) whose origin deadline is ' +
                    'buried past recall (' + this._published.size + ' request + ' + this._publishedResponses.size +
                    ' response record(s) retained)');
        // Only ever after the in-memory eviction: a compaction that failed leaves the
        // fuller file on disk, so a restart re-learns the keys and holds them another
        // window. The reverse order could drop a record that is still live.
        this._compactWal('eviction');
        return expired.length;
    }

    // Rewrite the WAL as ONE record per surviving at-most-once key, atomically. The
    // retained record is the original line that decided the key's state, so a txid an
    // operator may need to trace is preserved rather than synthesized away; a key with
    // no line left (only possible if a record was lost) gets a synthetic 'sent' so
    // compaction can never be the thing that un-suppresses a broadcast.
    _compactWal(reason){
        let text;
        try { text = fs.readFileSync(this.walPath, 'utf8'); }
        catch(e){ return false; }   // nothing on disk yet: nothing to compact

        let state = new Map();
        let keep  = new Map();
        let lines = 0;
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }
            let rid = String(rec.rid || '').toLowerCase();
            if(!rid) continue;
            lines++;
            let leg   = (String(rec.leg || '') === 'response') ? 'response' : 'request';
            let key   = leg + '|' + rid;
            let prior = state.get(key);
            // The same fold _loadWal applies, tracking the record that carried the state.
            if(rec.phase === 'sent'){ state.set(key, 'sent'); keep.set(key, rec); }
            else if(rec.phase === 'failed' && prior !== 'sent'){ state.set(key, 'failed'); keep.set(key, rec); }
            else if(rec.phase === 'intent' && prior === undefined){ state.set(key, 'intent'); keep.set(key, rec); }
        }

        let out  = [];
        let seen = new Set();
        for(let [key, rec] of keep){
            let split = key.indexOf('|');
            let leg   = key.substring(0, split);
            let rid   = key.substring(split + 1);
            // Dropped here: keys this pass just evicted, and keys whose last word was a
            // definitive 'failed' (absent and 'failed' mean the same thing on reload).
            if(!this._legState(leg).published.has(rid)) continue;
            let d = this._deadlines.get(rid);
            out.push(JSON.stringify(Object.assign({}, rec, {
                leg: leg, compacted: true,
                deadline_chain: d ? d.coin  : rec.deadline_chain,
                deadline_block: d ? d.block : rec.deadline_block
            })));
            seen.add(key);
        }
        for(let leg of ['request', 'response']){
            for(let rid of this._legState(leg).published.keys()){
                if(seen.has(leg + '|' + rid)) continue;
                let d = this._deadlines.get(rid);
                out.push(JSON.stringify({
                    ts: Date.now(), rid: rid, leg: leg, phase: 'sent', compacted: true, synthesized: true,
                    deadline_chain: d ? d.coin : undefined, deadline_block: d ? d.block : undefined
                }));
            }
        }

        let tmp = this.walPath + '.compact';
        try {
            fs.mkdirSync(path.dirname(this.walPath), { recursive: true });
            let fd = fs.openSync(tmp, 'w');
            fs.writeSync(fd, out.length ? out.join('\n') + '\n' : '');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            // Atomic: a crash here leaves the OLD file, which is the conservative one.
            fs.renameSync(tmp, this.walPath);
            this._walCompactions++;
            console.log('AttestationRelay: compacted the relay WAL (' + reason + '): ' +
                        lines + ' record(s) -> ' + out.length);
            return true;
        } catch(e){
            this._walFailures++;
            try { fs.unlinkSync(tmp); } catch(_){ /* best effort */ }
            console.error('AttestationRelay: WAL compaction (' + reason + ') failed at ' + this.walPath +
                          '; the uncompacted file stands:', e);
            return false;
        }
    }

    // ----- helpers -----

    _logGateOnce(snapshotBlock){
        if(this._gateLogged) return;
        this._gateLogged = true;
        console.log('AttestationRelay: ATTEST_RELAY_ACTIVATION not reached on ' + this.network +
                    ' (BTC ' + snapshotBlock + '); relay-eligible origin requests are held, nothing is broadcast');
    }

    _roundId(phase, requestId){
        return this._sha256('ATTESTRELAYROUND|' + phase + '|' + String(requestId).toLowerCase());
    }

    _sha256(s){
        return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
    }

    async _resolveSnapshotBlock(){
        return this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
    }

    async _indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 },
                                    { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        let result = resp.data ? resp.data.result : null;
        if(result && result.error) throw new Error('indexer error: ' + String(result.error));
        return result;
    }
}

module.exports = AttestationRelay;
module.exports.HOME_CHAIN    = HOME_CHAIN;
module.exports.ORIGIN_CHAINS = ORIGIN_CHAINS;
