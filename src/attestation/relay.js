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

// This file keeps the class: construction, the lifecycle and the poll that drives
// both legs, plus the two methods whose text a structural suite reads from THIS file:
// defaultBroadcast (test/unit/two_phase_guard.test.js, encoder_utxo_forward.test.js)
// and _persistCapabilitySnapshot (capability_snapshot_write_atomic.test.js). Everything
// else lives in named parts under ./relay/ and is installed on
// the prototype below, so `require('./attestation/relay')` and every method name are
// exactly what they were.
const { initRelayPolling, initRelayRails, initRelayAtMostOnce,
        initRelayViews, initRelayConsensus } = require('./relay/options.js');
const discovery = require('./relay/discovery.js');
const propose   = require('./relay/propose.js');
const canonical = require('./relay/canonical.js');
const verify    = require('./relay/verify.js');
const broadcast = require('./relay/broadcast.js');
const wal       = require('./relay/wal.js');
const { HOME_CHAIN, ORIGIN_CHAINS } = require('./relay/constants.js');
const snapWrite = require('../lib/capability_snapshot_write.js');
const { forwardableUtxos } = require('../lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('../lib/two_phase_guard.js');
const { getLogger } = require('../observability');
const logger = getLogger();

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

        // Construction in named steps, in the order the fields were assigned before the
        // split (src/attestation/relay/options.js): nothing here is conditional, so the
        // instance carries the same properties, with the same values, in the same order.
        initRelayPolling(this, cfg);
        initRelayRails(this, cfg);
        initRelayAtMostOnce(this, cfg);
        initRelayViews(this);
        initRelayConsensus(this);

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
    // overload of the home ones, for the reason spelled out on chainRails (relay/options.js).
    setChainBroadcastHook(coin, fn){  if(this.chainRails[coin]) this.chainRails[coin].broadcastFn  = fn; }
    setChainWalletSignHook(coin, fn){ if(this.chainRails[coin]) this.chainRails[coin].walletSignFn = fn; }
    setChainEncoder(coin, encoder){   if(this.chainRails[coin]) this.chainRails[coin].encoder      = encoder; }

    async start(){
        if(!this.enabled){
            logger.info('AttestationRelay: disabled (set ATTEST_RELAY_ENABLED=1 to opt in); cross-chain relay inactive');
            return;
        }
        if(!this.peerManager){
            logger.info('AttestationRelay: no peer manager; skipping start');
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
                logger.warn('AttestationRelay: no indexer URL for ' + coin + ' (set ' + coin +
                    '_INDEXER_API_URL, or push it via xchain-node updateconfig); this chain is skipped every tick');
        }

        let wal = this.loadWal();
        // Fold the file down as soon as it carries more than one record per
        // surviving key. Without this a long-lived hub re-reads (whole-file, readFileSync)
        // an ever-growing history of intent/sent/failed pairs at every restart, even on a
        // fleet whose legs all evict cleanly.
        if(wal.records > wal.keys) this.compactWal('startup');
        // The WAL kept at-most-once sends across a restart, but the spend
        // ceilings behind them did not; reload the saved window from the same idiom.
        this.spendGuard.persistTo();
        await this.consensus.start();

        this._pollTimer = setInterval(() => {
            this._poll().catch(err => logger.error('AttestationRelay: poll error: ' + (err && err.message)));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();

        for(let coin of ORIGIN_CHAINS){
            if(!this.getBroadcaster(coin))
                logger.warn('AttestationRelay: no ' + coin + ' broadcast rail (set ' + coin + '_ENCODER_URL + ' +
                    coin + '_ADDRESS, or wire setChainBroadcastHook); relay RESPONSES for ' + coin +
                    '-origin requests are held, never dropped');
        }

        logger.info('AttestationRelay: started (poll ' + this.pollMs + 'ms, origins ' +
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
            await this.refreshHomePending();
            let home = await this.refreshHomeRelayed();
            for(let coin of ORIGIN_CHAINS){
                if(!this.indexers[coin] || !this.indexers[coin].url) continue;
                try { await this.pollOriginRequests(coin); }
                catch(e){ logger.warn('AttestationRelay: ' + coin + ' poll failed: ' + (e && e.message)); }
            }
            if(home){
                try { await this.relayHomeResponses(home); }
                catch(e){ logger.warn('AttestationRelay: response relay pass failed: ' + (e && e.message)); }
            }
            await this.sweepFinalized();
            // Last, on the tips this tick just read: a leg is only evictable once its
            // origin chain has buried the request's deadline, so eviction wants the
            // freshest view and must never run ahead of the legs it might retire.
            this.evictExpired();
        } finally {
            this._polling = false;
        }
    }

    // Every hub persists the snapshot the row's signatures verify against, not just
    // the leader: indexers read whichever hub DB they mirror, and a follower's may be
    // the only one they see. Deterministic + INSERT IGNORE, so all hubs write the
    // same rows. Same contract as CrossChainCallEngine._persistCapabilitySnapshot.
    async _persistCapabilitySnapshot(capability, block, network){
        let validators = await this.resolveCapabilityValidators(capability, block, network);
        // SWQ-TRUNC-MIRROR: a TRUNCATED set is never mirrored, for the reason
        // spelled out in CrossChainDexEngine._persistCapabilitySnapshot. This writer has no
        // caller today, which is exactly why the guard goes in now: the next caller would
        // otherwise inherit the fifth unguarded path into the shared capability_snapshots
        // mirror. Keep every writer's guard in lockstep.
        if(validators && validators.truncated === true){
            logger.warn('AttestationRelay: refusing to persist a TRUNCATED ' + capability +
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
                let r = await this.db.getCapabilitySnapshot(block, capability, row.signing_pubkey, row.source);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
    }

    // The encoder pipeline, mirroring AttestationPublisher.defaultBroadcast: P2SH
    // because a relay leg with several signatures exceeds the 80-byte OP_RETURN.
    // Parameterised on the chain's rail so the v3 (BTC) and v4 (origin) legs share
    // one implementation instead of drifting.
    //
    // Everything up to broadcastTx builds and signs; no money moves and nothing
    // leaves this process, so those failures are tagged _relayPreSend and stay
    // retryable. Only broadcastTx can leave a tx on the wire, so only its failures
    // reach the ambiguity classifier.
    async defaultBroadcast(payload, encoder, address, walletSignFn, coin){
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
}

// The parts are installed NON-ENUMERABLE, like the class methods beside them. An
// assigned mixin would be the only prototype member for...in and Object.keys could
// see, and what a prototype enumerates is behaviour rather than layout (the reasoning
// src/db/index.js records for the same install). Writable and configurable stay true,
// so a test can still stub a moved method and put it back, and a name two parts both
// claim is loud at load instead of last-one-wins.
function installParts(target, parts){
    for(const part of parts){
        for(const name of Object.keys(part)){
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('AttestationRelay: two parts define ' + name);
            Object.defineProperty(target, name,
                { value: part[name], writable: true, configurable: true, enumerable: false });
        }
    }
}

installParts(AttestationRelay.prototype, [discovery, propose, canonical, verify, broadcast, wal]);

module.exports = Object.assign(AttestationRelay, {
    HOME_CHAIN,
    ORIGIN_CHAINS
});
