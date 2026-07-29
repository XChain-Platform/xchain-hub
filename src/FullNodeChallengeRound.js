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

const crypto            = require('crypto');
const axios             = require('axios');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const EncoderClient      = require('./EncoderClient.js');
const SpendGuard         = require('./lib/spend_guard.js');
const { isAmbiguousSendError } = require('./lib/idempotent_broadcast.js');
const eq                = require('./equivocation_header.js');
const activation        = require('./lib/fullnode_activation.js');
// Pinned coin registry: the single source for the consensus-relevant FULLNODE
// parameters (). See the constructor.
const coins             = require('./coins/index.js');

const XNODE_ANSWER   = 'XNODE_ANSWER';
const XNODE_SIGN_REQ = 'XNODE_SIGN_REQ';
const XNODE_SIGN     = 'XNODE_SIGN';
const XNODE_DONE     = 'XNODE_DONE';

class FullNodeChallengeRound {

    constructor(hub){
        this.hub        = hub;
        let cfg         = hub.p2pConfig || {};
        this.cfg        = cfg;
        this.peerManager      = hub.peerManager;
        this.identity         = hub.identity;
        this.capabilitySnapshot = hub.capabilitySnapshot;

        this.network       = hub.network || cfg.HUB_NETWORK || '';

        // : the CONSENSUS-relevant full-node params come from the PINNED coin
        // registry, never from env or literals.
        //
        // These used to resolve `process.env.FULLNODE_* || cfg.FULLNODE.* || '<literal>'`.
        // That read the env FIRST on every network, so on MAINNET an operator env var
        // silently overrode a pinned consensus parameter, and CONSENSUS_CONFIG_PIN still
        // verified clean because the pin covers the registry, not what this class
        // actually used. Two hubs with different FULLNODE_CONFIRM_DEPTH would compute
        // different possession answers and different PASS lists while both reported a
        // matching pin. The literals were a third, unpinned source of the same values.
        //
        // coins.getCoinConfig() is the single source now. It already applies the
        // regtest-only sidecar and env overrides internally (resolveFullnode), so
        // regtest keeps its tunability through the DESCRIBED surface, while
        // mainnet/testnet get the frozen pinned values with no env surface at all.
        // FULLNODE is BTC-only: the tier is BTC-anchored.
        const registry = coins.getCoinConfig('BTC', this.network).FULLNODE || {};
        this.registryFullnode = registry;
        this.interval      = parseInt(registry.CHALLENGE_INTERVAL_BLOCKS, 10);
        this.confirmDepth  = parseInt(registry.CONFIRM_DEPTH, 10);
        this.acceptWindow  = parseInt(registry.VERDICT_ACCEPT_WINDOW_BLOCKS, 10);
        // Collection closes when the tip reaches epoch + closeDepth blocks, anchored
        // to chain height (shared by all hubs), NOT each hub's local detection time,
        // so the leader has every claimant's answer before it proposes the PASS list.
        // Pinned in the registry for that reason (see BTC.js COLLECT_DEPTH_BLOCKS).
        this.closeDepth    = parseInt(registry.COLLECT_DEPTH_BLOCKS, 10);

        // Conformance assert: every consensus param must have resolved to a usable
        // value FROM THE REGISTRY. A NaN here means the registry lost a key (or this
        // hub is pointed at a network whose bundle lacks the block), and running on a
        // NaN interval would silently disable challenge rounds rather than fail. Fail
        // closed and name the key, so a registry regression surfaces at boot instead of
        // as a quorum that mysteriously never forms.
        for(const [key, value] of Object.entries({
            CHALLENGE_INTERVAL_BLOCKS:    this.interval,
            CONFIRM_DEPTH:                this.confirmDepth,
            VERDICT_ACCEPT_WINDOW_BLOCKS: this.acceptWindow,
            COLLECT_DEPTH_BLOCKS:         this.closeDepth,
        })){
            if(!Number.isFinite(value))
                throw new Error('FullNodeChallengeRound: pinned FULLNODE.' + key + ' is missing or ' +
                    'non-numeric in the coin registry for BTC/' + this.network + '. These are consensus ' +
                    'inputs and have no env or literal fallback by design (); fix the bundled ' +
                    'coin registry rather than supplying the value out of band.');
        }

        let fn = cfg.FULLNODE || {};
        // OPERATIONAL knobs only below this line: they affect this hub's local timing
        // and participation, not what any hub computes, so they keep their env surface.
        this.enabled       = String(process.env.FULLNODE_ENABLED || fn.ENABLED || 'true') !== 'false';
        this.pollMs        = parseInt(process.env.FULLNODE_POLL_MS    || fn.POLL_MS    || '30000');
        this.collectMs     = parseInt(process.env.FULLNODE_COLLECT_MS || fn.COLLECT_MS || '20000');
        // Genesis verifiers seed the eligible-verifier universe before any node is
        // verified on-chain, so a key dropped here shrinks the quorum denominator: it is
        // a consensus input and comes from the pinned registry with the rest.
        // Malformed entries are dropped (the indexer's admission rule does the same,
        // so keeping them would only fork this hub's view), but : say so, or a
        // typo'd activation looks identical to a correct one.
        let rawGenesis     = Array.isArray(registry.GENESIS_VERIFIERS) ? registry.GENESIS_VERIFIERS : [];
        this.genesis       = new Set(rawGenesis
                                .filter(p => /^[0-9a-fA-F]{64}$/.test(String(p)))
                                .map(p => String(p).toLowerCase()));
        if(this.genesis.size !== rawGenesis.length)
            console.warn('FullNodeChallengeRound: ignored ' + (rawGenesis.length - this.genesis.size) +
                ' of ' + rawGenesis.length + ' GENESIS_VERIFIERS entries (not a 64-hex Ed25519 pubkey, ' +
                'or a duplicate); using ' + this.genesis.size + '. The verifier quorum is computed over ' +
                'the surviving set.');

        // BTC indexer JSON-RPC (ledger-hash seed + tip); same env surface as
        // StateCheckpointEngine / CrossChainDexEngine.
        this.indexerUrl = process.env.BTC_INDEXER_URL     || cfg.BTC_INDEXER_URL     || '';
        this.indexerKey = process.env.BTC_INDEXER_API_KEY || cfg.BTC_INDEXER_API_KEY || '';

        // BTC coin full-node RPC (compute the possession answer). Reuses the
        // cross_chain capability's per-chain RPC config; a light validator simply
        // has none, so it can't participate (exactly the property we want).
        let cc = (cfg.cross_chain && cfg.cross_chain.chains && cfg.cross_chain.chains.BTC) || {};
        this.coinRpcUrl = process.env.FULLNODE_BTC_RPC || (cfg.FULLNODE && cfg.FULLNODE.BTC_RPC) || cc.rpc || '';

        // On-chain verdict broadcast: operator hook (preferred) or BTC encoder
        // pipeline, mirroring AttestationPublisher / OraclePublisher.
        let encUrl  = process.env.BTC_ENCODER_URL || cfg.BTC_ENCODER_URL || '';
        let encKey  = process.env.BTC_ENCODER_API_KEY || cfg.BTC_ENCODER_API_KEY || '';
        this.encoder      = encUrl ? new EncoderClient(encUrl, encKey) : null;
        this.broadcastFn  = null;   // fn(wirePayload) -> Promise<{txid}>
        this.walletSignFn = null;   // fn(psbtHex) -> Promise<txHex>
        this.btcAddress   = process.env.BTC_ADDRESS || cfg.BTC_ADDRESS || '';

        //  - shared SpendGuard for the on-chain NODEPROOF verdict spend. Adds a
        // per-window spend ceiling (count + $2000-clamped USD budget, default-ON) and a
        // per-capability runtime pause so an operator can halt verdict BTC spend at
        // runtime; gated at _maybeFinalize before the leader broadcasts. Config reads
        // env first (FULLNODE_* keys), then top-level p2pConfig, matching the sibling
        // publishers (the nested cfg.FULLNODE block stays the source for FullNode's own
        // knobs; the guard's knobs are the FULLNODE_*-prefixed ones).
        this.spendGuard = new SpendGuard('FULLNODE', cfg, 'FullNodeChallengeRound');

        this.rounds   = new Map();  // epoch -> round state
        this._timer   = null;
        this._handler = (env) => this._handleMessage(env);
    }

