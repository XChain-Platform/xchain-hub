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
 * XChain Hub - Full-Node Challenge Round (verified-validator tier)
 *
 * Liveness engine that proves which validators run a real coin full node,
 * not just a decoder/indexer DB mirror synced via xchain-sync. The verified set
 * earns the full-node tranche of the oracle-round reward (see the indexer's
 * price.js / NODEPROOF). A light mirror cannot run this engine to completion: it
 * has no coin RPC, so it can neither answer the possession challenge nor verify
 * a peer's answer.
 *
 * The challenge is DERIVED, not broadcast (see NODEPROOF.md):
 *   For each epoch E (E % CHALLENGE_INTERVAL_BLOCKS == 0):
 *     seed         = ledger_hash(E)              (indexer getblockhashes)
 *     target       = E - CONFIRM_DEPTH           (buried/reorg-stable coin block)
 *     challenge_id = SHA256(NETWORK:E:seed:target)
 *     answer       = scriptPubKey(hex) of a seed-selected output in the target
 *                    block, provably absent from a synced mirror.
 *
 * Round protocol (request/sign, mirrors StateCheckpointEngine):
 *   1. XNODE_ANSWER:   every full_node claimant broadcasts a PUBKEY-BOUND digest
 *                      of its computed answer: SHA256(challenge_id|pubkey|answer)
 *                      (R2-FN2). The plaintext answer never rides the wire, so a
 *                      light mirror cannot copy an honest claimant's answer and
 *                      rebroadcast it as its own possession proof; a verifier
 *                      recomputes each claimant's expected digest from its OWN
 *                      node's answer, so no reveal phase is needed.
 *   2. XNODE_SIGN_REQ: the elected leader proposes the PASS list (claimants
 *                      whose digest matches the one derived from its own answer).
 *   3. XNODE_SIGN:     each eligible verifier recomputes the answer from ITS
 *                      OWN node, confirms every listed claimant, and signs.
 *   4. On quorum, the leader broadcasts the on-chain NODEPROOF v0 verdict and
 *      XNODE_DONE so peers stop. Pass rate tracked for reward-tier eligibility.
 *
 ********************************************************************/


