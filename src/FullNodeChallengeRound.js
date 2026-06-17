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
 *   1. XNODE_ANSWER:   every full_node claimant broadcasts its computed answer.
 *   2. XNODE_SIGN_REQ: the elected leader proposes the PASS list (claimants
 *                      whose answer matches its own).
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
const eq                = require('./equivocation_header.js');

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

        let fn = cfg.FULLNODE || {};
        this.enabled       = String(process.env.FULLNODE_ENABLED || fn.ENABLED || 'true') !== 'false';
        this.interval      = parseInt(process.env.FULLNODE_CHALLENGE_INTERVAL_BLOCKS || fn.CHALLENGE_INTERVAL_BLOCKS || '144');
        this.confirmDepth  = parseInt(process.env.FULLNODE_CONFIRM_DEPTH            || fn.CONFIRM_DEPTH            || '100');
        this.acceptWindow  = parseInt(process.env.FULLNODE_VERDICT_ACCEPT_WINDOW_BLOCKS || fn.VERDICT_ACCEPT_WINDOW_BLOCKS || '24');
        this.pollMs        = parseInt(process.env.FULLNODE_POLL_MS    || fn.POLL_MS    || '30000');
        this.collectMs     = parseInt(process.env.FULLNODE_COLLECT_MS || fn.COLLECT_MS || '20000');
        // Collection closes when the tip reaches epoch + closeDepth blocks, anchored
        // to chain height (shared by all hubs), NOT each hub's local detection time,
        // so the leader has every claimant's answer before it proposes the PASS list.
        this.closeDepth    = parseInt(process.env.FULLNODE_COLLECT_DEPTH_BLOCKS || fn.COLLECT_DEPTH_BLOCKS || '3');
        this.genesis       = new Set((fn.GENESIS_VERIFIERS || [])
                                .filter(p => /^[0-9a-fA-F]{64}$/.test(String(p)))
                                .map(p => String(p).toLowerCase()));
        this.network       = hub.network || cfg.HUB_NETWORK || '';

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
                    ', verifier=' + (this.coinRpcUrl ? 'yes' : 'NO coin RPC (observe-only)') + ')');
    }

    async stop(){
        if(this._timer) clearInterval(this._timer);
        this._timer = null;
        if(this.peerManager) this.peerManager.removeListener('message', this._handler);
    }

    // Indexer / coin RPC
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
        return resp.data ? resp.data.result : null;
    }

    async _coinCall(method, params){
        if(!this.coinRpcUrl) throw new Error('no coin RPC');
        let resp = await axios.post(this.coinRpcUrl, { jsonrpc: '1.0', id: 'fnproof', method, params: params || [] }, { timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('coin RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    // Epoch detection
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
        let claimants = await this._claimantSet(epoch);
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
                    state.answers.set(myPubkey, state.myAnswer);
                    let sig = this.identity.sign(this._answerCanonical(challengeId, state.myAnswer));
                    this.peerManager && this.peerManager.broadcast(XNODE_ANSWER, {
                        epoch, challengeId, answer: state.myAnswer, sig_pubkey: myPubkey, sig
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

        // Leader proposes the PASS list (claimants whose answer matches ours).
        if(this._isLeader(state, myPubkey) && state.myAnswer && !state.passList){
            let pass = [];
            for(let pk of state.claimants){
                if(state.answers.get(pk) === state.myAnswer) pass.push(pk);
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

    // P2P message handling
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
        let answer = String(d.answer || '');
        if(!ValidatorIdentity.verify(this._answerCanonical(state.challengeId, answer), String(d.sig || ''), pk)) return;
        if(!state.answers.has(pk)) state.answers.set(pk, answer);
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
        for(let pk of pass){
            if(!state.claimants.has(pk)) return;                // outsider in the list
            let a = state.answers.get(pk);
            if(a === undefined || a !== state.myAnswer) return; // can't confirm: refuse to sign
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

        let wire = this._buildVerdictWire(state);
        try {
            let res = await this._broadcastVerdict(wire);
            state.finalized = true;
            state.txid = res && res.txid ? res.txid : null;
            this.peerManager && this.peerManager.broadcast(XNODE_DONE, { epoch, challengeId: state.challengeId, txid: state.txid });
            console.log('FullNodeChallengeRound: verdict broadcast epoch=' + epoch + ' pass=' + state.passList.length +
                        ' sigs=' + state.sigs.size + '/' + quorum + (state.txid ? ' txid=' + state.txid : ''));
        } catch(e){
            console.warn('FullNodeChallengeRound: verdict broadcast failed (epoch ' + epoch + '):', e && e.message ? e.message : e);
        }
    }

    // Helpers

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

    _answerCanonical(challengeId, answer){
        return 'XNODEANS|' + challengeId + '|' + String(answer);
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
                console.warn('FullNodeChallengeRound: _eligibleVerifiers: 401 Unauthorized from indexer (misconfigured API key?); falling back to genesis-only set');
            else
                console.warn('FullNodeChallengeRound: _eligibleVerifiers: RPC error (absent/old indexer or transport failure: ' + (err && err.message) + '); falling back to genesis-only set');
        }
        return set;
    }

    // Claimant universe = validators holding the full_node capability at the
    // epoch block (the block-boundary snapshot every hub locks identically).
    async _claimantSet(epoch){
        let set = new Set();
        try {
            let snap = await this.capabilitySnapshot.getSnapshot('full_node', epoch);
            let list = (snap && (snap.validators || snap)) || [];
            for(let v of list){
                let pk = String(v.pubkey || v).toLowerCase();
                if(/^[0-9a-f]{64}$/.test(pk)) set.add(pk);
            }
        } catch(err){
            let status = err && err.response && err.response.status;
            if (status === 401)
                console.warn('FullNodeChallengeRound: _claimantSet: 401 Unauthorized from capability snapshot (misconfigured API key?); claimant set empty');
            else
                console.warn('FullNodeChallengeRound: _claimantSet: snapshot error (' + (err && err.message) + '); claimant set empty');
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