    setBroadcastHook(fn){ this.broadcastFn  = fn; }
    setEncoder(enc){      this.encoder      = enc; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }

    async start(){
        if(!this.enabled){
            console.log('FullNodeChallengeRound: disabled');
            return;
        }
        if(this.peerManager) this.peerManager.on('message', this._handler);
        let tick = async () => { try { await this._tick(); } catch(e){ console.warn('FullNodeChallengeRound tick:', e && e.message ? e.message : e); } };
        this._timer = setInterval(tick, this.pollMs);
        await tick();
        console.log('FullNodeChallengeRound started (interval=' + this.interval + ' blocks, depth=' + this.confirmDepth +
                    ', verifier=' + (this.coinRpcUrl ? 'yes' : 'NO coin RPC (observe-only)') + ', tier=' +
                    activation.describeActivation(this.cfg.FULLNODE) + ')');
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
        let headers = (this.hub && typeof this.hub._btcIndexerHeaders === 'function')
            ? this.hub._btcIndexerHeaders()
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

    async _coinCall(method, params){
        if(!this.coinRpcUrl) throw new Error('no coin RPC');
        let resp = await axios.post(this.coinRpcUrl, { jsonrpc: '1.0', id: 'fnproof', method, params: params || [] }, { timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('coin RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    async _tick(){
        if(this.interval <= 0) return;
        let tip = await this._indexerCall('getblockhashes', {});
        let tipBlock = tip && tip.block_index != null ? Number(tip.block_index) : null;
        if(tipBlock == null) return;

        // Close (and eventually prune) open rounds by CHAIN HEIGHT: every hub closes
        // a round at the same chain point (tip >= epoch + closeDepth), regardless of
        // when it locally detected the epoch, so the leader has collected every
        // claimant's answer (which were all broadcast within ~1 block of the epoch).
        for(let [e, st] of this.rounds){
            if(!st.finalized && tipBlock >= e + this.closeDepth){
                // Chain-based leader failover: rank 0 leads at the close point; each
                // further closeDepth of height with no verdict promotes the next rank.
                let rank = Math.floor((tipBlock - (e + this.closeDepth)) / Math.max(1, this.closeDepth));
                if(!st.closed || rank > st.leadRank){
                    st.closed = true;
                    st.leadRank = rank;
                    this._closeCollection(e).catch(err => console.warn('FullNodeChallengeRound close:', err && err.message));
                }
            }
            if((tipBlock - e) > (this.acceptWindow + this.closeDepth + this.interval)) this.rounds.delete(e);
        }

        // The most recent epoch boundary that is both buried enough for a stable
        // target block and still inside the verdict-acceptance window.
        let epoch = Math.floor(tipBlock / this.interval) * this.interval;
        if(epoch < this.confirmDepth) return;                 // target would be < genesis
        if((tipBlock - epoch) > this.acceptWindow) return;    // too late to land a verdict this epoch
        if(this.rounds.has(epoch)) return;                    // already running/finalized
        await this._runEpoch(epoch, tipBlock);
    }

    async _runEpoch(epoch, tipBlock){
        let bh = await this._indexerCall('getblockhashes', { block_index: epoch });
        if(!bh || !bh.ledger_hash){ return; }
        let seed   = String(bh.ledger_hash);
        let target = epoch - this.confirmDepth;
        let challengeId = crypto.createHash('sha256')
            .update(String(this.network) + ':' + epoch + ':' + seed + ':' + target).digest('hex');

        // Set<pubkey>: who may SIGN / who may be verified
        let eligible  = await this._eligibleVerifiers(epoch);
        // Unresolved eligible set (indexer RPC failure): ABSTAIN for this epoch
        // rather than run on a per-hub-divergent member list. No round state is
        // created, so this hub neither elects/claims leadership, signs, nor
        // broadcasts a verdict; a later tick re-attempts once the indexer recovers
        // (while still inside the verdict-accept window).
        if(eligible === null){
            console.warn('FullNodeChallengeRound: epoch=' + epoch + ' skipped (eligible-verifier set unresolved; abstaining rather than running on a genesis-only subset)');
            return;
        }
        let claimants = await this._claimantSet(epoch);
        // Unresolved claimant set (capability-snapshot failure): ABSTAIN for this
        // epoch alongside the eligible-set gate above, rather than lock an empty
        // (full_node, epoch) universe that diverges from hubs whose snapshot resolved.
        if(claimants === null){
            console.warn('FullNodeChallengeRound: epoch=' + epoch + ' skipped (claimant set unresolved; abstaining rather than locking an empty full_node set)');
            return;
        }
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;

        let state = {
            epoch, target, seed, challengeId,
            eligible, claimants,
            answers: new Map(),     // pubkey -> answer hex
            sigs:    new Map(),     // pubkey -> sig hex (over the canonical PASS list)
            passList: null,
            myAnswer: null,
            finalized: false,
            closed: false,
            leadRank: 0,
            startedAt: Date.now(),
            txid: null,
        };
        this.rounds.set(epoch, state);

        // Compute our own answer if we can: a CLAIMANT (proving itself) or an
        // eligible VERIFIER (needs the answer to lead a round and to confirm peers).
        // Only a claimant BROADCASTS it as its own possession claim; a verifier that
        // isn't also a claimant computes silently so it can still lead/verify. A
        // light mirror has no coin RPC and stays silent on both counts.
        let amClaimant = !!(myPubkey && claimants.has(myPubkey));
        let amVerifier = !!(myPubkey && eligible.has(myPubkey));
        if(myPubkey && this.coinRpcUrl && (amClaimant || amVerifier)){
            try {
                state.myAnswer = await this._computeAnswer(target, seed);
                if(amClaimant){
                    // R2-FN2: broadcast (and store) the pubkey-bound digest, never
                    // the plaintext answer. `answers` holds digests for every
                    // claimant including self, so the leader/verifier comparison
                    // paths treat self and peers identically.
                    let digest = this._answerDigest(challengeId, myPubkey, state.myAnswer);
                    state.answers.set(myPubkey, digest);
                    let sig = this.identity.sign(this._answerCanonical(challengeId, digest));
                    this.peerManager && this.peerManager.broadcast(XNODE_ANSWER, {
                        epoch, challengeId, answer_digest: digest, sig_pubkey: myPubkey, sig
                    });
                }
            } catch(e){
                console.warn('FullNodeChallengeRound: own answer failed (epoch ' + epoch + '):', e && e.message ? e.message : e);
            }
        }

        console.log('FullNodeChallengeRound: epoch=' + epoch + ' challenge=' + challengeId.substring(0,16) +
                    '... target=' + target + ' eligible=' + eligible.size + ' claimants=' + claimants.size +
                    ' leader=' + (this._isLeader(state, myPubkey) ? 'me' : 'peer'));

        // Collection closes from _tick once the tip reaches epoch + closeDepth
        // (chain-anchored); the leader then proposes the PASS list and every node
        // evaluates window-based pass-rate eligibility. No wall-clock timer: a hub that detects
        // the epoch earlier must not close before peers (on a slightly later poll)
        // have broadcast their answers.
    }

    async _closeCollection(epoch){
        let state = this.rounds.get(epoch);
        if(!state) return;
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;

        // The PASS proposal below only applies while the round is still live.
        if(state.finalized) return;

        // Leader proposes the PASS list: claimants whose pubkey-bound digest
        // matches the digest derived from OUR OWN node's answer (R2-FN2).
        if(this._isLeader(state, myPubkey) && state.myAnswer && !state.passList){
            let pass = [];
            for(let pk of state.claimants){
                if(state.answers.get(pk) === this._answerDigest(state.challengeId, pk, state.myAnswer)) pass.push(pk);
            }
            pass.sort();
            state.passList = pass;
            if(pass.length > 0){
                // Self-sign, then request peer signatures.
                let sig = this.identity.sign(this._verdictCanonical(state.challengeId, epoch, pass));
                state.sigs.set(myPubkey, sig);
                this.peerManager && this.peerManager.broadcast(XNODE_SIGN_REQ, {
                    epoch, challengeId: state.challengeId, target: state.target, passList: pass,
                    sig_pubkey: myPubkey
                });
                await this._maybeFinalize(epoch);
            }
        }
    }

    _handleMessage(env){
        if(!env || !env.data) return;
        switch(env.type){
            case XNODE_ANSWER:   return this._onAnswer(env.data);
            case XNODE_SIGN_REQ: return this._onSignReq(env.data);
            case XNODE_SIGN:     return this._onSign(env.data);
            case XNODE_DONE:     return this._onDone(env.data);
        }
    }

    _onAnswer(d){
        let state = this.rounds.get(Number(d.epoch));
        if(!state || state.finalized) return;
        let pk = String(d.sig_pubkey || '').toLowerCase();
        if(!pk || !state.claimants.has(pk)) return;            // only staked claimants count
        if(!/^[0-9a-fA-F]{64}$/.test(pk)) return;
        if(String(d.challengeId) !== state.challengeId) return;
        // R2-FN2: the wire carries a pubkey-bound digest, not the answer. A
        // 64-hex shape gate keeps junk out of the map; the digest itself is
        // validated against this hub's own recomputation at compare time
        // (_closeCollection / _onSignReq), so a copied digest from ANOTHER
        // claimant can never match this sender's expected digest.
        let digest = String(d.answer_digest || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(digest)) return;
        if(!ValidatorIdentity.verify(this._answerCanonical(state.challengeId, digest), String(d.sig || ''), pk)) return;
        if(!state.answers.has(pk)) state.answers.set(pk, digest);
    }

    async _onSignReq(d){
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
            try { state.myAnswer = await this._computeAnswer(state.target, state.seed); }
            catch(e){ return; }
        }
        let passSet = new Set(pass);
        for(let pk of pass){
            if(!state.claimants.has(pk)) return;                // outsider in the list
            let a = state.answers.get(pk);
            // R2-FN2: confirm the claimant's pubkey-bound digest against the one
            // derived from OUR OWN node's answer. A digest copied from another
            // claimant hashes over the wrong pubkey and never matches.
            if(a === undefined || a !== this._answerDigest(state.challengeId, pk, state.myAnswer)) return; // can't confirm: refuse to sign
        }
        // Completeness (R2-FN3): the leader could silently DROP an honest claimant
        // from the pass list (the loop above only validates listed entries, not
        // omissions). Refuse to sign unless the list is a superset of every
        // claimant we have INDEPENDENTLY confirmed correct against our own node,
        // so a censoring leader cannot exclude an honest full node with our
        // signature. (Answers still in flight are simply not yet in our set, so
        // this never forces a premature refusal; the round re-signs as they land.)
        for(let [pk, a] of state.answers){
            if(state.claimants.has(pk) && a === this._answerDigest(state.challengeId, pk, state.myAnswer) && !passSet.has(pk)) return;
        }
        let sorted = pass.slice().sort();
        let sig = this.identity.sign(this._verdictCanonical(state.challengeId, state.epoch, sorted));
        if(!state.passList) state.passList = sorted;
        state.sigs.set(myPubkey, sig);
        this.peerManager && this.peerManager.broadcast(XNODE_SIGN, {
            epoch: state.epoch, challengeId: state.challengeId, sig_pubkey: myPubkey, sig
        });
    }

    async _onSign(d){
        let state = this.rounds.get(Number(d.epoch));
        if(!state || state.finalized || !state.passList) return;
        let pk = String(d.sig_pubkey || '').toLowerCase();
        if(!pk || !state.eligible.has(pk)) return;
        if(String(d.challengeId) !== state.challengeId) return;
        let canonical = this._verdictCanonical(state.challengeId, state.epoch, state.passList.slice().sort());
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), pk)) return;
        state.sigs.set(pk, String(d.sig));
        await this._maybeFinalize(state.epoch);
    }