const axios             = require('axios');
const ValidatorIdentity = require('../validators/identity.js');
const { isAmbiguousSendError } = require('../lib/idempotent_broadcast.js');
const { forwardableUtxos } = require('../lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('../lib/two_phase_guard.js');
const activation        = require('../lib/fullnode_activation.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

const { XNODE_ANSWER, XNODE_SIGN_REQ, XNODE_SIGN, XNODE_DONE }
    = require('./full_node_challenge_round/message_types.js');
const options = require('./full_node_challenge_round/options.js');

// One part per stage of a round, each an object of methods installed on
// FullNodeChallengeRound.prototype below. The class file keeps the wiring, the
// transports, the gossip handlers and the verdict broadcast.
const epochPart     = require('./full_node_challenge_round/epoch.js');
const verifiersPart = require('./full_node_challenge_round/verifiers.js');
const finalizePart  = require('./full_node_challenge_round/finalize.js');

// PASS-list byte comparator. The sorted list is joined into the signed verdict
// preimage, so its order is consensus, and a bare .sort() is a total order here
// only because every element happens to be lowercase 64-hex. Pin it the
// way the other consensus-feeding sorts do (indexer sweep.js / price.js). Every
// PASS sort on BOTH sides of the seam uses this one comparator; pinning one side
// alone would make the pinned verifier diverge from a still-bare producer.
const PASS_CMP = (a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'),
                                          Buffer.from(String(b), 'utf8'));

// Throttle for the truncated-verifier-set alarm. _eligibleVerifiers runs once per
// poll tick (30s by default), so an unthrottled warning would emit thousands of
// times a day for one standing condition; an hour is loud enough to be seen and
// quiet enough to stay readable. Same idiom as CapabilitySnapshot.getQuorum.
const TRUNC_WARN_THROTTLE_MS = 3600000;

// Coin ticker a signer hook was wired for, normalized the way signer-loader
// normalizes its declarations so 'btc' and 'BTC' compare equal. Anything empty
// becomes null: an untagged wiring is not a claim about a chain.
const _chainTag = (coin) => (coin === undefined || coin === null || String(coin).trim() === '')
    ? null : String(coin).trim().toUpperCase();

class FullNodeChallengeRound {

    constructor(hub){
        this.hub        = hub;
        let cfg         = hub.p2pConfig || {};
        this.cfg        = cfg;
        this.peerManager      = hub.peerManager;
        this.identity         = hub.identity;
        this.capabilitySnapshot = hub.capabilitySnapshot;

        this.network       = hub.network || cfg.HUB_NETWORK || '';

        // The pinned consensus params, the operational knobs, the genesis verifiers,
        // the verdict rail and the round state, each resolved in
        // full_node_challenge_round/options.js and assigned in this order.
        const registry = options.resolvePinnedParams(this);
        options.resolveOperationalKnobs(this, cfg);
        options.resolveGenesisVerifiers(this, registry);
        options.initVerdictRail(this, cfg);
        options.initRoundState(this);
    }

    setBroadcastHook(fn, chain){  this.broadcastFn  = fn; this._broadcastHookChain = _chainTag(chain); }
    setEncoder(enc){              this.encoder      = enc; }
    setWalletSignHook(fn, chain){ this.walletSignFn = fn; this._signHookChain      = _chainTag(chain); }

    async start(){
        if(!this.enabled){
            logger.info('FullNodeChallengeRound: disabled');
            return;
        }
        if(this.peerManager) this.peerManager.on('message', this._handler);
        // Consume the spend log BEFORE the first tick, or the recovered epochs arrive
        // too late to gate the round that tick reconstructs. Same reason
        // the spend window is reloaded here and not lazily.
        this.loadSpendLog();
        this.spendGuard.persistTo();
        let tick = async () => { try { await this._tick(); } catch(e){ logger.warn(nodeUtil.format('FullNodeChallengeRound tick:', e && e.message ? e.message : e)); } };
        this._timer = setInterval(tick, this.pollMs);
        await tick();
        logger.info('FullNodeChallengeRound started (interval=' + this.interval + ' blocks, depth=' + this.confirmDepth +
                    ', verifier=' + (this.coinRpcUrl ? 'yes' : 'NO coin RPC (observe-only)') + ', tier=' +
                    activation.describeActivation(this.cfg.FULLNODE) + ', ' +
                    this._committedEpochs.size + ' epoch(s) already spent per the spend log)');
    }

    async stop(){
        if(this._timer) clearInterval(this._timer);
        this._timer = null;
        if(this.peerManager) this.peerManager.removeListener('message', this._handler);
    }

    async _indexerCall(method, params){
        // Resolve the BTC indexer URL the same way the rest of the hub does
        // (BTC_INDEXER_API_URL -> BTC_INDEXER_URL -> config), so a standard hub
        // deployment that only sets BTC_INDEXER_API_URL still reaches the indexer.
        // Fall back to the env/cfg value captured at construction.
        let url = this.indexerUrl;
        if(this.hub && typeof this.hub._resolveBtcIndexerUrl === 'function'){
            try { url = (await this.hub._resolveBtcIndexerUrl()) || this.indexerUrl; } catch(_){}
        }
        if(!url) throw new Error('no BTC indexer URL (set BTC_INDEXER_API_URL / BTC_INDEXER_URL)');
        let headers = (this.hub && typeof this.hub.btcIndexerHeaders === 'function')
            ? this.hub.btcIndexerHeaders()
            : Object.assign({ 'Content-Type': 'application/json' }, this.indexerKey ? { 'x-api-key': this.indexerKey } : {});
        let resp = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        let result = resp.data ? resp.data.result : null;
        // The indexer reports failures in-band as result.error (a 200 with an error
        // object), not the top-level JSON-RPC error envelope; the rest of the hub
        // (CapabilitySnapshot, AttestationRound) already gates on result.error. Surface
        // it here too so a poll error reaches the caller's catch instead of being
        // returned as a valid result and silently degrading the verifier set.
        if(result && result.error) throw new Error('indexer in-band error: ' + JSON.stringify(result.error));
        return result;
    }

    async coinCall(method, params){
        if(!this.coinRpcUrl) throw new Error('no coin RPC');
        let resp = await axios.post(this.coinRpcUrl, { jsonrpc: '1.0', id: 'fnproof', method, params: params || [] }, { timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('coin RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    async closeCollection(epoch){
        let state = this.rounds.get(epoch);
        if(!state) return;
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;

        // The PASS proposal below only applies while the round is still live.
        if(state.finalized) return;

        // Leader proposes the PASS list: claimants whose pubkey-bound digest
        // matches the digest derived from OUR OWN node's answer (R2-FN2).
        if(this.isLeader(state, myPubkey) && state.myAnswer && !state.passList){
            let pass = [];
            for(let pk of state.claimants){
                if(state.answers.get(pk) === this.answerDigest(state.challengeId, pk, state.myAnswer)) pass.push(pk);
            }
            pass.sort(PASS_CMP);
            state.passList = pass;
            if(pass.length > 0){
                // Self-sign, then request peer signatures.
                let sig = this.identity.sign(this.verdictCanonical(state.challengeId, epoch, pass));
                state.sigs.set(myPubkey, sig);
                this.peerManager && this.peerManager.broadcast(XNODE_SIGN_REQ, {
                    epoch, challengeId: state.challengeId, target: state.target, passList: pass,
                    sig_pubkey: myPubkey
                });
                await this.maybeFinalize(epoch);
            }
        }
    }

    _handleMessage(env){
        if(!env || !env.data) return;
        switch(env.type){
            case XNODE_ANSWER:   return this.onAnswer(env.data);
            case XNODE_SIGN_REQ: return this.onSignReq(env.data);
            case XNODE_SIGN:     return this.onSign(env.data);
            case XNODE_DONE:     return this.onDone(env.data);
        }
    }

    onAnswer(d){
        let state = this.rounds.get(Number(d.epoch));
        if(!state || state.finalized) return;
        let pk = String(d.sig_pubkey || '').toLowerCase();
        if(!pk || !state.claimants.has(pk)) return;            // only staked claimants count
        if(!/^[0-9a-fA-F]{64}$/.test(pk)) return;
        if(String(d.challengeId) !== state.challengeId) return;
        // R2-FN2: the wire carries a pubkey-bound digest, not the answer. A
        // 64-hex shape gate keeps junk out of the map; the digest itself is
        // validated against this hub's own recomputation at compare time
        // (closeCollection / onSignReq), so a copied digest from ANOTHER
        // claimant can never match this sender's expected digest.
        let digest = String(d.answer_digest || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(digest)) return;
        if(!ValidatorIdentity.verify(this.answerCanonical(state.challengeId, digest), String(d.sig || ''), pk)) return;
        if(!state.answers.has(pk)) state.answers.set(pk, digest);
    }

    async onSignReq(d){
        let state = this.rounds.get(Number(d.epoch));
        if(!state || state.finalized) return;
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        if(!myPubkey || !state.eligible.has(myPubkey)) return;  // only eligible verifiers sign
        if(String(d.challengeId) !== state.challengeId) return;
        let leader = String(d.sig_pubkey || '').toLowerCase();
        if(!state.eligible.has(leader)) return;

        // Verify the sender is the currently-elected leader before locking the
        // passList. An eligible non-leader that broadcasts XNODE_SIGN_REQ first
        // could lock in a censoring pass list before the elected leader's proposal
        // arrives. Buffer non-leader messages by ignoring them here; the true
        // leader's SIGN_REQ will arrive and be accepted normally.
        let electedLeader = this._electedLeader(state);
        if(leader !== electedLeader) return;

        let pass = Array.isArray(d.passList) ? d.passList.map(p => String(p).toLowerCase()) : [];
        // We must INDEPENDENTLY confirm every listed claimant against our OWN node.
        if(!this.coinRpcUrl) return;
        if(state.myAnswer == null){
            try { state.myAnswer = await this.computeAnswer(state.target, state.seed); }
            catch(e){ return; }
        }
        let passSet = new Set(pass);
        for(let pk of pass){
            if(!state.claimants.has(pk)) return;                // outsider in the list
            let a = state.answers.get(pk);
            // R2-FN2: confirm the claimant's pubkey-bound digest against the one
            // derived from OUR OWN node's answer. A digest copied from another
            // claimant hashes over the wrong pubkey and never matches.
            if(a === undefined || a !== this.answerDigest(state.challengeId, pk, state.myAnswer)) return; // can't confirm: refuse to sign
        }
        // Completeness (R2-FN3): the leader could silently DROP an honest claimant
        // from the pass list (the loop above only validates listed entries, not
        // omissions). Refuse to sign unless the list is a superset of every
        // claimant we have INDEPENDENTLY confirmed correct against our own node,
        // so a censoring leader cannot exclude an honest full node with our
        // signature. (Answers still in flight are simply not yet in our set, so
        // this never forces a premature refusal; the round re-signs as they land.)
        for(let [pk, a] of state.answers){
            if(state.claimants.has(pk) && a === this.answerDigest(state.challengeId, pk, state.myAnswer) && !passSet.has(pk)) return;
        }
        let sorted = pass.slice().sort(PASS_CMP);
        let sig = this.identity.sign(this.verdictCanonical(state.challengeId, state.epoch, sorted));
        if(!state.passList) state.passList = sorted;
        state.sigs.set(myPubkey, sig);
        this.peerManager && this.peerManager.broadcast(XNODE_SIGN, {
            epoch: state.epoch, challengeId: state.challengeId, sig_pubkey: myPubkey, sig
        });
    }

    async onSign(d){
        let state = this.rounds.get(Number(d.epoch));
        if(!state || state.finalized || !state.passList) return;
        let pk = String(d.sig_pubkey || '').toLowerCase();
        if(!pk || !state.eligible.has(pk)) return;
        if(String(d.challengeId) !== state.challengeId) return;
        let canonical = this.verdictCanonical(state.challengeId, state.epoch, state.passList.slice().sort(PASS_CMP));
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), pk)) return;
        state.sigs.set(pk, String(d.sig));
        await this.maybeFinalize(state.epoch);
    }

    // NODEPROOF|0|CHALLENGE_ID|EPOCH_HEIGHT|PASS_COUNT|PASS_PK...|SIG_COUNT|PK|SIG|...
    buildVerdictWire(state){
        let pass = state.passList.slice().sort(PASS_CMP);
        let sigTokens = [];
        for(let [pk, sig] of state.sigs.entries()) sigTokens.push(pk, sig);
        let parts = ['NODEPROOF', '0', state.challengeId, String(state.epoch), String(pass.length)]
            .concat(pass)
            .concat([String(state.sigs.size)])
            .concat(sigTokens);
        return parts.join('|');
    }

    async broadcastVerdict(wire){
        // Second gate on the same fact, for every caller that does not come through
        // maybeFinalize. Refuse before the hook runs and before the encoder fetches a
        // UTXO, so a wrong-chain wiring costs nothing.
        let chainMismatch = this.signerChainMismatch();
        if(chainMismatch){
            if(!this._chainMismatchWarned){ this._chainMismatchWarned = true; logger.warn(chainMismatch); }
            throw new Error(chainMismatch);
        }
        if(this.broadcastFn) return await this.broadcastFn(wire);
        if(this.encoder && this.walletSignFn && this.btcAddress){
            // Same three-step encoder contract the sibling publishers use
            // (AttestationPublisher / OraclePublisher / AttestationRelay /
            // StateAnchorPublisher _defaultBroadcast): fetch UTXOs, then create_tx with
            // {utxos, pubkey, data, change, encoding}. This path used to send
            // {source, data}: `source` is not an encoder param at all (validateAll
            // ignores it) and an absent pubkey is rejected up front with
            // RangeError('pubkey is required') -> -32602, so the fallback threw before a
            // PSBT was ever built and no NODEPROOF verdict could land on it.
            let utxos = await this.encoder.getUtxos(this.btcAddress);
            if(!utxos || (Array.isArray(utxos) && utxos.length === 0))
                throw new Error('no UTXOs available for ' + this.btcAddress);
            let built = await this.encoder.createTx({
                // Forwarded only while inside the encoder's caller-facing
                // MAX_UTXO_COUNT; past it the param is omitted so the encoder selects
                // from its own uncapped fetch of this same address
                // (lib/encoder_utxo_forward.js).
                utxos:    forwardableUtxos(utxos, 'FullNodeChallengeRound'),
                // The encoder's P2SH path runs bitcoin.address.fromBase58Check() on this
                // field, so it must be the base58check address, not the raw hex pubkey.
                pubkey:   this.btcAddress,
                data:     wire,
                change:   this.btcAddress,
                // A NODEPROOF verdict carries the pass list plus a pubkey+sig pair per
                // co-signer, far past the 80-byte OP_RETURN limit.
                encoding: 'P2SH'
            });
            // create_tx answers with `psbt` (plus `revealPsbt` for TAPROOT) and never
            // psbtHex/hex, so the old alternates could only ever mask a missing PSBT by
            // handing undefined to the wallet signer.
            if(!built || !built.psbt) throw new Error('encoder returned no PSBT');
            // Refuse phase 1 of a two-transaction encoding before anything is signed: this
            // pipeline has no reveal, so broadcasting the P2SH funding tx would publish a
            // NODEPROOF verdict no indexer can decode and strand the carrier value
            // (lib/two_phase_guard.js).
            assertSingleTxEncoding(built, 'FullNodeChallengeRound');
            let txHex = await this.walletSignFn(built.psbt);
            if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
            return await this.encoder.broadcastTx(txHex);
        }
        throw new Error('no broadcast pipeline (set broadcast hook, or encoder + wallet-sign + BTC_ADDRESS)');
    }
}

// The parts go on with enumerable false, NOT Object.assign, for the reason
// src/db/index.js gives at its own install: class methods are non-enumerable, so
// assigned members would be the only ones for...in and Object.keys(prototype) can
// see, which changes what the prototype enumerates. writable and configurable stay
// true so a test can still stub and restore a moved method.
function installParts(target, parts) {
    for(const part of parts) {
        const descriptors = {};
        for(const name of Object.keys(part)) {
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate full-node round method: ' + name + ' is already defined on ' +
                    'FullNodeChallengeRound.prototype. Two parts, or a part and the class, claim the same name.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(FullNodeChallengeRound.prototype, [epochPart, verifiersPart, finalizePart]);

module.exports = Object.assign(FullNodeChallengeRound, {
    XNODE_ANSWER,
    XNODE_SIGN_REQ,
    XNODE_SIGN,
    XNODE_DONE
});
