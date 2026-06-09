/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Cross-Chain DEX Consensus (PBFT match finalization)
 *
 * Drives Byzantine-fault-tolerant agreement over a cross-chain match BEFORE it
 * is written to cross_chain_matches and mirrored to indexers. The indexer's
 * settlement pass (cross_settle) releases escrow only after verifying 2f+1
 * `cross_chain` signatures over the canonical match; this engine produces those
 * signatures through a 3-phase PBFT round (PROPOSE → PREPARE → COMMIT) with
 * leader-failover (VIEW_CHANGE → NEW_VIEW).
 *
 * Unlike attestation consensus (divergent provider bodies → provider.agree()
 * picks a winner), a cross-chain match is DETERMINISTIC: given the same confirmed
 * order books at snapshot_block, every honest validator derives the identical
 * canonical (engine._canonicalMatch). So there is no winner to agree on — the
 * round is independent re-derivation + signature collection:
 *   - the match-designated leader broadcasts XDEX_MATCH_PROPOSE(row);
 *   - each peer re-derives + validates the match against its OWN order book
 *     (engine.validateProposedMatch) and only then signs the canonical;
 *   - signatures gather to 2f+1 over a single canonical and finalize the match.
 * A Byzantine leader cannot forge a settlement (honest peers sign only what they
 * independently confirm) and equivocation fails (each peer signs its own derived
 * canonical, so only the one true canonical reaches quorum).
 *
 * Structure mirrors AttestationConsensus.js (per-item rounds keyed by a
 * deterministic id, signature collection, early-message buffer, finalize-emit)
 * merged with Consensus.js's leader-failover (view-change keyed here by match_id).
 *
 * Single-node fallback: quorum 0 (N≤1, e.g. a single-operator regtest) collapses
 * to immediate self-sign + finalize — identical to the pre-PBFT behavior.
 *
 ********************************************************************/

const EventEmitter      = require('events');
const ValidatorIdentity = require('./ValidatorIdentity.js');

const XDEX_MATCH_PROPOSE     = 'XDEX_MATCH_PROPOSE';
const XDEX_MATCH_PREPARE     = 'XDEX_MATCH_PREPARE';
const XDEX_MATCH_COMMIT      = 'XDEX_MATCH_COMMIT';
const XDEX_MATCH_VIEW_CHANGE = 'XDEX_MATCH_VIEW_CHANGE';
const XDEX_MATCH_NEW_VIEW    = 'XDEX_MATCH_NEW_VIEW';

const DEFAULT_ROUND_TIMEOUT_MS = 120000;  // 2 minutes per match round before view-change

class CrossChainDexConsensus extends EventEmitter {

    // engine: the CrossChainDexEngine — used for _canonicalMatch (the signable
    // payload, byte-identical to the indexer verifier), validateProposedMatch
    // (independent re-derivation), and _persistCapabilitySnapshot (leader path).
    constructor(engine){
        super();
        this.engine       = engine;
        this.hub          = engine.hub;
        this.peerManager  = engine.peerManager;
        this.identity     = engine.identity;
        this.capSnapshot  = engine.capSnapshot;
        this.config       = (engine.hub && engine.hub.p2pConfig) || {};

        // Per-match round state: Map<match_id, pending>
        this.pending = new Map();

        // Finalized match ids — ring-buffer bounded, FIFO eviction (mirrors
        // AttestationConsensus.finalized). Suppresses duplicate finalize/late COMMITs.
        this.finalized       = new Set();
        this._finalizedOrder = [];
        this.finalizedMax    = parseInt(this.config.XDEX_FINALIZED_MAX) || 10000;

        // Early-arrival buffer: a PROPOSE/PREPARE/COMMIT/VIEW_CHANGE can reach a
        // peer before that peer's own _discoverAndMatch created the round. Buffer
        // by match_id and drain in propose(). Bounded TTL prevents leaks if the
        // round never starts locally. Map<match_id, Array<envelope>>.
        this.earlyMessages    = new Map();
        this.earlyMessageTtl  = new Map();
        this.earlyMessageTtlMs    = 60 * 1000;
        this.earlyMessageMaxPerId = 32;

        this._messageHandler = null;
        this.roundTimeoutMs  = parseInt(this.config.XDEX_ROUND_TIMEOUT_MS) || DEFAULT_ROUND_TIMEOUT_MS;
    }

    async start(){
        if(!this.peerManager){
            console.log('CrossChainDexConsensus: no peer manager — single-node finalize only');
            return;
        }
        this._messageHandler = (env) => this._handleMessage(env);
        this.peerManager.on('message', this._messageHandler);
        console.log('CrossChainDexConsensus: started');
    }

    async stop(){
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for(let [, p] of this.pending){ if(p.timer) clearTimeout(p.timer); }
        this.pending.clear();
        this.earlyMessages.clear();
        this.earlyMessageTtl.clear();
    }