    _onDone(d){
        let state = this.rounds.get(Number(d.epoch));
        if(!state) return;
        state.finalized = true;
        state.txid = d.txid || state.txid;
    }

    async _maybeFinalize(epoch){
        let state = this.rounds.get(epoch);
        if(!state || state.finalized || !state.passList) return;
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        if(!this._isLeader(state, myPubkey)) return;            // only the leader broadcasts
        let quorum = Math.floor((2 * state.eligible.size) / 3) + 1;
        if(state.sigs.size < quorum) return;

        //  - shared SpendGuard gate on the PRIMARY (leader) verdict spend path.
        // A runtime pause (per-capability) or an exhausted per-window spend ceiling
        // DEFERS finalization (return without claiming the round) so a later tick
        // retries once resumed/budget frees. Checked BEFORE the finalize lock so a
        // paused publisher never claims-then-reverts, and never spends on the leader
        // path (the enabled kill-switch only gated start(), not this send).
        let g = this.spendGuard.check();
        if(!g.ok){ console.warn('FullNodeChallengeRound: ' + g.reason + ' (epoch ' + epoch + '); deferring verdict broadcast'); return; }

        // Optimistic finalize lock: _maybeFinalize runs on EVERY incoming XNODE_SIGN
        // (and from _closeCollection), so without claiming the round BEFORE the async
        // broadcast, two sigs that cross quorum within the broadcast's await window both
        // pass the `finalized` guard above and the leader emits the NODEPROOF verdict tx
        // twice (wasted BTC fee; the second is a same-challenge replay). Claim the round
        // now and revert on failure so a later sig/tick can still retry.
        state.finalized = true;
        let wire = this._buildVerdictWire(state);
        try {
            let res = await this._broadcastVerdict(wire);
            this.spendGuard.record();   // : a fresh verdict tx spent a BTC fee
            state.txid = res && res.txid ? res.txid : null;
            this.peerManager && this.peerManager.broadcast(XNODE_DONE, { epoch, challengeId: state.challengeId, txid: state.txid });
            console.log('FullNodeChallengeRound: verdict broadcast epoch=' + epoch + ' pass=' + state.passList.length +
                        ' sigs=' + state.sigs.size + '/' + quorum + (state.txid ? ' txid=' + state.txid : ''));
        } catch(e){
            //  - never blind-retry an AMBIGUOUS send. A timeout / reset / 5xx
            // after the request left the wire may mean the BTC node accepted the
            // verdict tx; reverting the finalize lock would let a later tick
            // re-broadcast and double-spend the fee (same-challenge NODEPROOF replay).
            // Keep the round claimed (no retry); an operator verifies on-chain, and a
            // fresh epoch re-challenges if it truly never landed. Only a DEFINITIVE
            // pre-send/reject failure unlocks for retry.
            if(isAmbiguousSendError(e)){
                console.warn('FullNodeChallengeRound: AMBIGUOUS verdict send (epoch ' + epoch +
                             '); NOT re-broadcasting to avoid a double spend:', e && e.message ? e.message : e);
            } else {
                state.finalized = false;   // definitive failure; unlock so a later sig/tick retries
                console.warn('FullNodeChallengeRound: verdict broadcast failed (epoch ' + epoch + '):', e && e.message ? e.message : e);
            }
        }
    }

