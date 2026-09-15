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
 * XChain Hub - PRICE batch-signing round (XPRICEB)
 *
 * The consensus round that produces the ONE quorum signature set a PRICE v0
 * batch carries. Nothing else in the platform signs batch-shaped bytes: the
 * PBFT rail signs each round separately over buildPriceV0Payload, and those
 * signatures verify only against that round's own canonical.
 *
 * Modeled on the XANCPUB publisher-attestation round in StateAnchorPublisher
 * (see :103-104 and runPublisherAttestationRound / handleAttestSignReq /
 * handleAttestSign). The shape is deliberate and is what makes the batch
 * trustworthy: the leader assembles bytes, and every co-signer INDEPENDENTLY
 * re-derives those bytes from its own finalized state before signing. A leader
 * therefore cannot obtain signatures for fabricated or partial data; the worst
 * it can do is fail to reach quorum.
 *
 * Liveness is deliberately weak and deliberately silent. A peer that disagrees
 * sends nothing at all (no NACK), exactly as the XANCPUB follower does: a NACK
 * is an unauthenticated claim about someone else's state, and acting on one
 * would hand a Byzantine peer a veto. No quorum before
 * ORACLE_BATCH_SIGN_TIMEOUT_MS simply means no batch for that window; the
 * window stays unpublished and a later leader re-proposes it (spec section 7).
 *
 ********************************************************************/

const ValidatorIdentity = require('../validators/identity.js');
const swq               = require('../stake_weighted_quorum.js');
const pst               = require('../price_sig_tally_activation.js');
const { positiveIntConfig } = require('../lib/config_int.js');
const ah                = require('../lib/admission_height.js');
const { getLogger } = require('../observability');
const logger = getLogger();

// The two sides of the round, each an object of methods installed on the
// prototype below: what a leader does with a window, and what a follower does
// with a proposal.
const leaderPart   = require('./batch_signer/leader.js');
const followerPart = require('./batch_signer/follower.js');
const PARTS = [leaderPart, followerPart];

const XPRICEB_SIGN_REQ = 'XPRICEB_SIGN_REQ';
const XPRICEB_SIGN     = 'XPRICEB_SIGN';

// Bound on the co-signed-window memo below. It exists only so OraclePublisher's
// takeover cooldown can ask "did we hand this window's leader the last thing it
// needed before broadcasting, and how long ago"; anything older than a couple of
// failover windows can no longer change that answer.
const CO_SIGNED_WINDOW_MEMO_MAX = 256;

class OracleBatchSigner {

    constructor(hub){
        this.hub         = hub;
        this.db          = hub ? hub.db : null;
        this.identity    = (hub && hub.getIdentity)     ? hub.getIdentity()     : null;
        this.peerManager = (hub && hub.getPeerManager)  ? hub.getPeerManager()  : null;
        this.capSnapshot = (hub && hub.capabilitySnapshot) ? hub.capabilitySnapshot : null;
        this.network     = (hub && hub.network) ? hub.network : '';

        let cfg = (hub && hub.p2pConfig) ? hub.p2pConfig : {};
        // Sized against the WINDOW, not against a PBFT round: the leader has already
        // waited out ORACLE_BATCH_GRACE_MS before it proposes, so a peer that is
        // briefly behind on its own mirror still has a full minute to catch up and
        // co-sign. Spending it costs an hour of publishing latency, never safety.
        this.signTimeoutMs = positiveIntConfig(cfg.ORACLE_BATCH_SIGN_TIMEOUT_MS, 60000,
            'ORACLE_BATCH_SIGN_TIMEOUT_MS');

        // At most one signing round is in flight, mirroring StateAnchorPublisher's
        // single _attestRound. Windows are assembled serially by the publisher's
        // scheduler, so a second concurrent round would mean a bug upstream, not a
        // case to support.
        this._signRound      = null;
        this._messageHandler = null;

        // 'first:last' -> ms timestamp of the co-signature this hub GAVE for that
        // proposed batch. A co-signature is the last thing a leader is waiting on
        // before it broadcasts, so this is the only local evidence a FOLLOWER has that
        // a leader's DOGE tx may already be in flight and merely unmined.
        // OraclePublisher.attemptTakeover reads it through coSignedAt() to defer a
        // takeover that would otherwise re-publish over a live transaction, the way
        // AttestationPublisher defers on its own ambiguous sends. Insertion-ordered
        // and bounded; oldest evicted first.
        this._coSigned = new Map();

        this.stats = {
            batchSignRounds:         0,   // rounds this hub has led
            batchSignQuorums:        0,   // of those, ones that reached quorum
            batchSignTimeouts:       0,   // of those, ones that expired short (spec section 7)
            batchSignaturesProvided: 0,   // co-signatures this hub has GIVEN as a peer
            batchSignRefusals:       0    // proposals this hub refused to co-sign
        };
    }

