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
 * XChain Hub - Cross-Chain PBFT Round Opening
 *
 * Opening a round and keeping it alive: the snapshot it binds to, the single-operator fast
 * path, the leader's PROPOSE, the round timer and its abandon, and the rebind that measures
 * a newly offered row against the membership the row itself declares.
 *
 ********************************************************************/

const swq = require('../../consensus/stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
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

        if(this.refuseTruncatedRound(rid, row, validators, weighted)) return;

        let pending    = this.openPendingRound(rid, row, validators, weighted);
        let quorum     = pending.quorum;
        let canonical  = pending.canonical;
        let myPubkey   = pending.myPubkey;

        // Single-operator / no-federation: persist the snapshot (so the indexer can
        // verify), sign with our own identity, and finalize immediately. This is
        // byte-for-byte the pre-PBFT behavior (there is no PROPOSE round to carry
        // the persist). snapCount<=1 (quorum===0) is the single-operator fast path
        // in BOTH modes: the sole validator's own stake is the whole snapshot, so
        // it trivially satisfies 3·weight>2·S as well.
        if(quorum === 0){
            await this.finalizeSoleOperator(rid, pending, row, validators, snapCount, myPubkey, canonical);
            return;
        }

        pending.timer = this.armTimer(rid);

        // If we are the round leader, persist the capability snapshot (so indexers
        // can verify) and broadcast PROPOSE. Followers just wait (+ hold the timer).
        let leader = this.leaderFor(rid, pending.validators, pending.view);
        if(leader === myPubkey){
            await this.broadcastPropose(pending);
        }

        this.drainEarlyMessages(rid);
    },

    // True when the round was refused over a truncated weighted snapshot.
    refuseTruncatedRound(rid, row, validators, weighted){
        // Fail CLOSED on a TRUNCATED weighted snapshot (SWQ-TRUNC parity). At/above
        // STAKE_WEIGHTED_QUORUM the tally is summed STAKE; a snapshot that overflowed the
        // frozen VALIDATOR_QUERY_LIMIT has silently-dropped sources, so S is under-counted
        // and the strict 2/3 bar could finalize a round a full snapshot would reject (the
        // stake-eviction forge SWQ-TRUNC-1 closed on the consumer side). Every indexer
        // consumer already fails closed on it (meetsStakeThreshold), so a round proposed
        // here could ONLY mirror a row every indexer rejects. Refuse up front, release the
        // engine's inflight slot (match:abandoned) so discovery retries once the set fits,
        // and alarm the operator to raise the (frozen, coordinated) VALIDATOR_QUERY_LIMIT.
        // The COUNT path (below activation) stays proceed-on-truncation: the cap is
        // cross-hub deterministic there (CapabilitySnapshot.getQuorum), so quorum is
        // consistent fleet-wide and refusing would needlessly halt.
        if(weighted && validators && validators.truncated === true){
            logger.error('CrossChainDexConsensus: refusing round ' + rid.substring(0, 16) +
                '... over a TRUNCATED weighted cross_chain snapshot (snapshot_block=' + row.snapshot_block +
                '): the cross_chain set overflowed VALIDATOR_QUERY_LIMIT so summed stake S is under-counted and ' +
                'no quorum can safely finalize; raise VALIDATOR_QUERY_LIMIT (coordinated fleet upgrade). Will retry when the set fits.');
            this.emit('match:abandoned', { matchId: rid });
            return true;
        }
        return false;
    },

    // The round's pending state over the snapshot it opens with, registered under its id.
    openPendingRound(rid, row, validators, weighted){
        let snapCount  = validators.length;
        let quorum     = bftQuorumOrSingle(snapCount, 0);   // majority-floored BFT quorum (0 = single-node self-sign)
        let canonical  = this.engine.canonicalMatch(row, 0);   // new round always starts at view 0
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
        return pending;
    },

    async finalizeSoleOperator(rid, pending, row, validators, snapCount, myPubkey, canonical){
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
            logger.warn('CrossChainDexConsensus: refusing to finalize match ' + rid +
                ' with quorum 0 over a ' + (snapCount === 0 ? 'EMPTY' : 'non-self single-validator') +
                ' cross_chain snapshot (snapshot_block=' + row.snapshot_block +
                '); will retry when the snapshot populates');
            // Release the engine's inflight slot so discovery re-proposes once the
            // snapshot populates. Without this the engine (which added round_id to
            // _inflight before calling propose) never re-attempts the call/match on
            // THIS hub, wedging its participation even as leader.
            this.emit('match:abandoned', { matchId: rid });
            return;
        }
        try { await this.engine.persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block), row.network); }
        catch(e){ logger.warn('CrossChainDexConsensus: snapshot persist failed: ' + (e && e.message)); }
        let sig = this.identity.sign(canonical);
        pending.signatures.set(myPubkey, sig);
        this.finalize(rid);
    },

    armTimer(rid){
        let t = setTimeout(() => this.onRoundTimeout(rid), this.roundTimeoutMs);
        if(t.unref) t.unref();                          // housekeeping timer; never pin process liveness
        return t;
    },

    // Round timeout: rotate the leader (view-change) UNLESS the round has churned
    // past its max lifetime without finalizing, in which case abandon it so the
    // engine re-proposes a fresh round. View-change only helps a faulty leader; it
    // cannot recover a round whose PREPARE/COMMIT traffic is being dropped (e.g. a
    // peer over the P2P rate limit during a burst). Re-propose IS idempotent
    // (synthetic TX_HASH dedup) and by abandon time the burst that starved the
    // round has passed, so the retry finalizes cleanly. Without this, such a round
    // leaks in `pending` forever (propose() no-ops on a still-pending id) and the
    // call/match wedges permanently until a process restart.
    onRoundTimeout(rid){
        let p = this.pending.get(rid);
        if(!p || p.finalized) return;
        if((Date.now() - p.startedAt) > this.roundMaxLifetimeMs){
            if(p.timer) clearTimeout(p.timer);
            this.pending.delete(rid);
            logger.warn('CrossChainDexConsensus: abandoned stale round ' + rid.substring(0, 16) +
                         '... after ' + Math.round((Date.now() - p.startedAt) / 1000) + 's unfinalized; engine will re-propose');
            this.emit('match:abandoned', { matchId: rid });
            return;
        }
        this.initiateViewChange(rid);
    },

    // Leader action: persist snapshot, sign canonical, seed own vote, broadcast PROPOSE.
    async broadcastPropose(pending){
        try { await this.engine.persistCapabilitySnapshot('cross_chain', Number(pending.row.snapshot_block), pending.row.network); }
        catch(e){ logger.warn('CrossChainDexConsensus: snapshot persist failed: ' + (e && e.message)); }
        let mySig = this.identity.sign(pending.canonical);
        pending.signatures.set(pending.myPubkey, mySig);
        pending.prepares.add(pending.myPubkey);
        if(this.peerManager){
            this.peerManager.broadcast(this.types.PROPOSE, {
                matchId: pending.matchId, view: pending.view, row: pending.row,
                sig_pubkey: pending.myPubkey, sig: mySig
            });
        }
    },

    // Re-resolve the round's membership, quorum and activation mode at the snapshot a
    // newly offered row DECLARES, so a vote is never counted against a set the row did
    // not name. Returns null when the row declares the snapshot the round already holds
    // (nothing to rebind), the new binding when it resolved, and false when the caller
    // must refuse the row. Refusal is the fail-closed side of every ambiguity here: an
    // unresolvable, empty, single-validator or truncated-weighted set cannot be measured
    // the way the indexer consumers measure it, and finalizing under the round's stale
    // set would publish a row those consumers retire.
    async rebindSnapshot(pending, row){
        let sameBlock   = String(row.snapshot_block) === String(pending.row.snapshot_block);
        let sameNetwork = String(row.network || '')  === String(pending.row.network || '');
        if(sameBlock && sameNetwork) return null;
        if(typeof this.engine.resolveCapabilityValidators !== 'function'){
            logger.warn('CrossChainDexConsensus: refusing a row at snapshot_block=' + row.snapshot_block +
                ' because this engine cannot re-resolve the cross_chain set');
            return false;
        }
        let raw = null;
        try { raw = await this.engine.resolveCapabilityValidators('cross_chain', Number(row.snapshot_block), row.network); }
        catch(e){ raw = null; }
        if(!Array.isArray(raw) || raw.length === 0){
            logger.warn('CrossChainDexConsensus: refusing a row at snapshot_block=' + row.snapshot_block +
                ': the cross_chain set there resolved empty');
            return false;
        }
        let weighted = swq.isStakeWeightedQuorumActive(row.snapshot_block, row.network);
        // Same SWQ-TRUNC parity propose() enforces: a truncated weighted snapshot
        // under-counts S, so the strict two-thirds bar could pass a round the full set
        // rejects. The count path stays proceed-on-truncation there, and does here too.
        if(weighted && raw.truncated === true){
            logger.error('CrossChainDexConsensus: refusing a row at snapshot_block=' + row.snapshot_block +
                ' over a TRUNCATED weighted cross_chain snapshot; raise VALIDATOR_QUERY_LIMIT');
            return false;
        }
        let validators = raw.map(v => ({
            pubkey: String(v.pubkey).toLowerCase(),
            source: String(v.source != null ? v.source : ''),
            weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0'))
        }));
        let quorum = bftQuorumOrSingle(validators.length, 0);
        // quorum 0 is the single-operator fast path propose() takes at round OPEN, over
        // a snapshot this hub read for itself. Mid-round it would mean adopting a
        // stranger's row and then ratifying it alone, so it is refused here.
        if(quorum === 0){
            logger.warn('CrossChainDexConsensus: refusing a row at snapshot_block=' + row.snapshot_block +
                ': the declared snapshot collapses to a single-validator quorum mid-round');
            return false;
        }
        return { validators, quorum, weighted };
    },
};