    // scriptPubKey (hex) of a seed-selected output in the buried target block.
    async _computeAnswer(target, seed){
        let blockHash = await this._coinCall('getblockhash', [Number(target)]);
        let block     = await this._coinCall('getblock', [blockHash, 2]);
        let txs = (block && block.tx) || [];
        if(txs.length === 0) throw new Error('empty target block');
        let txIndex = Number(BigInt('0x' + seed.slice(0, 16)) % BigInt(txs.length));
        let tx = txs[txIndex];
        let vouts = (tx && tx.vout) || [];
        if(vouts.length === 0) throw new Error('selected tx has no outputs');
        let voutIndex = Number(BigInt('0x' + seed.slice(16, 32)) % BigInt(vouts.length));
        let spk = vouts[voutIndex] && vouts[voutIndex].scriptPubKey;
        if(!spk || !spk.hex) throw new Error('no scriptPubKey at selected output');
        return String(spk.hex).toLowerCase();
    }

    // Signed canonical for an XNODE_ANSWER broadcast. Since R2-FN2 the second
    // field is the pubkey-bound answer DIGEST, never the plaintext answer.
    _answerCanonical(challengeId, answerDigest){
        return 'XNODEANS|' + challengeId + '|' + String(answerDigest);
    }

    // R2-FN2: pubkey-bound possession digest. Binding the claimant's pubkey into
    // the hash makes every claimant's expected wire value distinct for the same
    // underlying answer, so knowledge of ANOTHER claimant's digest (public gossip)
    // is useless without the answer preimage, which only a real full node can
    // compute. Verifiers hold the preimage from their own node and recompute the
    // expected digest per claimant, so no reveal phase is needed.
    _answerDigest(challengeId, pubkey, answer){
        return crypto.createHash('sha256')
            .update('XNODEANSV1|' + challengeId + '|' + String(pubkey).toLowerCase() + '|' + String(answer))
            .digest('hex');
    }