    // ── Early-message buffer (mirror AttestationConsensus) ─────────────────────
    _pruneEarlyMessages(now){
        for(let [id, expiresAt] of this.earlyMessageTtl){
            if(expiresAt <= now){ this.earlyMessages.delete(id); this.earlyMessageTtl.delete(id); }
        }
    }
    _bufferEarlyMessage(id, envelope){
        let now = Date.now();
        this._pruneEarlyMessages(now);
        let arr = this.earlyMessages.get(id);
        if(!arr){ arr = []; this.earlyMessages.set(id, arr); }
        if(arr.length >= this.earlyMessageMaxPerId) return;
        arr.push(envelope);
        this.earlyMessageTtl.set(id, now + this.earlyMessageTtlMs);
    }
    _drainEarlyMessages(id){
        let arr = this.earlyMessages.get(id);
        if(!arr) return;
        this.earlyMessages.delete(id);
        this.earlyMessageTtl.delete(id);
        for(let env of arr) this._handleMessage(env);
    }

    // Signed control message (VIEW_CHANGE / NEW_VIEW). Authenticated by pubkey +
    // signature like the PROPOSE/PREPARE/COMMIT phases — NOT by envelope.sender,
    // which the transport sets to a validator address while our snapshot set is
    // pubkey-keyed. Binds tag+matchId+view so a vote can't be replayed elsewhere.
    _controlPayload(tag, rid, view){ return tag + '|' + rid + '|' + view; }
    _signControl(tag, rid, view){ return this.identity.sign(this._controlPayload(tag, rid, view)); }
    _verifyControl(tag, rid, view, pubkey, sig){
        return ValidatorIdentity.verify(this._controlPayload(tag, rid, view), String(sig || ''), String(pubkey || '').toLowerCase());
    }

    // ── Leader selection (deterministic; rotated by view) ──────────────────────
    // Sort the snapshot validators by pubkey so every node agrees on ordering,
    // then index by (matchIdInt + view) % N. Mirrors Consensus._getLeader.
    _leaderFor(matchId, validators, view){
        if(!validators || validators.length === 0) return null;
        let sorted = validators.map(v => String(v.pubkey).toLowerCase()).sort();
        let mInt   = parseInt(String(matchId).slice(0, 8), 16) || 0;
        return sorted[(mInt + (view || 0)) % sorted.length];
    }

