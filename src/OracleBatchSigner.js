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
 * PBFT rail signs each round separately over _buildPriceV0Payload, and those
 * signatures verify only against that round's own canonical.
 *
 * Modeled on the XANCPUB publisher-attestation round in StateAnchorPublisher
 * (see :103-104 and _runPublisherAttestationRound / _handleAttestSignReq /
 * _handleAttestSign). The shape is deliberate and is what makes the batch
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

const ValidatorIdentity = require('./ValidatorIdentity.js');
const swq               = require('./stake_weighted_quorum.js');
const pst               = require('./price_sig_tally_activation.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const { positiveIntConfig } = require('./lib/config_int.js');
const { PRICE_BATCH_MAX_ROUND_COUNT } = require('./price_batch_compression.js');

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
        // OraclePublisher._attemptTakeover reads it through coSignedAt() to defer a
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

    _noteCoSigned(first, last){
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

    // ---------------------------------------------------------------- leader

    // Run the batch-signing round for a window THIS hub is publishing.
    //
    // `rounds` is the canonical builder's input shape,
    // [{ round, timestamp, btcBlockHeight, pairs:[{pair|coinPair, price}] }].
    //
    // Resolves { met, sigs:[{pubkey,sig}], firstRound, lastRound, btcBlockHeight,
    // canonical } once a BFT quorum of the price-capable set AT THE BATCH ANCHOR
    // has co-signed, or { met:false } on timeout / short quorum / an unresolvable
    // set. On met:false the caller publishes NOTHING for this window: the sigs
    // collected so far are returned for observability only, never for a wire.
    async collectBatchSignatures(firstRound, lastRound, btcBlockHeight, rounds){
        let first  = parseInt(firstRound);
        let last   = parseInt(lastRound);
        let anchor = parseInt(btcBlockHeight);
        let empty  = { met: false, sigs: [], firstRound: first, lastRound: last, btcBlockHeight: anchor };

        if(!Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(anchor) ||
           first < 0 || last < first) return empty;
        if(!Array.isArray(rounds) || rounds.length === 0 || rounds.length > PRICE_BATCH_MAX_ROUND_COUNT) return empty;
        if(!this.identity) return empty;

        this.stats.batchSignRounds++;

        let canonical;
        try {
            canonical = this._canonical(first, last, anchor, rounds);
        } catch(e){
            console.warn('OracleBatchSigner: cannot build the batch canonical for window [' + first + ',' + last +
                         '] (' + (e && e.message) + '); no batch for this window');
            return empty;
        }

        // The SIGNING set is the price-capable set at the BATCH ANCHOR, which is the
        // same set (and the same anchor) the indexer's _parseV0 resolves the wire's
        // quorum against. Resolving it anywhere else would let this hub collect a
        // quorum the chain then rejects, spending a DOGE fee for an invalid action.
        let signingSet;
        try {
            signingSet = await this._resolvePriceSet(anchor);
        } catch(e){
            console.warn('OracleBatchSigner: price capability set unresolvable at anchor ' + anchor +
                         ' (' + (e && e.message) + '); no batch for window [' + first + ',' + last + ']');
            return empty;
        }

        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        let me             = this.identity.getPubkeyHex().toLowerCase();

        // An unresolved (empty) set is not a quorum of one. Self-signing here would
        // emit a wire carrying a single signature that every indexer rejects, because
        // the indexer resolves a non-empty set at the same anchor. Withhold instead:
        // the rounds are still in the buffer and a later window re-proposes them.
        if(snapCount === 0){
            console.warn('OracleBatchSigner: zero price-capable validators at anchor ' + anchor +
                         '; withholding the batch for window [' + first + ',' + last + ']');
            return empty;
        }
        // This hub must itself hold `price` at the anchor, or its own signature is
        // not counted by the verifier and the quorum arithmetic below is fiction.
        if(!signingPubkeys.includes(me)) return empty;

        let mySig      = this.identity.sign(canonical);
        let signatures = new Map();
        signatures.set(me, mySig);

        // Genuine single-member set (membership proven above): this hub's own
        // signature IS the quorum, matching bftQuorumOrSingle's single-node bypass.
        if(snapCount <= 1 || !this.peerManager){
            this.stats.batchSignQuorums++;
            return { met: true, sigs: [{ pubkey: me, sig: mySig }],
                     firstRound: first, lastRound: last, btcBlockHeight: anchor, canonical: canonical };
        }

        return await new Promise((resolve) => {
            let weighted = swq.isStakeWeightedQuorumActive(anchor, this.network);
            let quorum   = bftQuorumOrSingle(snapCount, 1);
            let roundValidators = signingSet.map(v => ({
                pubkey: v.pubkey,
                source: String(v.source != null ? v.source : ''),
                weight: String(v.amount != null ? v.amount : '0')
            }));
            // Carry the truncation flag through so meetsStakeThreshold fails CLOSED on
            // an over-cap snapshot, identical to the XANCPUB rounds. Without it a
            // truncated set under-counts total stake and a stake-evicted minority
            // could clear the 2/3 bar here while the indexer's own check rejects it.
            if(signingSet.truncated === true) roundValidators.truncated = true;

            let round = {
                first, last, anchor, canonical, quorum, weighted, resolve,
                validators: roundValidators,
                signatures, done: false, timer: null
            };
            this._signRound = round;
            round.timer = setTimeout(() => {
                if(this._signRound === round && !round.done){
                    round.done = true;
                    this._signRound = null;
                    this.stats.batchSignTimeouts++;
                    console.warn('OracleBatchSigner: batch-signing round for window [' + first + ',' + last +
                                 '] at anchor ' + anchor + ' timed out at ' + round.signatures.size + '/' +
                                 quorum + ' sigs; window stays unpublished');
                    resolve({ met: false, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })),
                              firstRound: first, lastRound: last, btcBlockHeight: anchor });
                }
            }, this.signTimeoutMs);
            if(round.timer.unref) round.timer.unref();

            // The request carries the exact canonical INPUT, not the canonical bytes:
            // peers must rebuild those from their own state, and shipping the bytes
            // would invite a peer to sign what it was handed.
            this.peerManager.broadcast(XPRICEB_SIGN_REQ, {
                first_round:      first,
                last_round:       last,
                btc_block_height: anchor,
                rounds:           rounds
            });
            this._checkSignQuorum();
        });
    }

    _checkSignQuorum(){
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
                this._handleSignReq(envelope).catch(e =>
                    console.error('OracleBatchSigner: XPRICEB_SIGN_REQ error: ' + (e && e.message)));
                break;
            case XPRICEB_SIGN:
                this._handleSign(envelope).catch(e =>
                    console.error('OracleBatchSigner: XPRICEB_SIGN error: ' + (e && e.message)));
                break;
        }
    }

    // Follower: co-sign a proposed batch ONLY when this hub reproduces its canonical
    // bytes byte-for-byte from its OWN finalized price_snapshots. Every refusal is
    // SILENT (logged locally, nothing sent), because the only honest answer to "I
    // cannot reproduce that" is to withhold a signature.
    async _handleSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !this.peerManager || !this.db) return;

        let sender = String(envelope.sig_pubkey || '').toLowerCase();
        if(sender && sender === this.identity.getPubkeyHex().toLowerCase()) return;   // own broadcast echo

        let first = parseInt(d.first_round);
        let last  = parseInt(d.last_round);
        if(!Number.isFinite(first) || !Number.isFinite(last) || first < 0 || last < first) return;
        // Bound the proposed window BEFORE any DB work: first/last are attacker-chosen,
        // and an unbounded range is a query-cost amplifier on every price validator.
        if((last - first + 1) > PRICE_BATCH_MAX_ROUND_COUNT) return;
        if(!Array.isArray(d.rounds) || d.rounds.length === 0 || d.rounds.length > PRICE_BATCH_MAX_ROUND_COUNT) return;

        let mine;
        try {
            mine = await this._deriveWindow(first, last);
        } catch(e){
            this._refuse(first, last, 'local price_snapshots unreadable (' + (e && e.message) + ')');
            return;
        }
        // No finalized round of our own in the window: we have nothing to attest with.
        // This is the honest "the whole window is skipped here" case as well.
        if(mine.length === 0){ this._refuse(first, last, 'no finalized rounds in the window locally'); return; }

        // A round this hub ingested from a batch that ALREADY LANDED cannot be
        // re-derived here. PriceAggregator.receiveBatch pins
        // price_snapshots.reference_block to the LANDING chain's block_index (spec
        // §5.7 / D8), not to the round's own BTC anchor, so the row simply no longer
        // carries the height the canonical needs; on testnet round 116 was stored at
        // DOGE height 67856096 where its BTC anchor was 150176. Comparing that as if
        // it were a BTC anchor produced a bare "does not match" refusal on every
        // re-proposal of window [114,119] - a window that had in fact already
        // published. Say so instead: an already-landed round is not signable content.
        let landed = mine.filter(r => r.batchSourced).map(r => r.round);
        if(landed.length){
            this._refuse(first, last, 'round(s) ' + landed.join(',') + ' here came from a batch that ' +
                'already landed on chain, so their own BTC anchor is no longer recoverable from ' +
                'price_snapshots (reference_block holds the landing block); this window has ' +
                'already published and there is nothing left to co-sign');
            return;
        }

        // The batch anchor is the LAST included round's own anchor (spec section 4).
        // Deriving it rather than trusting d.btc_block_height is what keeps a lying
        // header from steering which capability set and which flag-day verdict this
        // signature is judged under; a mismatch also fails the byte comparison below.
        let myAnchor    = parseInt(mine[mine.length - 1].btcBlockHeight);
        let firstAnchor = parseInt(mine[0].btcBlockHeight);

        // A window straddling an armed oracle flag day is INVALID on the chain
        // (spec section 5.4): a batch resolves the sig-tally and stake-weighted gates
        // ONCE on the batch anchor, so signing a straddling window would judge its
        // earlier rounds under a rule set they never finalized under.
        if(this._straddlesArmedOracleFlagDay(firstAnchor, myAnchor)){
            this._refuse(first, last, 'window straddles an armed oracle flag day (anchors ' +
                         firstAnchor + '..' + myAnchor + ')');
            return;
        }

        // Only co-sign if WE hold `price` at the batch anchor: otherwise the indexer
        // drops this signature from the tally and it is dead weight on the wire.
        let signingSet;
        try {
            signingSet = await this._resolvePriceSet(myAnchor);
        } catch(e){
            this._refuse(first, last, 'price capability set unresolvable at anchor ' + myAnchor);
            return;
        }
        let me = this.identity.getPubkeyHex().toLowerCase();
        if(!signingSet.some(v => v.pubkey === me)){
            this._refuse(first, last, 'this hub does not hold `price` at anchor ' + myAnchor);
            return;
        }

        // THE SAFETY PROPERTY. `theirs` is built from the proposal exactly as sent;
        // `ours` from our own rows. Equality of the two canonical STRINGS is the only
        // thing that unlocks a signature, so a fabricated price, a dropped round, an
        // injected round, a shifted timestamp or a re-pointed anchor all land here as
        // an ordinary string inequality. Both go through the ONE canonical builder
        // (OracleConsensus._buildPriceBatchPayload), so there is no second spelling of
        // the format for the two sides to disagree about.
        let ours, theirs;
        try {
            ours   = this._canonical(first, last, myAnchor, mine);
            theirs = this._canonical(d.first_round, d.last_round, d.btc_block_height, d.rounds);
        } catch(e){
            this._refuse(first, last, 'canonical build failed (' + (e && e.message) + ')');
            return;
        }
        if(ours !== theirs){
            // Name WHAT diverged. The bare form of this line was the whole
            // diagnostic an operator got for a window that never published, and it
            // cannot be reproduced after the fact: the leader's proposal is not
            // persisted anywhere. One bounded clause naming the first differing round
            // and field is the difference between "the federation disagrees" and a
            // fix. Never dump the pair lists themselves - a 37-pair round would put
            // kilobytes per refusal into the log.
            this._refuse(first, last, 'proposal does not match this hub\'s own finalized rounds (' +
                         this._describeMismatch(d, mine, myAnchor) + ')');
            return;
        }

        this.stats.batchSignaturesProvided++;
        // Note the co-signature BEFORE it goes out: from here on the leader can
        // broadcast at any moment, and a takeover armed against this window must
        // treat "not on chain" as ambiguous rather than as leader silence.
        this._noteCoSigned(first, last);
        this.peerManager.broadcast(XPRICEB_SIGN, {
            first_round: first,
            last_round:  last,
            pubkey:      me,
            sig:         this.identity.sign(ours)
        });
    }

    async _handleSign(envelope){
        let d     = envelope.data;
        let round = this._signRound;
        if(!round || round.done || !d) return;
        if(parseInt(d.first_round) !== round.first || parseInt(d.last_round) !== round.last) return;
        let pubkey = String(d.pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        this._checkSignQuorum();
    }

    // ---------------------------------------------------------------- helpers

    _refuse(first, last, why){
        this.stats.batchSignRefusals++;
        console.warn('OracleBatchSigner: refusing to co-sign batch [' + first + ',' + last + ']: ' + why);
    }

    // One bounded clause naming the FIRST real difference between a proposal and this
    // hub's own rows. Diagnostic only: the refusal is already decided by the canonical
    // byte comparison, and nothing here may change that verdict.
    //
    // Deliberately shallow. It reports the first differing round and the first
    // differing field within it, never a full diff, so a hub refusing an entire window
    // every ten minutes cannot flood its own log.
    _describeMismatch(proposal, mine, myAnchor){
        let parts = [];
        let theirAnchor = parseInt(proposal.btc_block_height);
        if(Number.isFinite(theirAnchor) && theirAnchor !== myAnchor)
            parts.push('batch anchor proposed ' + theirAnchor + ', derived ' + myAnchor);

        let theirRounds = Array.isArray(proposal.rounds) ? proposal.rounds : [];
        let theirByRound = new Map();
        for(let r of theirRounds){
            let n = parseInt(r && r.round);
            if(Number.isFinite(n)) theirByRound.set(n, r);
        }
        let mineByRound = new Map(mine.map(r => [r.round, r]));

        let onlyProposed = Array.from(theirByRound.keys()).filter(n => !mineByRound.has(n)).sort((a,b) => a-b);
        let onlyMine     = Array.from(mineByRound.keys()).filter(n => !theirByRound.has(n)).sort((a,b) => a-b);
        if(onlyProposed.length) parts.push('round(s) ' + onlyProposed.join(',') + ' proposed but not finalized here');
        if(onlyMine.length)     parts.push('round(s) ' + onlyMine.join(',') + ' finalized here but not proposed');

        for(let n of Array.from(mineByRound.keys()).sort((a,b) => a-b)){
            let t = theirByRound.get(n);
            if(!t) continue;
            let m    = mineByRound.get(n);
            let diff = this._firstRoundFieldDiff(n, t, m);
            if(diff){ parts.push(diff); break; }
        }
        return parts.length ? parts.join('; ') : 'no field-level difference found, so the two sides ' +
               'disagree on the canonical ENCODING rather than its content';
    }

    // The first differing field of one round, or null when the two agree. Pair sets
    // are compared by name and price; only the first offending pair is named.
    _firstRoundFieldDiff(round, theirs, mine){
        let at = 'round ' + round + ' ';
        if(parseInt(theirs.btcBlockHeight != null ? theirs.btcBlockHeight : theirs.btc_block_height) !== mine.btcBlockHeight)
            return at + 'anchor proposed ' +
                   parseInt(theirs.btcBlockHeight != null ? theirs.btcBlockHeight : theirs.btc_block_height) +
                   ', derived ' + mine.btcBlockHeight;
        if(parseInt(theirs.timestamp) !== mine.timestamp)
            return at + 'timestamp proposed ' + parseInt(theirs.timestamp) + ', derived ' + mine.timestamp;

        let theirPairs = new Map((Array.isArray(theirs.pairs) ? theirs.pairs : [])
            .map(p => [String(p.coinPair || p.pair), String(p.price)]));
        let minePairs  = new Map(mine.pairs.map(p => [String(p.pair), String(p.price)]));
        for(let [name, price] of theirPairs){
            if(!minePairs.has(name)) return at + 'pair ' + name + ' proposed but not finalized here';
            if(minePairs.get(name) !== price)
                return at + 'pair ' + name + ' price proposed ' + price + ', derived ' + minePairs.get(name);
        }
        for(let name of minePairs.keys())
            if(!theirPairs.has(name)) return at + 'pair ' + name + ' finalized here but not proposed';
        return null;
    }

    // The ONE canonical builder. Deliberately delegated to the live OracleConsensus
    // instance rather than reimplemented: a second copy of the v2 JSON in this file
    // is exactly the drift that would make the bytes this hub signs differ from the
    // bytes the indexer verifies. Throws when the engine is not up, and every caller
    // treats that as a refusal.
    _canonical(firstRound, lastRound, btcBlockHeight, rounds){
        let oc = this.hub ? this.hub.oracleConsensus : null;
        if(!oc || typeof oc._buildPriceBatchPayload !== 'function')
            throw new Error('OracleConsensus._buildPriceBatchPayload is unavailable');
        return oc._buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds);
    }

    // Rebuild the canonical builder's `rounds` input from THIS hub's own finalized
    // price_snapshots, ascending.
    //
    // status = 'finalized' rather than "not skipped" is the deliberate reading of
    // spec section 6's "non-skipped row": the third enum value, 'disputed', marks a
    // row a reorg RETRACTED (ReorgHandler.js:628), and retracted content must never
    // be signed into a batch. The same filter also drops the per-pair 'skipped'
    // markers _storeSnapshot writes for pairs absent from an otherwise-finalized
    // round, which is what keeps a round's pair list identical to the one the v0
    // canonical for that round carried.
    // proof_head is the first characters of consensus_proof, which is the ONE field
    // that tells a batch-sourced row from a locally-finalized one: a v0 row's proof is
    // a bare signature ARRAY, a batch-sourced row's is the {"batch":...} object of D23
    // (the same prefix test OraclePublisher._pruneObservedWindow and
    // PriceAggregator.retractFromActionIndex use). It matters here because a
    // batch-sourced row's reference_block is the LANDING chain's height, not the
    // round's BTC anchor, so reading it as an anchor invents a number.
    async _deriveWindow(firstRound, lastRound){
        let rows = await this.db.doQuery(
            'SELECT round_number, coin_pair, price, reference_block, block_timestamp, ' +
            'LEFT(consensus_proof, 8) AS proof_head ' +
            'FROM price_snapshots WHERE round_number >= ? AND round_number <= ? AND status = ? ' +
            'ORDER BY round_number ASC, coin_pair ASC',
            [firstRound, lastRound, 'finalized']);

        let byRound = new Map();
        for(let r of (rows || [])){
            let key = parseInt(r.round_number);
            if(!Number.isFinite(key)) continue;
            let entry = byRound.get(key);
            if(!entry){
                entry = { round: key, timestamp: parseInt(r.block_timestamp),
                          btcBlockHeight: parseInt(r.reference_block), pairs: [],
                          batchSourced: String(r.proof_head || '').indexOf('{"batch"') === 0 };
                byRound.set(key, entry);
            } else if(parseInt(r.block_timestamp) !== entry.timestamp ||
                      parseInt(r.reference_block) !== entry.btcBlockHeight){
                // One round's rows are written by a single multi-row INSERT, so a
                // per-pair disagreement means local corruption. Fail the whole window
                // closed rather than pick a winner and sign an invented round header.
                throw new Error('inconsistent anchor/timestamp across round ' + key);
            }
            entry.pairs.push({ pair: String(r.coin_pair), price: String(r.price) });
        }
        return Array.from(byRound.values()).sort((a, b) => a.round - b.round);
    }

    // Both oracle flag days are keyed on a round's own BTC anchor, while a batch
    // resolves them once on the batch anchor. Equal verdicts at the first and last
    // anchor is exactly the condition under which those two readings agree.
    _straddlesArmedOracleFlagDay(firstAnchor, lastAnchor){
        if(swq.isStakeWeightedQuorumActive(firstAnchor, this.network) !==
           swq.isStakeWeightedQuorumActive(lastAnchor, this.network)) return true;
        if(pst.isPriceSigTallyVerifyFirstActive(firstAnchor, this.network) !==
           pst.isPriceSigTallyVerifyFirstActive(lastAnchor, this.network)) return true;
        return false;
    }

    // The price-capable set at a BTC anchor, resolved the way OracleConsensus
    // resolves it for a v0 round (:513-518): the deterministic on-chain capability
    // snapshot, weight-keyed at/above STAKE_WEIGHTED_QUORUM and count-keyed below,
    // so leader and followers size the same quorum from the same source.
    async _resolvePriceSet(btcBlockHeight){
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

module.exports = OracleBatchSigner;

// Named exports so the publisher and the tests reference the wire type strings
// from one place, exactly as StateAnchorPublisher exports XANCPUB_SIGN_REQ/SIGN.
module.exports.XPRICEB_SIGN_REQ = XPRICEB_SIGN_REQ;
module.exports.XPRICEB_SIGN     = XPRICEB_SIGN;