    // CONSENSUS-CRITICAL: must byte-match the indexer's nodeproof.js canonical.
    _verdictCanonical(challengeId, epoch, sortedPassList){
        let raw = challengeId + '|' + epoch + '|' + sortedPassList.join(',');
        if(eq.isEquivHeaderActive(epoch, this.network))
            raw = eq.buildEquivCanonical(eq.ENGINE_TAGS.NODEPROOF, challengeId, 0, raw);
        return raw;
    }

    // NODEPROOF|0|CHALLENGE_ID|EPOCH_HEIGHT|PASS_COUNT|PASS_PK...|SIG_COUNT|PK|SIG|...
    _buildVerdictWire(state){
        let pass = state.passList.slice().sort();
        let sigTokens = [];
        for(let [pk, sig] of state.sigs.entries()) sigTokens.push(pk, sig);
        let parts = ['NODEPROOF', '0', state.challengeId, String(state.epoch), String(pass.length)]
            .concat(pass)
            .concat([String(state.sigs.size)])
            .concat(sigTokens);
        return parts.join('|');
    }

    // Returns the pubkey of the currently elected leader for `state`: the
    // verifier at the unlocked rank in the SHA256(challenge_id || pubkey) ordering.
    // Used by _onSignReq to reject SIGN_REQ messages from non-leaders before
    // locking the passList.
    _electedLeader(state){
        if(!state.eligible || state.eligible.size === 0) return null;
        let ranked = Array.from(state.eligible).map(pk => ({
            pk, h: crypto.createHash('sha256').update(state.challengeId).update(pk).digest('hex')
        })).sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
        let unlockedRank = Math.min(state.leadRank || 0, ranked.length - 1);
        return ranked[unlockedRank] ? ranked[unlockedRank].pk : null;
    }

