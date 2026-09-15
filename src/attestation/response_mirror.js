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
 * AttestationResponseMirror: the producer side of the ATTEST response mirror
 * (the ATTEST response mirror design, §3.2).
 *
 * WHY THIS EXISTS. Below the mirror activation height a finalized attestation
 * response is an ATTEST v1 transaction the leader validator broadcasts and pays a
 * chain fee for, and the contract callback fires only once it mines. At or above
 * it the response never becomes its own transaction: it is written here, into the
 * hub's insert-only `attestation_responses` table, streamed to every indexer over
 * the same hub-DB mirror PRICE rounds ride, and applied at a block that is a pure
 * function of the SIGNED effective_time. This module is that write, and nothing
 * else: the periodic on-chain batch that keeps the history reconstructible from
 * chain parse is AttestationBatchPublisher's job. It IS, however, the receiving end
 * of that batch: `receiveValidatedBatch` takes a batch the indexer parsed off the
 * DOGE rail and pushed back, re-verifies the batch quorum, writes any row this hub
 * does not hold, and sets the row's batch link. That is the chain-only rebuild road
 * (§6.3), so a node with no mirror connection still reaches the same rows.
 *
 * IT IS ALSO THE DISSEMINATION SIDE (§3.3). Only the responsible set runs a round,
 * so on a five-hub federation at redundancy 3 two hubs never learn the result at
 * all, and an indexer follows exactly ONE hub. The finalized artifact is therefore
 * gossiped as an ATTEST_RESULT P2P envelope, and a receiving hub re-verifies it
 * against its OWN capability snapshot before writing its own copy.
 *
 * TWO LAYERS OF SIGNATURE, AND THEY ANSWER DIFFERENT QUESTIONS. The ENVELOPE is
 * signed by the sending hub and checked by PeerManager before this engine ever sees
 * it (membership in the chain-effective signer set, then Ed25519, then replay
 * dedupe): that is TRANSPORT authenticity, and all it establishes is that some
 * federation member relayed these bytes. The ROW inside carries the responsible
 * set's own signatures over the mirror-era canonical, and that is what makes the
 * artifact true. Only the second layer is consensus: a row from a peer whose
 * envelope verified is still dropped if its content signatures do not, and a row
 * whose content verifies would be equally true arriving any other way. This is the
 * XANCREWARD shape (StateAnchorPublisher.federateRewardAttestation), with one
 * difference worth naming: XANCREWARD needs a sender signature INSIDE its payload
 * because its receiver re-runs an on-chain proof keyed to the relayer's identity,
 * while nothing here is keyed to who relayed, so the transport layer is left
 * entirely to the envelope and this payload carries no sender field at all.
 *
 * NO PeerManager EDIT. There is no message-type registry on the hub: every engine
 * subscribes to PeerManager's 'message' event and switches on `envelope.type`. So
 * this is one `const` and one `case`, exactly as §6.2 requires.
 *
 * THE MIRROR IS TRANSPORT, NEVER AUTHORITY. Every field this module writes is
 * either covered by the responsible set's signatures or explicitly informational.
 * The row is self-authenticating, so which hub wrote it does not matter: the
 * indexer re-verifies `signatures` against the responsible set it resolves from
 * ITS OWN local v0 request row, and a row that fails is skipped identically on
 * every node rather than forking one.
 *
 * WHAT IT LISTENS TO. AttestationConsensus emits 'request:finalized' when a round
 * reaches commit quorum. That listener is PROCESS-GLOBAL and attached once in
 * start() (decision D58), which is why the activation gate is a per-request early
 * return inside the handler rather than a conditional attach; AttestationPublisher
 * carries the same predicate on the same event, with the two branches mutually
 * exclusive so a request is served by exactly one of the two eras.
 *
 * WHY THE HANDLER COPIES BEFORE IT AWAITS. `pending` (the round state the emitted
 * payload was assembled from) is deleted PENDING_EVICT_MS (10s) after the emit, and
 * the event's nested `request`, `signatures` and body objects are the round's own
 * live objects, not clones. A handler that awaited its DB round-trip first and read
 * the payload afterwards would be racing that eviction and a retry round's
 * overwrite for the same rid. So the whole row is materialized synchronously, in
 * the handler's own tick, and only the finished row crosses the await boundary.
 *
 ********************************************************************/

'use strict';

// This file keeps the class: construction, the era predicate, the lifecycle and the
// small value helpers. Everything else lives in named parts under ./response_mirror/
// and is installed on the prototype below, so every require path and method name is
// exactly what it was.
const { isResponseMirrorActive } = require('../attest_response_mirror_activation.js');
const build      = require('./response_mirror/build.js');
const batch      = require('./response_mirror/batch.js');
const retraction = require('./response_mirror/retraction.js');
const gossip     = require('./response_mirror/gossip.js');
const verify     = require('./response_mirror/verify.js');
const { MIRROR_COLUMNS, TERMINAL_STATUSES, ATTEST_RESULT, GOSSIP_COLUMNS,
        PARK_MAX, PARK_RETRY_MS } = require('./response_mirror/constants.js');
const { getLogger } = require('../observability');
const logger = getLogger();

class AttestationResponseMirror {

