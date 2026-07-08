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
 * XChain Hub - Cross-Chain DEX Consensus (PBFT match finalization)
 *
 * Drives Byzantine-fault-tolerant agreement over a cross-chain match BEFORE it
 * is written to cross_chain_matches and mirrored to indexers. The indexer's
 * settlement pass (cross_settle) releases escrow only after verifying 2f+1
 * `cross_chain` signatures over the canonical match; this engine produces those
 * signatures through a 3-phase PBFT round (PROPOSE -> PREPARE -> COMMIT) with
 * leader-failover (VIEW_CHANGE -> NEW_VIEW).
 *
 * Unlike attestation consensus (divergent provider bodies -> provider.agree()
 * picks a winner), a cross-chain match is DETERMINISTIC: given the same confirmed
 * order books at snapshot_block, every honest validator derives the identical
 * canonical (engine._canonicalMatch). There is no winner to agree on: the
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
 * Single-node fallback: quorum 0 (N<=1, e.g. a single-operator regtest) collapses
 * to immediate self-sign + finalize, identical to the pre-PBFT behavior.
 *
 ********************************************************************/

const EventEmitter      = require('events');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const swq               = require('./stake_weighted_quorum.js');

const XDEX_MATCH_PROPOSE     = 'XDEX_MATCH_PROPOSE';
const XDEX_MATCH_PREPARE     = 'XDEX_MATCH_PREPARE';
const XDEX_MATCH_COMMIT      = 'XDEX_MATCH_COMMIT';
const XDEX_MATCH_VIEW_CHANGE = 'XDEX_MATCH_VIEW_CHANGE';
const XDEX_MATCH_NEW_VIEW    = 'XDEX_MATCH_NEW_VIEW';
const XDEX_MATCH_FINAL_SYNC  = 'XDEX_MATCH_FINAL_SYNC';

const DEFAULT_ROUND_TIMEOUT_MS = 120000;  // 2 minutes per match round before view-change
const PENDING_EVICT_MS         = 10000;   // hold finalized state ~10s for late-arriving duplicates, then evict

class CrossChainDexConsensus extends EventEmitter {

    // engine: the CrossChainDexEngine. Used for _canonicalMatch (the signable
    // payload, byte-identical to the indexer verifier), validateProposedMatch
    // (independent re-derivation), and _persistCapabilitySnapshot (leader path).
    //
    // opts (optional) lets a second engine reuse this consensus over its own item
    // type without sharing gossip traffic with DEX match rounds. The engine
    // contract is unchanged (duck-typed _canonicalMatch / validateProposedMatch /
    // _persistCapabilitySnapshot; rows carry snapshot_block + the id field):
    //   opts.messageTypes: {PROPOSE, PREPARE, COMMIT, VIEW_CHANGE, NEW_VIEW}
    //   opts.controlTags:  {vc, nv} signed-control payload tags
    //   opts.idField:      row field that must equal the round id (default 'match_id')
    constructor(engine, opts){
        super();
        opts = opts || {};
        this.engine       = engine;
        this.hub          = engine.hub;
        this.peerManager  = engine.peerManager;
        this.identity     = engine.identity;
        this.capSnapshot  = engine.capSnapshot;
        this.config       = (engine.hub && engine.hub.p2pConfig) || {};
        this.types        = opts.messageTypes || {
            PROPOSE: XDEX_MATCH_PROPOSE, PREPARE: XDEX_MATCH_PREPARE, COMMIT: XDEX_MATCH_COMMIT,
            VIEW_CHANGE: XDEX_MATCH_VIEW_CHANGE, NEW_VIEW: XDEX_MATCH_NEW_VIEW,
            FINAL_SYNC: XDEX_MATCH_FINAL_SYNC
        };
        // Engines configured before FINAL_SYNC existed get a derived type so
        // straggler catch-up works without every caller updating its map.
        if(!this.types.FINAL_SYNC) this.types.FINAL_SYNC = String(this.types.PROPOSE).replace(/PROPOSE$/, 'FINAL_SYNC');
        this.controlTags  = opts.controlTags || { vc: 'XDEXVC', nv: 'XDEXNV' };
        this.idField      = opts.idField || 'match_id';

        this.pending = new Map();

        // Finalized match ids (ring-buffer bounded, FIFO eviction; mirrors
        // AttestationConsensus.finalized). Suppresses duplicate finalize/late COMMITs.
        this.finalized       = new Set();
        this._finalizedOrder = [];
        this.finalizedMax    = parseInt(this.config.XDEX_FINALIZED_MAX) || 10000;

        // Finalized round payloads (row + quorum signatures), same eviction as
        // `finalized`. Serves FINAL_SYNC catch-up: a straggler that missed a
        // round (e.g. its local validation raced confirmation depth) keeps
        // emitting VIEW_CHANGEs; peers that finalized ignore the round, so
        // without state transfer the straggler's mirror NEVER gets the row.
        this.finalizedRows   = new Map();

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
        // A round that keeps view-changing without ever finalizing (sustained
        // message loss, e.g. P2P rate-limit drops during a burst of concurrent
        // rounds) must not leak in `pending` forever: past this lifetime it is
        // abandoned so the engine can re-propose a fresh round once the storm
        // clears. Default = several view-change cycles.
        this.roundMaxLifetimeMs = parseInt(this.config.XDEX_ROUND_MAX_LIFETIME_MS) || (this.roundTimeoutMs * 4);
    }