    // Elected leader = lowest SHA256(challenge_id || pubkey) among eligible
    // verifiers, with a simple elapsed-time failover ladder (the next-ranked
    // verifier takes over a collection window later if no verdict has landed).
    _isLeader(state, myPubkey){
        if(!myPubkey || !state.eligible.has(myPubkey)) return false;
        let ranked = Array.from(state.eligible).map(pk => ({
            pk, h: crypto.createHash('sha256').update(state.challengeId).update(pk).digest('hex')
        })).sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
        let myRank = ranked.findIndex(r => r.pk === myPubkey);
        if(myRank < 0) return false;
        // Rank 0 leads at the chain-anchored close; if no verdict lands, each further
        // closeDepth of chain height promotes the next rank as a failover (chain-based
        // so all hubs agree on who leads, escalated in _tick via state.leadRank).
        let unlockedRank = Math.min(state.leadRank || 0, ranked.length - 1);
        return myRank === unlockedRank;
    }

    // Eligible verifiers at the epoch block: verified full nodes (from the
    // indexer) union configured genesis verifiers. Matches the indexer's acceptance
    // rule in nodeproof.js so a quorum the hub assembles is one the chain accepts.
    //
    // CONSENSUS-CRITICAL: the returned set is the domain of leader election
    // (_electedLeader / _isLeader) and the 2/3+1 quorum denominator (_maybeFinalize).
    // On an UNRESOLVED set (any indexer RPC failure: 401 / timeout / transport) this
    // returns null so the caller ABSTAINS (skips the epoch), rather than degrading to
    // the genesis-only subset. A per-hub, reachability-dependent fallback would split
    // the federation's view of the member list across honest hubs (divergent leader /
    // quorum -> duplicate or stalled on-chain NODEPROOF verdicts). This fails CLOSED,
    // matching _claimantSet in this file and the StateAnchorPublisher / CrossChainEngine
    // siblings; it trades liveness on a prolonged indexer outage for cross-hub safety.
    // The legitimate genesis-only path (a genuinely genesis-only federation) is on the
    // SUCCESS branch, where the indexer returns an empty validators list; only the
    // error-degradation path changes.
    async _eligibleVerifiers(epoch){
        let set = new Set(this.genesis);
        try {
            let verified = await this._indexerCall('getfullnodeverifiers', { block_index: epoch });
            let list = (verified && verified.validators) || [];
            for(let v of list){
                let pk = String(v.pubkey || v).toLowerCase();
                if(/^[0-9a-f]{64}$/.test(pk)) set.add(pk);
            }
        } catch(err){
            let status = err && err.response && err.response.status;
            if (status === 401)
                console.warn('FullNodeChallengeRound: _eligibleVerifiers: 401 Unauthorized from indexer (misconfigured API key?); ABSTAINING (skip epoch), NOT degrading to genesis-only');
            else
                console.warn('FullNodeChallengeRound: _eligibleVerifiers: RPC error (absent/old indexer or transport failure: ' + (err && err.message) + '); ABSTAINING (skip epoch), NOT degrading to genesis-only');
            return null;
        }
        return set;
    }