    constructor(hub){
        this.hub = hub;
        this._messageHandler = null;
        this._peerHandler    = null;
        this._retryTimer     = null;
        // Rows whose local v0 request this hub has not seen yet, keyed
        // network|request_id. Insertion-ordered, which is what makes the overflow
        // eviction below "oldest first" without a second index.
        this._parked = new Map();
        // Observability counters. Skips are logged and counted; rows never are.
        this.stats = {
            written: 0, duplicates: 0, skipped: 0, errors: 0,
            gossiped: 0, received: 0, rejected: 0, parked: 0, dropped: 0
        };
    }

    // Resolved per call rather than cached at construction: startAttestation runs
    // after hub.start() has built both, but a hub that reconnects its DB or wires a
    // broadcaster later must not leave this engine holding a dead handle.
    _db(){ return this.hub && this.hub.db; }
    broadcaster(){ return this.hub && this.hub.hubDbBroadcaster; }
    hubPeerManager(){ return this.hub && this.hub.peerManager; }

    // Seam for tests; every wall-clock read on this path goes through it.
    _nowSeconds(){
        return Math.floor(Date.now() / 1000);
    }

    // True when the response to a request admitted at `requestBlock` rides the
    // mirror. The IDENTICAL predicate AttestationPublisher's early return uses, on
    // the same activation copy: the two eras must partition every finalized round
    // between them, so a request either gets a mirror row or an on-chain v1, never
    // both and never neither. Keyed on the REQUEST's own BTC block_index, never the
    // response's and never the chain tip, so the rule for a request is fixed the
    // moment it is admitted.
    isMirrorEra(requestBlock){
        return isResponseMirrorActive(requestBlock, this.hub && this.hub.network);
    }

    async start(){
        let consensus = this.hub && this.hub.attestationConsensus;
        if(!consensus || typeof consensus.on !== 'function'){
            logger.info('AttestationResponseMirror: no AttestationConsensus, skipping consensus wiring');
            return;
        }
        if(this._messageHandler) return;   // idempotent start; never a second listener on one event
        this._messageHandler = (event) => this.handleFinalized(event);
        consensus.on('request:finalized', this._messageHandler);

        // The receive half. There is no message-type registry on the hub, so this
        // is a plain 'message' subscription that switches on envelope.type, exactly
        // as StateAnchorPublisher and OracleBatchSigner do. Wired AFTER the
        // consensus listener and behind the same idempotence guard, because the
        // verifier below reaches into AttestationConsensus for the canonical: a hub
        // with no consensus engine cannot judge a gossiped row and must not accept
        // one either.
        let pm = this.hubPeerManager();
        if(pm && typeof pm.on === 'function'){
            this._peerHandler = (envelope) => this._handleMessage(envelope);
            pm.on('message', this._peerHandler);
            this._retryTimer = setInterval(() => {
                this.drainParked().catch(e =>
                    logger.error('AttestationResponseMirror: park drain error: ' + (e && e.message ? e.message : e)));
            }, PARK_RETRY_MS);
            // Never hold the process (or a test runner) open for a cache of rows
            // whose only backstop is already the periodic on-chain batch.
            if(typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
        }

        logger.info('AttestationResponseMirror started (network: ' + (this.hub && this.hub.network) + ')');
    }

    async stop(){
        let consensus = this.hub && this.hub.attestationConsensus;
        if(consensus && this._messageHandler && typeof consensus.removeListener === 'function')
            consensus.removeListener('request:finalized', this._messageHandler);
        let pm = this.hubPeerManager();
        if(pm && this._peerHandler && typeof pm.removeListener === 'function')
            pm.removeListener('message', this._peerHandler);
        if(this._retryTimer){
            clearInterval(this._retryTimer);
            this._retryTimer = null;
        }
        // Parked rows are deliberately NOT carried across a stop: they are unverified
        // wire content whose backstop is the batch, so re-reading them after a restart
        // would only replay stale envelopes.
        this._parked.clear();
        // Cleared even when the removeListener above could not run, so a restart
        // re-attaches from a known state instead of refusing on the stale handle.
        this._messageHandler = null;
        this._peerHandler    = null;
    }

    // Bounded chain integers only (block heights, action indexes). Null rather than
    // NaN on anything unparseable, because both columns are nullable and
    // informational: a null there degrades an ordering aid, while a NaN is a SQL error
    // that would lose the whole row.
    intOrNull(v){
        if(v == null) return null;
        let n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    }

    // An admission HEIGHT off the wire, or null. Deliberately NOT intOrNull: that one
    // reads '' as 0 (Number('') is 0) and would turn a missing height into "admissible at
    // block 0", which is the row binding at the first block every indexer already has.
    // Null here means the legacy row, which binds by effective_time at every height.
    heightOrNull(v){
        if(v === null || v === undefined || v === '') return null;
        let n = Number(v);
        return (Number.isSafeInteger(n) && n >= 0) ? n : null;
    }

    shortRid(event){
        let rid = event && event.requestId;
        return rid ? String(rid).substring(0, 16) + '...' : '(no request id)';
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
                throw new Error('AttestationResponseMirror: two parts define ' + name);
            Object.defineProperty(target, name,
                { value: part[name], writable: true, configurable: true, enumerable: false });
        }
    }
}

installParts(AttestationResponseMirror.prototype, [build, batch, retraction, gossip, verify]);

module.exports = Object.assign(AttestationResponseMirror, {
    MIRROR_COLUMNS,
    TERMINAL_STATUSES,
    ATTEST_RESULT,
    GOSSIP_COLUMNS,
    PARK_MAX,
    PARK_RETRY_MS
});