    async start(){
        if(!this.peerManager){
            console.log('CrossChainDexConsensus: no peer manager; single-node finalize only');
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
    // signature like the PROPOSE/PREPARE/COMMIT phases (NOT by envelope.sender,
    // which the transport sets to a validator address while our snapshot set is
    // pubkey-keyed). Binds tag+matchId+view so a vote can't be replayed elsewhere.
    _controlPayload(tag, rid, view){ return tag + '|' + rid + '|' + view; }
    _signControl(tag, rid, view){ return this.identity.sign(this._controlPayload(tag, rid, view)); }
    _verifyControl(tag, rid, view, pubkey, sig){
        return ValidatorIdentity.verify(this._controlPayload(tag, rid, view), String(sig || ''), String(pubkey || '').toLowerCase());
    }

    // Sort the snapshot validators by pubkey so every node agrees on ordering,
    // then index by (matchIdInt + view) % N. Mirrors Consensus._getLeader.
    _leaderFor(matchId, validators, view){
        if(!validators || validators.length === 0) return null;
        let sorted = validators.map(v => String(v.pubkey).toLowerCase()).sort();
        let mInt   = parseInt(String(matchId).slice(0, 8), 16) || 0;
        return sorted[(mInt + (view || 0)) % sorted.length];
    }

    // Every node runs this on discovery: the leader broadcasts PROPOSE; followers
    // create the round (so they hold the failover timer + can validate the
    // leader's PROPOSE). quorum 0 -> single-node immediate self-sign + finalize.
    async propose(matchId, ctx){
        let rid = String(matchId).toLowerCase();
        if(this.finalized.has(rid) || this.pending.has(rid)) return;
        if(!this.identity) throw new Error('no validator identity: cannot run cross-chain match consensus');

        let row        = ctx.row;
        let validators = (ctx.snapshot && Array.isArray(ctx.snapshot.validators)) ? ctx.snapshot.validators : [];
        let snapCount  = validators.length;
        // STAKE_WEIGHTED_QUORUM: at/above the activation snapshot_block, finalize on
        // summed signer STAKE (>2/3 of S, source-deduped) rather than signer COUNT.
        // Gated on the row's BTC snapshot_block + network so hub and every indexer
        // flip on the same anchor. Below activation: byte-for-byte the count rule.
        let weighted   = swq.isStakeWeightedQuorumActive(row.snapshot_block, row.network);
        let quorum     = (snapCount <= 1) ? 0 : Math.max(2 * Math.floor((snapCount - 1) / 3) + 1, Math.ceil((snapCount + 1) / 2));
        let canonical  = this.engine._canonicalMatch(row, 0);   // new round always starts at view 0
        let myPubkey   = this.identity.getPubkeyHex().toLowerCase();

        let pending = {
            matchId:      rid,
            startedAt:    Date.now(),    // round birth; abandon if unfinalized past roundMaxLifetimeMs
            row:          row,
            canonical:    canonical,
            // Carry source + weight so the weighted tally can dedupe by staking
            // address (DELEGATE v0 is additive: one source, many keys, one vote).
            validators:   validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0')) })),
            quorum:       quorum,
            weighted:     weighted,
            view:         0,
            myPubkey:     myPubkey,
            prepares:     new Set(),
            commits:      new Set(),
            signatures:   new Map(),     // pubkey -> sig over canonical
            viewChanges:  new Map(),     // view -> Set<pubkey>
            finalized:    false,
            _commitSent:  false,
            timer:        null
        };
        this.pending.set(rid, pending);

        // Single-operator / no-federation: persist the snapshot (so the indexer can
        // verify), sign with our own identity, and finalize immediately. This is
        // byte-for-byte the pre-PBFT behavior (there is no PROPOSE round to carry
        // the persist). snapCount<=1 (quorum===0) is the single-operator fast path
        // in BOTH modes: the sole validator's own stake is the whole snapshot, so
        // it trivially satisfies 3·weight>2·S as well.
        if(quorum === 0){
            // quorum 0 arises from TWO very different snapshots, and only one is safe
            // to finalize unilaterally: a genuine single-operator federation whose sole
            // validator is THIS hub. An EMPTY snapshot (snapCount === 0, e.g. a bootstrap
            // / mirror-lag read or seed-local disabled) ALSO yields quorum 0, but self-
            // signing there writes a 1-sig match that peers holding a populated snapshot
            // will never ratify: the order wedges permanently (match_id lands in
            // `finalized`, never re-proposed) and this hub's committed ledger forks from
            // the federation. Only the sole-self case may fast-path; otherwise abort the
            // round and let discovery re-propose once the snapshot populates.
            let soleSelf = snapCount === 1 && String(validators[0].pubkey).toLowerCase() === myPubkey;
            if(!soleSelf){
                this.pending.delete(rid);
                console.warn('CrossChainDexConsensus: refusing to finalize match ' + rid +
                    ' with quorum 0 over a ' + (snapCount === 0 ? 'EMPTY' : 'non-self single-validator') +
                    ' cross_chain snapshot (snapshot_block=' + row.snapshot_block +
                    '); will retry when the snapshot populates');
                return;
            }
            try { await this.engine._persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block), row.network); }
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
        let t = setTimeout(() => this._onRoundTimeout(rid), this.roundTimeoutMs);
        if(t.unref) t.unref();                          // housekeeping timer; never pin process liveness
        return t;
    }

    // Round timeout: rotate the leader (view-change) UNLESS the round has churned
    // past its max lifetime without finalizing, in which case abandon it so the
    // engine re-proposes a fresh round. View-change only helps a faulty leader; it
    // cannot recover a round whose PREPARE/COMMIT traffic is being dropped (e.g. a
    // peer over the P2P rate limit during a burst). Re-propose IS idempotent
    // (synthetic TX_HASH dedup) and by abandon time the burst that starved the
    // round has passed, so the retry finalizes cleanly. Without this, such a round
    // leaks in `pending` forever (propose() no-ops on a still-pending id) and the
    // call/match wedges permanently until a process restart.
    _onRoundTimeout(rid){
        let p = this.pending.get(rid);
        if(!p || p.finalized) return;
        if((Date.now() - p.startedAt) > this.roundMaxLifetimeMs){
            if(p.timer) clearTimeout(p.timer);
            this.pending.delete(rid);
            console.warn('CrossChainDexConsensus: abandoned stale round ' + rid.substring(0, 16) +
                         '... after ' + Math.round((Date.now() - p.startedAt) / 1000) + 's unfinalized; engine will re-propose');
            this.emit('match:abandoned', { matchId: rid });
            return;
        }
        this._initiateViewChange(rid);
    }

    // Leader action: persist snapshot, sign canonical, seed own vote, broadcast PROPOSE.
    async _broadcastPropose(pending){
        try { await this.engine._persistCapabilitySnapshot('cross_chain', Number(pending.row.snapshot_block), pending.row.network); }
        catch(e){ console.warn('CrossChainDexConsensus: snapshot persist failed: ' + (e && e.message)); }
        let mySig = this.identity.sign(pending.canonical);
        pending.signatures.set(pending.myPubkey, mySig);
        pending.prepares.add(pending.myPubkey);
        if(this.peerManager){
            this.peerManager.broadcast(this.types.PROPOSE, {
                matchId: pending.matchId, view: pending.view, row: pending.row,
                sig_pubkey: pending.myPubkey, sig: mySig
            });
        }
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case this.types.PROPOSE:     this._handlePropose(envelope).catch(e => console.error('CrossChainDexConsensus: PROPOSE error: ' + (e && e.message))); break;
            case this.types.PREPARE:     this._handlePrepare(envelope);    break;
            case this.types.COMMIT:      this._handleCommit(envelope);     break;
            case this.types.VIEW_CHANGE: this._handleViewChange(envelope); break;
            case this.types.NEW_VIEW:    this._handleNewView(envelope);    break;
            case this.types.FINAL_SYNC:  this._handleFinalSync(envelope);  break;
        }
    }

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