    // Claimant universe = validators holding the full_node capability at the
    // epoch block (the block-boundary snapshot every hub locks identically).
    //
    // CONSENSUS-CRITICAL: mirrors _eligibleVerifiers. capabilitySnapshot.getSnapshot
    // signals every UNRESOLVED state (transport error, 401/403, malformed shape,
    // block-echo mismatch, unconfigured MIN_STAKE against a live registry) by
    // returning null, never by throwing, so the catch below is a backstop, not the
    // primary path. On an unresolved snapshot this returns null so the caller
    // ABSTAINS (skips the epoch) rather than degrading to an EMPTY claimant set:
    // an empty set would let two honest hubs lock different (full_node, epoch)
    // universes (leader broadcasts no XNODE_SIGN_REQ / verifier rejects the
    // legitimate list as outsiders), the exact divergence this lock exists to
    // prevent. A legitimately empty snapshot is distinguished by a real validators
    // array (_coerceValidators guarantees one on the SUCCESS branch) and still
    // yields a real, empty Set. This fails CLOSED, trading liveness on a prolonged
    // snapshot outage for cross-hub safety.
    async _claimantSet(epoch){
        let set = new Set();
        try {
            let snap = await this.capabilitySnapshot.getSnapshot('full_node', epoch);
            if(!snap || !Array.isArray(snap.validators)){
                console.warn('FullNodeChallengeRound: _claimantSet: capability snapshot unresolved for full_node at epoch=' + epoch + '; ABSTAINING (skip epoch), NOT degrading to an empty claimant set');
                return null;
            }
            for(let v of snap.validators){
                let pk = String(v.pubkey || v).toLowerCase();
                if(/^[0-9a-f]{64}$/.test(pk)) set.add(pk);
            }
        } catch(err){
            let status = err && err.response && err.response.status;
            if (status === 401)
                console.warn('FullNodeChallengeRound: _claimantSet: 401 Unauthorized from capability snapshot (misconfigured API key?); ABSTAINING (skip epoch)');
            else
                console.warn('FullNodeChallengeRound: _claimantSet: snapshot error (' + (err && err.message) + '); ABSTAINING (skip epoch)');
            return null;
        }
        return set;
    }

    async _broadcastVerdict(wire){
        if(this.broadcastFn) return await this.broadcastFn(wire);
        if(this.encoder && this.walletSignFn && this.btcAddress){
            let built = await this.encoder.createTx({ source: this.btcAddress, data: wire });
            let psbt  = built && (built.psbt || built.psbtHex || built.hex);
            let txHex = await this.walletSignFn(psbt);
            return await this.encoder.broadcastTx(txHex);
        }
        throw new Error('no broadcast pipeline (set broadcast hook, or encoder + wallet-sign + BTC_ADDRESS)');
    }
}

module.exports = FullNodeChallengeRound;
module.exports.XNODE_ANSWER   = XNODE_ANSWER;
module.exports.XNODE_SIGN_REQ = XNODE_SIGN_REQ;
module.exports.XNODE_SIGN     = XNODE_SIGN;
module.exports.XNODE_DONE     = XNODE_DONE;