    // ── Round entry (called by the engine for every discovered match) ──────────
    // Every node runs this on discovery: the leader broadcasts PROPOSE; followers
    // create the round (so they hold the failover timer + can validate the
    // leader's PROPOSE). quorum 0 → single-node immediate self-sign + finalize.
    async propose(matchId, ctx){
        let rid = String(matchId).toLowerCase();
        if(this.finalized.has(rid) || this.pending.has(rid)) return;
        if(!this.identity) throw new Error('no validator identity — cannot run cross-chain match consensus');

        let row        = ctx.row;
        let validators = (ctx.snapshot && Array.isArray(ctx.snapshot.validators)) ? ctx.snapshot.validators : [];
        let snapCount  = validators.length;
        let quorum     = (snapCount <= 1) ? 0 : (2 * Math.floor((snapCount - 1) / 3) + 1);
        let canonical  = this.engine._canonicalMatch(row);
        let myPubkey   = this.identity.getPubkeyHex().toLowerCase();

        let pending = {
            matchId:      rid,
            row:          row,
            canonical:    canonical,
            validators:   validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase() })),
            quorum:       quorum,
            view:         0,
            myPubkey:     myPubkey,
            prepares:     new Set(),
            commits:      new Set(),
            signatures:   new Map(),     // pubkey → sig over canonical
            viewChanges:  new Map(),     // view → Set<pubkey>
            finalized:    false,
            _commitSent:  false,
            timer:        null
        };
        this.pending.set(rid, pending);

        // Single-operator / no-federation: persist the snapshot (so the indexer can
        // verify), sign with our own identity, and finalize immediately — byte-for-byte
        // the pre-PBFT behavior (there is no PROPOSE round to carry the persist).
        if(quorum === 0){
            try { await this.engine._persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block)); }
            catch(e){ console.warn('CrossChainDexConsensus: snapshot persist failed: ' + (e && e.message)); }
            let sig = this.identity.sign(canonical);
            pending.signatures.set(myPubkey, sig);
            this._finalize(rid);
            return;
        }

        pending.timer = this._armTimer(rid);

        // If we are the round leader, persist the capability snapshot (so indexers
        // can verify) and broadcast PROPOSE. Followers just wait (+ hold the timer).
        let leader = this._leaderFor(rid, pending.validators, pending.view);
        if(leader === myPubkey){
            await this._broadcastPropose(pending);
        }

        this._drainEarlyMessages(rid);
    }

    _armTimer(rid){
        return setTimeout(() => {
            let p = this.pending.get(rid);
            if(p && !p.finalized) this._initiateViewChange(rid);
        }, this.roundTimeoutMs);
    }

    // Leader action: persist snapshot, sign canonical, seed own vote, broadcast PROPOSE.
    async _broadcastPropose(pending){
        try { await this.engine._persistCapabilitySnapshot('cross_chain', Number(pending.row.snapshot_block)); }
        catch(e){ console.warn('CrossChainDexConsensus: snapshot persist failed: ' + (e && e.message)); }
        let mySig = this.identity.sign(pending.canonical);
        pending.signatures.set(pending.myPubkey, mySig);
        pending.prepares.add(pending.myPubkey);
        if(this.peerManager){
            this.peerManager.broadcast(XDEX_MATCH_PROPOSE, {
                matchId: pending.matchId, view: pending.view, row: pending.row,
                sig_pubkey: pending.myPubkey, sig: mySig
            });
        }
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XDEX_MATCH_PROPOSE:     this._handlePropose(envelope).catch(e => console.error('CrossChainDexConsensus: PROPOSE error: ' + (e && e.message))); break;
            case XDEX_MATCH_PREPARE:     this._handlePrepare(envelope);    break;
            case XDEX_MATCH_COMMIT:      this._handleCommit(envelope);     break;
            case XDEX_MATCH_VIEW_CHANGE: this._handleViewChange(envelope); break;
            case XDEX_MATCH_NEW_VIEW:    this._handleNewView(envelope);    break;
        }
    }

    // ── PROPOSE: validate the leader's match against our own view, then sign ───
    async _handlePropose(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this._bufferEarlyMessage(rid, envelope); return; }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        let view = Number(d.view) || 0;
        if(view < pending.view) return;                                   // stale leader

        // Sender must be the designated leader for the claimed (matchId, view).
        if(senderPubkey !== this._leaderFor(rid, pending.validators, view)) return;
        if(!pending.validators.some(v => v.pubkey === senderPubkey)) return;

        // The proposed row must hash to this round's id and rebuild OUR canonical.
        let row = d.row;
        if(!row || String(row.match_id).toLowerCase() !== rid) return;
        let canonical = this.engine._canonicalMatch(row);
        if(canonical !== pending.canonical) return;                        // not the match we derived

        // Verify the leader's signature over the canonical.
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), senderPubkey)) return;

        // INDEPENDENT confirmation: re-derive + validate against our own order book.
        let ok = false;
        try { ok = await this.engine.validateProposedMatch(row); }
        catch(e){ ok = false; }
        if(!ok){
            console.warn('CrossChainDexConsensus: PROPOSE ' + rid.substring(0,16) + '... failed local validation — not signing');
            return;
        }

        if(view > pending.view) pending.view = view;
        pending.signatures.set(senderPubkey, String(d.sig));             // leader's sig
        pending.prepares.add(senderPubkey);

        // Our own signature + PREPARE broadcast.
        if(!pending.signatures.has(pending.myPubkey)){
            let mySig = this.identity.sign(canonical);
            pending.signatures.set(pending.myPubkey, mySig);
            pending.prepares.add(pending.myPubkey);
            if(this.peerManager){
                this.peerManager.broadcast(XDEX_MATCH_PREPARE, {
                    matchId: rid, view: pending.view, sig_pubkey: pending.myPubkey, sig: mySig
                });
            }
        }
        this._checkPrepareQuorum(rid);
    }

    _handlePrepare(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this._bufferEarlyMessage(rid, envelope); return; }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === senderPubkey)) return;
        if(d.sig && ValidatorIdentity.verify(pending.canonical, String(d.sig), senderPubkey)){
            pending.signatures.set(senderPubkey, String(d.sig));
        } else if(d.sig){
            return;                                                        // bad sig — drop the vote
        }
        pending.prepares.add(senderPubkey);
        this._checkPrepareQuorum(rid);
    }

    _checkPrepareQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized || pending._commitSent) return;
        if(pending.prepares.size < pending.quorum) return;
        pending._commitSent = true;
        pending.commits.add(pending.myPubkey);
        let mySig = pending.signatures.get(pending.myPubkey) || null;
        if(this.peerManager){
            this.peerManager.broadcast(XDEX_MATCH_COMMIT, {
                matchId: rid, view: pending.view, sig_pubkey: pending.myPubkey, sig: mySig
            });
        }
        this._checkCommitQuorum(rid);
    }

    _handleCommit(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this._bufferEarlyMessage(rid, envelope); return; }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === senderPubkey)) return;
        if(d.sig && ValidatorIdentity.verify(pending.canonical, String(d.sig), senderPubkey)){
            pending.signatures.set(senderPubkey, String(d.sig));
        }
        pending.commits.add(senderPubkey);
        this._checkCommitQuorum(rid);
    }

    _checkCommitQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        if(pending.commits.size < pending.quorum) return;
        this._finalize(rid);
    }

    // ── Finalize: emit the match + collected signatures for the engine to write ─
    _finalize(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        pending.finalized = true;
        this._markFinalized(rid);
        if(pending.timer){ clearTimeout(pending.timer); pending.timer = null; }

        let sigs = [];
        for(let [pk, sg] of pending.signatures) sigs.push({ pubkey: pk, sig: sg });

        console.log('CrossChainDexConsensus: finalized ' + rid.substring(0,16) + '... (' +
                    pending.prepares.size + ' prepares, ' + pending.commits.size + ' commits, ' + sigs.length + ' sigs)');
        this.emit('match:finalized', { matchId: rid, row: pending.row, signatures: sigs });

        setTimeout(() => this.pending.delete(rid), 10000);
    }

    _markFinalized(rid){
        if(this.finalized.has(rid)) return;
        this.finalized.add(rid);
        this._finalizedOrder.push(rid);
        if(this._finalizedOrder.length > this.finalizedMax){
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
        }
    }

    // ── Leader-failover / view-change (port of Consensus.js, keyed by match_id) ─
    _initiateViewChange(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        pending.view++;
        let view = pending.view;
        if(!pending.viewChanges.has(view)) pending.viewChanges.set(view, new Set());
        pending.viewChanges.get(view).add(pending.myPubkey);
        if(this.peerManager) this.peerManager.broadcast(XDEX_MATCH_VIEW_CHANGE, {
            matchId: rid, view: view, sig_pubkey: pending.myPubkey, sig: this._signControl('XDEXVC', rid, view)
        });
        if(pending.timer) clearTimeout(pending.timer);
        pending.timer = this._armTimer(rid);
        this._maybeAssumeLeadership(rid, view);
    }

    _handleViewChange(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this._bufferEarlyMessage(rid, envelope); return; }
        let view = Number(d.view);
        if(!Number.isFinite(view)) return;
        let voter = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === voter)) return;     // not a validator
        if(!this._verifyControl('XDEXVC', rid, view, voter, d.sig)) return; // unauthenticated vote
        if(!pending.viewChanges.has(view)) pending.viewChanges.set(view, new Set());
        pending.viewChanges.get(view).add(voter);
        this._maybeAssumeLeadership(rid, view);
    }

    // On 2f+1 view-change votes for `view`, the rotated leader announces NEW_VIEW
    // and re-proposes so the round can make progress under a fresh leader.
    _maybeAssumeLeadership(rid, view){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        let votes = pending.viewChanges.get(view);
        if(!votes || votes.size < pending.quorum) return;
        if(view > pending.view) pending.view = view;
        let newLeader = this._leaderFor(rid, pending.validators, view);
        if(newLeader === pending.myPubkey){
            if(this.peerManager) this.peerManager.broadcast(XDEX_MATCH_NEW_VIEW, {
                matchId: rid, view: view, sig_pubkey: pending.myPubkey, sig: this._signControl('XDEXNV', rid, view)
            });
            this._broadcastPropose(pending).catch(e => console.warn('CrossChainDexConsensus: re-propose failed: ' + (e && e.message)));
        }
    }

    _handleNewView(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this._bufferEarlyMessage(rid, envelope); return; }
        let view = Number(d.view);
        if(!Number.isFinite(view) || view <= pending.view) return;        // monotonic: never rewind
        let announcer = String(d.sig_pubkey || '').toLowerCase();
        // Announcer must be the designated leader for the CLAIMED view, and prove it
        // with a valid signature (mirrors Consensus._handleNewView's leader-identity
        // guard — a Byzantine node can only announce views in which it is the leader).
        let expected = this._leaderFor(rid, pending.validators, view);
        if(!expected || announcer !== expected) {
            console.warn('CrossChainDexConsensus: ignoring NEW_VIEW for view ' + view + ' from non-leader');
            return;
        }
        if(!this._verifyControl('XDEXNV', rid, view, announcer, d.sig)) return;
        pending.view = view;
    }
}

module.exports = CrossChainDexConsensus;
module.exports.XDEX_MATCH_PROPOSE     = XDEX_MATCH_PROPOSE;
module.exports.XDEX_MATCH_PREPARE     = XDEX_MATCH_PREPARE;
module.exports.XDEX_MATCH_COMMIT      = XDEX_MATCH_COMMIT;
module.exports.XDEX_MATCH_VIEW_CHANGE = XDEX_MATCH_VIEW_CHANGE;
module.exports.XDEX_MATCH_NEW_VIEW    = XDEX_MATCH_NEW_VIEW;