        // The proposed row must hash to this round's id.
        let row = d.row;
        if(!row || String(row[this.idField]).toLowerCase() !== rid) return;
        let canonical = this.engine._canonicalMatch(row, view);   // leader signed at THEIR view (d.view)

        // Verify the leader's signature over THEIR canonical.
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), senderPubkey)) return;

        // INDEPENDENT confirmation: re-derive + validate against our own view of
        // the underlying data. This (not byte-equality with our locally pre-built
        // row) is the gate against a Byzantine leader.
        let ok = false;
        try { ok = await this.engine.validateProposedMatch(row); }
        catch(e){ ok = false; }
        if(!ok){
            console.warn('CrossChainDexConsensus: PROPOSE ' + rid.substring(0,16) + '... failed local validation; not signing');
            return;
        }

        let adopted = false;
        if(canonical !== pending.canonical){
            // Leader-choice fields (effective_time = the leader's clock second,
            // snapshot_block = the leader's chain-tip view) legitimately differ
            // from the row WE pre-built at discovery, so byte-equality here
            // deadlocked every round whose hubs polled in different seconds.
            // The leader's row passed independent validation above; adopt it as
            // the round canonical, unless we already committed to another VALUE.
            // A canonical that differs only because the view advanced (OUR row
            // at the leader's view == the leader's canonical) is value-identical:
            // with the EQUIV header active every view change moves the canonical
            // bytes, and refusing post-commit adoption of the same value would
            // deadlock every commit-phase node out of the new view, starving
            // failover quorum (H-8). PBFT forbids committing to a different
            // value, not re-voting the same value under a new view.
            let sameValueNewView = (this.engine._canonicalMatch(pending.row, view) === canonical);
            if(pending._commitSent && !sameValueNewView) return;
            pending.row       = row;
            pending.canonical = canonical;
            pending.signatures.clear();   // any collected sigs were over the old canonical
            pending.prepares.clear();
            pending.commits.clear();
            pending._commitSent = false;
            adopted = true;
            console.log('CrossChainDexConsensus: adopted leader canonical for ' + rid.substring(0,16) + '...');
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
                this.peerManager.broadcast(this.types.PREPARE, {
                    matchId: rid, view: pending.view, sig_pubkey: pending.myPubkey, sig: mySig
                });
            }
        }
        this._checkPrepareQuorum(rid);

        // PREPARE/COMMIT votes that raced ahead of this PROPOSE failed signature
        // verification against our stale canonical and were buffered; replay them
        // now that the round canonical matches what they signed.
        if(adopted) this._drainEarlyMessages(rid);
    }

    _handlePrepare(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this._bufferEarlyMessage(rid, envelope); return; }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === senderPubkey)) return;
        if(!d.sig || !ValidatorIdentity.verify(pending.canonical, String(d.sig), senderPubkey)){
            // A vote only counts with a verifying signature over the round
            // canonical. A mismatch usually means this vote raced ahead of the
            // leader's PROPOSE (we still hold our pre-built canonical); buffer
            // it for replay after adoption rather than losing it.
            this._bufferEarlyMessage(rid, envelope);
            return;
        }
        pending.signatures.set(senderPubkey, String(d.sig));
        pending.prepares.add(senderPubkey);
        this._checkPrepareQuorum(rid);
    }

    // Quorum test for a collected vote set (prepares or commits). Stake-weighted
    // (source-deduped 3·Sigma>2·S) at/above activation; signer COUNT (>=2f+1) below it.
    _meetsQuorum(pending, voteSet){
        if(pending.weighted)
            return swq.meetsStakeThreshold(pending.validators, voteSet);
        return voteSet.size >= pending.quorum;
    }

    _checkPrepareQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized || pending._commitSent) return;
        if(!this._meetsQuorum(pending, pending.prepares)) return;
        pending._commitSent = true;
        pending.commits.add(pending.myPubkey);
        let mySig = pending.signatures.get(pending.myPubkey) || null;
        if(this.peerManager){
            this.peerManager.broadcast(this.types.COMMIT, {
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
        if(!d.sig || !ValidatorIdentity.verify(pending.canonical, String(d.sig), senderPubkey)){
            // Unverified commits must NOT count toward quorum: counting them let a
            // node whose canonical diverged "finalize" with zero collected
            // signatures and persist an unverifiable mirror row. Buffer for
            // replay in case the leader's PROPOSE (and adoption) is still racing.
            this._bufferEarlyMessage(rid, envelope);
            return;
        }
        pending.signatures.set(senderPubkey, String(d.sig));
        pending.commits.add(senderPubkey);
        this._checkCommitQuorum(rid);
    }

    _checkCommitQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        if(!this._meetsQuorum(pending, pending.commits)) return;
        this._finalize(rid);
    }

    _finalize(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        pending.finalized = true;

        let sigs = [];
        for(let [pk, sg] of pending.signatures) sigs.push({ pubkey: pk, sig: sg });

        this._markFinalized(rid, pending.row, sigs, pending.view);
        if(pending.timer){ clearTimeout(pending.timer); pending.timer = null; }

        console.log('CrossChainDexConsensus: finalized ' + rid.substring(0,16) + '... (' +
                    pending.prepares.size + ' prepares, ' + pending.commits.size + ' commits, ' + sigs.length + ' sigs)');
        // `view` = the PBFT view this round finalized at (incremented per view-change).
        // Persisted as finalizing_view so the indexer rebuilds the exact EQUIV canonical
        // (WI-2 bump 2); below the EQUIV flag-day it is stored but unused.
        this.emit('match:finalized', { matchId: rid, row: pending.row, signatures: sigs, view: pending.view });

        let cleanup = setTimeout(() => this.pending.delete(rid), PENDING_EVICT_MS);
        if(cleanup.unref) cleanup.unref();             // housekeeping timer; never pin process liveness
    }

    // Reorg support (deepdive M-13): drop a round id from the finalized ring so a
    // re-confirmed action can run a FRESH round for it. Once a round finalizes its
    // id sits in `finalized` (ring-buffer bounded) and propose() no-ops on it, which
    // is correct steady-state dedup but permanently wrong after a reorg RETRACTS the
    // row and the underlying action later re-confirms: the deterministic round can
    // never re-finalize and the call/match stays stranded in 'retracted'. Retraction
    // paths call this so the next propose() runs. Also evicts any live pending round
    // (and its cached FINAL_SYNC payload) so a round still in flight at retraction
    // time cannot finalize afterward and resurrect the just-retracted row. Exactly-once
    // still holds: the DB row keyed on (call_id/match_id, phase) is the single slot
    // indexers act on, and re-finalization overwrites it (ON DUPLICATE KEY UPDATE),
    // so at most one live row exists per confirmed action.
    forgetFinalized(rid){
        rid = String(rid).toLowerCase();
        let had = this.finalized.delete(rid);
        this.finalizedRows.delete(rid);
        if(had){
            let i = this._finalizedOrder.indexOf(rid);
            if(i >= 0) this._finalizedOrder.splice(i, 1);
        }
        let p = this.pending.get(rid);
        if(p){
            if(p.timer) clearTimeout(p.timer);
            this.pending.delete(rid);
        }
        return had;
    }

    _markFinalized(rid, row, signatures, view){
        if(this.finalized.has(rid)) return;
        this.finalized.add(rid);
        // Store the finalizing view too: FINAL_SYNC state-transfer must tell a straggler
        // which view the quorum signatures were taken at, so it rebuilds the exact EQUIV canonical.
        if(row) this.finalizedRows.set(rid, { row: row, signatures: signatures || [], view: view || 0 });
        this._finalizedOrder.push(rid);
        if(this._finalizedOrder.length > this.finalizedMax){
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
            this.finalizedRows.delete(oldest);
        }
    }

    _initiateViewChange(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        pending.view++;
        let view = pending.view;
        if(!pending.viewChanges.has(view)) pending.viewChanges.set(view, new Set());
        pending.viewChanges.get(view).add(pending.myPubkey);
        if(this.peerManager) this.peerManager.broadcast(this.types.VIEW_CHANGE, {
            matchId: rid, view: view, sig_pubkey: pending.myPubkey, sig: this._signControl(this.controlTags.vc, rid, view)
        });
        if(pending.timer) clearTimeout(pending.timer);
        pending.timer = this._armTimer(rid);
        this._maybeAssumeLeadership(rid, view);
    }

    _handleViewChange(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid) return;
        if(this.finalized.has(rid)){
            // A VIEW_CHANGE for a round we finalized means the voter is a
            // straggler stuck in failover purgatory. The round can never
            // re-reach quorum (everyone else moved on), so answer with the
            // finalized row + its quorum signatures (state transfer).
            let fin = this.finalizedRows.get(rid);
            if(fin && this.peerManager){
                this.peerManager.broadcast(this.types.FINAL_SYNC, {
                    matchId: rid, row: fin.row, signatures: fin.signatures, view: fin.view
                });
            }
            return;
        }
        let pending = this.pending.get(rid);
        if(!pending){ this._bufferEarlyMessage(rid, envelope); return; }
        let view = Number(d.view);
        if(!Number.isFinite(view)) return;
        let voter = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === voter)) return;     // not a validator
        if(!this._verifyControl(this.controlTags.vc, rid, view, voter, d.sig)) return; // unauthenticated vote
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
        if(!votes || !this._meetsQuorum(pending, votes)) return;
        if(view > pending.view) pending.view = view;
        let newLeader = this._leaderFor(rid, pending.validators, view);
        if(newLeader === pending.myPubkey){
            // Rebuild the round canonical for the NEW view before signing (H-8):
            // once the EQUIV header is active the view is folded into the
            // canonical, so re-signing the view-0 bytes under a new-view PROPOSE
            // fails every follower's verification (they recompute at d.view) and
            // failover can never make progress. Votes collected so far covered
            // the OLD canonical, so they are dropped with it; below the EQUIV
            // flag-day the rebuild is byte-identical and this is a no-op that
            // preserves collected votes.
            let canonical = this.engine._canonicalMatch(pending.row, pending.view);
            if(canonical !== pending.canonical){
                pending.canonical = canonical;
                pending.signatures.clear();
                pending.prepares.clear();
                pending.commits.clear();
                pending._commitSent = false;
            }
            if(this.peerManager) this.peerManager.broadcast(this.types.NEW_VIEW, {
                matchId: rid, view: view, sig_pubkey: pending.myPubkey, sig: this._signControl(this.controlTags.nv, rid, view)
            });
            this._broadcastPropose(pending).catch(e => console.warn('CrossChainDexConsensus: re-propose failed: ' + (e && e.message)));
        }
    }

    // FINAL_SYNC (straggler catch-up): a peer answered our VIEW_CHANGE for a
    // round the federation already finalized. The quorum signatures over the
    // canonical ARE the proof (the same proof the indexers verify), so a
    // forged sync would need 2f+1 real validator signatures. Adopt + finalize.
    _handleFinalSync(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;                          // only rescues a live stuck round

        let row = d.row;
        if(!row || String(row[this.idField]).toLowerCase() !== rid) return;
        let canonical = this.engine._canonicalMatch(row, Number(d.view) || 0);   // sigs were taken at the finalizing view

        let offered = Array.isArray(d.signatures) ? d.signatures : [];
        let verified = new Map();
        for(let s of offered){
            if(!s || !s.pubkey || !s.sig) continue;
            let pk = String(s.pubkey).toLowerCase();
            if(!pending.validators.some(v => v.pubkey === pk)) continue;
            if(!ValidatorIdentity.verify(canonical, String(s.sig), pk)) continue;
            verified.set(pk, String(s.sig));
        }
        // The offered signatures must themselves clear the round's quorum (weighted
        // at/above activation, else >=2f+1). A forged sync would need a real quorum.
        let proofOk = pending.weighted
            ? swq.meetsStakeThreshold(pending.validators, verified.keys())
            : (verified.size >= Math.max(pending.quorum, 1));
        if(!proofOk) return;                                               // not a quorum proof; ignore

        pending.row        = row;
        pending.canonical  = canonical;
        pending.signatures = verified;
        console.log('CrossChainDexConsensus: FINAL_SYNC caught up ' + rid.substring(0,16) + '... (' + verified.size + ' sigs)');
        this._finalize(rid);
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
        // guard: a Byzantine node can only announce views in which it is the leader).
        let expected = this._leaderFor(rid, pending.validators, view);
        if(!expected || announcer !== expected) {
            console.warn('CrossChainDexConsensus: ignoring NEW_VIEW for view ' + view + ' from non-leader');
            return;
        }
        if(!this._verifyControl(this.controlTags.nv, rid, view, announcer, d.sig)) return;
        pending.view = view;
    }
}

module.exports = CrossChainDexConsensus;
module.exports.XDEX_MATCH_PROPOSE     = XDEX_MATCH_PROPOSE;
module.exports.XDEX_MATCH_PREPARE     = XDEX_MATCH_PREPARE;
module.exports.XDEX_MATCH_COMMIT      = XDEX_MATCH_COMMIT;
module.exports.XDEX_MATCH_VIEW_CHANGE = XDEX_MATCH_VIEW_CHANGE;
module.exports.XDEX_MATCH_NEW_VIEW    = XDEX_MATCH_NEW_VIEW;
module.exports.XDEX_MATCH_FINAL_SYNC  = XDEX_MATCH_FINAL_SYNC;