    start(){
        if(this.peerManager && !this._messageHandler){
            this._messageHandler = (env) => this._handleMessage(env);
            this.peerManager.on('message', this._messageHandler);
        }
    }

    stop(){
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if(this._signRound){
            if(this._signRound.timer){ clearTimeout(this._signRound.timer); this._signRound.timer = null; }
            if(!this._signRound.done){
                this._signRound.done = true;
                this._signRound.resolve({ met: false, sigs: [] });
            }
            this._signRound = null;
        }
    }

    getStats(){
        return Object.assign({}, this.stats, {
            batchSignTimeoutMs: this.signTimeoutMs,
            batchSignRoundActive: !!(this._signRound && !this._signRound.done),
            batchWindowsCoSigned: this._coSigned.size
        });
    }

    // ------------------------------------------------- the co-signature memo

    noteCoSigned(first, last){
        let key = first + ':' + last;
        this._coSigned.delete(key);          // re-insert so the memo stays LRU-ordered
        this._coSigned.set(key, Date.now());
        while(this._coSigned.size > CO_SIGNED_WINDOW_MEMO_MAX){
            this._coSigned.delete(this._coSigned.keys().next().value);
        }
    }

    // When did this hub last co-sign a proposed batch OVERLAPPING the round range
    // [first,last]? Null when it never did, which is the honest reading of "the leader
    // never got as far as asking, so it cannot have a tx in flight".
    //
    // Overlap, not equality: a leader splits an oversized window into several wires and
    // asks for a signature over each sub-range, so an exact-key lookup would report a
    // window nobody signed while its own sub-ranges were signed moments earlier.
    coSignedAt(first, last){
        let lo = parseInt(first), hi = parseInt(last);
        if(!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
        let newest = null;
        for(let [key, ts] of this._coSigned){
            let parts = String(key).split(':');
            let f = parseInt(parts[0]), l = parseInt(parts[1]);
            if(!Number.isFinite(f) || !Number.isFinite(l)) continue;
            if(l < lo || f > hi) continue;                       // disjoint from the window
            if(newest === null || ts > newest) newest = ts;
        }
        return newest;
    }

    checkSignQuorum(){
        let round = this._signRound;
        if(!round || round.done) return;
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._signRound = null;
        this.stats.batchSignQuorums++;
        round.resolve({
            met:  true,
            sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })),
            firstRound: round.first, lastRound: round.last, btcBlockHeight: round.anchor,
            canonical: round.canonical
        });
    }

    // ---------------------------------------------------------------- peers

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XPRICEB_SIGN_REQ:
                this.handleSignReq(envelope).catch(e =>
                    logger.error('OracleBatchSigner: XPRICEB_SIGN_REQ error: ' + (e && e.message)));
                break;
            case XPRICEB_SIGN:
                this.handleSign(envelope).catch(e =>
                    logger.error('OracleBatchSigner: XPRICEB_SIGN error: ' + (e && e.message)));
                break;
        }
    }

    async handleSign(envelope){
        let d     = envelope.data;
        let round = this._signRound;
        if(!round || round.done || !d) return;
        if(parseInt(d.first_round) !== round.first || parseInt(d.last_round) !== round.last) return;
        let pubkey = String(d.pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        this.checkSignQuorum();
    }

    // ---------------------------------------------------------------- helpers

    refuse(first, last, why){
        this.stats.batchSignRefusals++;
        logger.warn('OracleBatchSigner: refusing to co-sign batch [' + first + ',' + last + ']: ' + why);
    }

    // The ONE canonical builder. Deliberately delegated to the live OracleConsensus
    // instance rather than reimplemented: a second copy of the v2 JSON in this file
    // is exactly the drift that would make the bytes this hub signs differ from the
    // bytes the indexer verifies. Throws when the engine is not up, and every caller
    // treats that as a refusal.
    _canonical(firstRound, lastRound, btcBlockHeight, rounds){
        let oc = this.hub ? this.hub.oracleConsensus : null;
        if(!oc || typeof oc.buildPriceBatchPayload !== 'function')
            throw new Error('OracleConsensus.buildPriceBatchPayload is unavailable');
        return oc.buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds);
    }

    // Both oracle flag days are keyed on a round's own BTC anchor, while a batch
    // resolves them once on the batch anchor. Equal verdicts at the first and last
    // anchor is exactly the condition under which those two readings agree.
    //
    // The mirror admission activation is a third such key: each round carries its own
    // admission map era-keyed on its own anchor, and the ruling is that every round in a
    // batch sits in one era, so a window straddling it splits at the boundary exactly as
    // it does at the other two.
    straddlesArmedOracleFlagDay(firstAnchor, lastAnchor){
        if(swq.isStakeWeightedQuorumActive(firstAnchor, this.network) !==
           swq.isStakeWeightedQuorumActive(lastAnchor, this.network)) return true;
        if(pst.isPriceSigTallyVerifyFirstActive(firstAnchor, this.network) !==
           pst.isPriceSigTallyVerifyFirstActive(lastAnchor, this.network)) return true;
        if(ah.isAdmissionEra(this.network, firstAnchor) !==
           ah.isAdmissionEra(this.network, lastAnchor)) return true;
        return false;
    }

    // The price-capable set at a BTC anchor, resolved the way OracleConsensus
    // resolves it for a v0 round (:513-518): the deterministic on-chain capability
    // snapshot, weight-keyed at/above STAKE_WEIGHTED_QUORUM and count-keyed below,
    // so leader and followers size the same quorum from the same source.
    async resolvePriceSet(btcBlockHeight){
        if(!this.capSnapshot) return [];
        let block = Number(btcBlockHeight);
        if(swq.isStakeWeightedQuorumActive(block, this.network)){
            let snap = await this.capSnapshot.getWeightSnapshot('price', block);
            if(!snap || !Array.isArray(snap.validators)) return [];
            let set = snap.validators.map(v => ({
                pubkey: String(v.pubkey).toLowerCase(),
                amount: String(v.weight != null ? v.weight : '0'),
                source: String(v.source != null ? v.source : '')
            }));
            if(snap.truncated === true) set.truncated = true;
            return set;
        }
        let snap = await this.capSnapshot.getSnapshot('price', block);
        if(!snap || !Array.isArray(snap.validators)) return [];
        return snap.validators.map(v => ({
            pubkey: String(v.pubkey).toLowerCase(),
            amount: String(v.amount != null ? v.amount : '0'),
            source: ''
        }));
    }
}

// Install one part's methods on the prototype, non-enumerably, exactly as
// src/db/index.js installs its table mixins: a moved method stays
// indistinguishable from one declared in the class above, and a name already on
// the prototype throws rather than being silently overwritten.
function installParts(target, parts) {
    for (const part of parts) {
        const descriptors = {};
        for (const name of Object.keys(part)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate OracleBatchSigner method: ' + name + ' is already ' +
                    'defined on the prototype. Two parts, or a part and the class, claim it.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(OracleBatchSigner.prototype, PARTS);

// The admission seam. The admission tests re-arm the mirror-admission activation by
// purging this file and lib/admission_height.js from the require cache and loading both
// again, which reloads this shell but not its already-cached parts. A part that required
// admission_height itself would keep the unarmed copy, so the parts read the copy THIS
// shell loaded, through the prototype.
Object.defineProperty(OracleBatchSigner.prototype, 'admission',
    { value: ah, enumerable: false, writable: true, configurable: true });

module.exports = Object.assign(OracleBatchSigner, {

    // Named exports so the publisher and the tests reference the wire type strings
    // from one place, exactly as StateAnchorPublisher exports XANCPUB_SIGN_REQ/SIGN.
    XPRICEB_SIGN_REQ,
    XPRICEB_SIGN
});
