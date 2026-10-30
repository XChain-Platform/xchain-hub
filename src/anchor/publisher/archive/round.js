/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR publisher - archive signing round
 *
 * The leader side of a v1 archive: elect, gather the pending rows, build the
 * archive, and run the signing round its followers verify against their own rows.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { listIdsOf } = require('./list/list_rows_select.js');
const archivePublishGate = require('../../archive_publish_gate.js');
const { bftQuorumOrSingle } = require('../../../lib/bft_quorum.js');
const { resolveQuorumNetwork } = require('../../quorum_network.js');
const swq = require('../../../consensus/stake_weighted_quorum.js');
const { XANC_SIGN_REQ } = require('../constants.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

    // The leader's archive election reads its set here; network is the network
    // on which that set is judged.
    archiveElectionPubkeys(blockIndex, network){
        return this.getArchivePublishPubkeys(blockIndex, network);
    },

    // Leader = hash-order rank 0 over oracle_publish, with the checkpoint leg's
    // failover ladder. Its key and age use the oldest block-bearing archive row,
    // which stays pending as newer checkpoints arrive, so checkpoint cadence cannot
    // reset the ladder. The hub-local batch seq is not part of the election key.
    // Each further rank unlocks after another ANCHOR_ELECTION_TOLERANCE_BLOCKS.
    // Returns the flush summary's archive status.
    async startArchiveRound(signer, electionBlock, failoverOnly){
        // One at a time across signature collection and an in-flight publish.
        if(this._archiveRound || this._archivePublishing) return this.archiveFlushStatus('round_pending', 'round_or_publish_pending');
        if(this.archiveTipUnresolved(electionBlock)) return this.archiveFlushStatus('none', 'tip_unresolved');

        // Election uses the current BTC block so a new validator can take over a
        // stalled publish. This set chooses the driver; the snapshot-block set below
        // still decides which signatures count on-chain.
        let electionPubkeys = await this.archiveElectionPubkeys(electionBlock, this.network);
        let me = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
        if(!this.archiveElectionAdmits(electionPubkeys, me, electionBlock)) return this.archiveFlushStatus('none', 'election_not_admitted');

        let rows = await this.gatherUnpublishedArchiveRows();
        if(!rows) return this.archiveFlushStatus('none', 'no_pending_rows');

        let cps = await this.latestArchiveWrapperRows();
        if(!cps || cps.length === 0){
            logger.info('StateAnchorPublisher: no state checkpoint yet; archive deferred');
            return this.archiveFlushStatus('none', 'no_wrapper_checkpoint');
        }
        let cp = this.cpFromRow(cps[0]);
        let network  = String(cps[0].network);

        let liveIntent = await this.getLiveArchiveIntent(network);
        if(this.archiveRoundIntentHeld(liveIntent, network)) return this.archiveFlushStatus('intent_held', 'live_intent_held');

        let batchSeq = await this.getNextBatchSeq();
        // Lead only above the seqs our own DOGE address already spent
        batchSeq = await this.leaderBatchSeqAboveOwn(batchSeq);
        let rewardRows = await this.resolveArchiveRewardSources(rows.rewards);
        if(this.archiveEmptyAfterResolution(rows, rewardRows)) return this.archiveFlushStatus('none', 'empty_after_reward_resolution');

        const archive  = await this.buildSizedArchive(network, batchSeq, rows, cp.snapshot_block, rewardRows);
        this.archiveRankLockReason = null;
        if(this.archiveRankLocked(cp, electionPubkeys, me, electionBlock, batchSeq,
                                  failoverOnly, JSON.parse(archive.json))) return this.archiveFlushStatus('none', this.archiveRankLockReason || 'rank_locked');
        let wire      = this.archiveWire(archive.json);

        let canonical = this.archiveCanonical(cp, batchSeq, archive.count, wire.crc, wire.chunks.length);
        if(!this.identity) throw new Error('no validator identity: cannot sign archives');
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let mySig    = this.identity.sign(canonical);

        let signingSet = await this.archiveSigningSet(cp);
        if(this.archiveSigningSetUnresolved(signingSet, cp, batchSeq)) return this.archiveFlushStatus('none', 'signing_set_unresolved');
        let round = this.openArchiveRound({ cp, batchSeq, wire, canonical, signer, electionBlock, archive, rows, rewardRows, signingSet, myPubkey, mySig });
        if(rows.cappedOrTrimmed) this._leaderRetryDue = true;

        if(signingSet.length <= 1){                                          // single-node: self-sign suffices
            if(this.singleMemberCannotSelfSign(round, cp, batchSeq)) return this.archiveFlushStatus('none', 'single_member_cannot_self_sign');
            const status = await this.publishSingleMemberArchive(round);
            return this.archiveFlushStatus(status, status === 'intent_held' ? 'publish_intent_held' : 'single_member_published');
        }

        this.armArchiveRound(round, batchSeq);
        this.broadcastArchiveSignReq(cp, batchSeq, archive, wire, electionBlock, myPubkey, mySig);
        await this.checkArchiveQuorum();
        return this.archiveFlushStatus('round_started', 'signature_round_started');
    },

    archiveFlushStatus(status, reason){
        logger.info('StateAnchorPublisher: archive flush summary: status=' + status + ' reason=' + reason);
        return status;
    },

    // Fail closed on an unresolved BTC tip. flush() passes whatever
    // hub.resolveBtcLatestBlock() returned, and that is null whenever the pushed tip
    // is stale, the indexer lags past MAX_INDEXER_LAG_BLOCKS, or the RPC fails. A null
    // block makes getActiveOraclePublishPubkeys take its block-UNPINNED branch, whose
    // own contract scopes it to the coarse BUNDLE_DONE / FINALIZED sender pre-filter: it
    // answers from the per-hub, gossip-driven capabilityRegistry, so two hubs would
    // elect over different member lists on a path that spends real DOGE. The follower
    // side already refuses this round (handleSignReq bounds election_block to its own
    // tip), so the leader-side defer costs a stalled multi-hub round it was never going
    // to complete, and closes the single-member case that self-quorums today. Same
    // fail-closed idiom as the empty-set defer below; rows stay pending for the next
    // flush, exactly like the balance and spend-guard gates in flush().
    archiveTipUnresolved(electionBlock){
        if(!Number.isFinite(electionBlock)){
            logger.warn('StateAnchorPublisher: BTC tip unresolved (' + electionBlock +
                         '); deferring archive round rather than electing over the ' +
                         'block-unpinned live registry (fail closed)');
            return true;
        }
        return false;
    },

    // Fail closed: an empty/unresolved oracle_publish set must defer the
    // archive round, not let every hub drive it independently (each would
    // broadcast a competing v1 + burn DOGE for the same batch slot).
    // True when this hub may drive an archive round over the resolved election set.
    archiveElectionAdmits(electionPubkeys, me, electionBlock){
        if(electionPubkeys.length === 0){
            logger.info('StateAnchorPublisher: archive election at block ' + electionBlock +
                        ': empty oracle_publish set, deferring round (fail closed)');
            return false;
        }
        if(!me) return false;
        if(!electionPubkeys.includes(me)){
            logger.info('StateAnchorPublisher: archive election at block ' + electionBlock +
                        ': own pubkey not in the oracle_publish election set (' + electionPubkeys.length + ' eligible)');
            return false;                                               // not an eligible publisher right now
        }
        return true;
    },

    // True when the failover ladder says this hub does not publish this batch now.
    archiveRankLocked(cp, electionPubkeys, me, electionBlock, batchSeq, failoverOnly, archive){
        this.archiveRankLockReason = null;
        {
            // Membership already pins size 1, whose ladder resolves to rank 0,
            // so this decision applies uniformly to all set sizes.
            const decision = this.archiveElectionDecision(cp, archive, electionPubkeys, me, electionBlock);
            const order = decision.order;
            // Same backup-only rule as v0: letting a leader drive on every wake
            // would over-anchor instead of accumulating rows to the interval or size trigger.
            if(failoverOnly && this.isRankZero(order)){
                this.archiveRankLockReason = 'rank_zero_on_failover_wake';
                return true;
            }
            if(!decision.unlocked){
                // Without this, a hub that never wins the election is
                // indistinguishable from a broken publisher.
                logger.info('StateAnchorPublisher: archive election (batch ' + batchSeq + ') at block ' + electionBlock +
                            ': rank ' + order.indexOf(me) + '/' + order.length + ' (leader ' +
                            order[0].substring(0, 12) + '..., ladder unlocks a rank every ' +
                            this.electionToleranceBlocks + ' blocks from content block ' +
                            String(decision.anchor && decision.anchor.block) + '), not publishing');
                this.archiveRankLockReason = 'rank_not_unlocked';
                return true;                                               // not unlocked on the failover ladder
            }
        }
        return false;
    },

    // The pending rows, or null when there are none or they repeat the last complete
    // publish. Fingerprinted here, before buildSizedArchive trims the set in place.
    async gatherUnpublishedArchiveRows(){
        const rows = await this.gatherArchiveRows();
        if(!rows) return null;
        rows.rowsFingerprint = this.archiveRowsFingerprint(rows);
        return this.archiveRepeatsLastPublish(rows.rowsFingerprint) ? null : rows;
    },

    // Digest of the gathered row set: each row's identity plus the fields whose change
    // makes it pending again (the same fields the back-fill stamps), so a mutated or
    // new row changes the digest while an unchanged re-gather reproduces it.
    archiveRowsFingerprint(rows){
        const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
        const pick = (list, fn) => (list || []).map(fn);
        const shape = {
            matches: pick(rows.matches, m => [m.match_id, m.status]),
            calls: pick(rows.calls, c => [c.call_id, c.phase, c.status]),
            rewards: pick(rows.rewards, r => [r.reward_type, r.round_number, r.validator_pubkey, r.round_qualifier]),
            bridges: pick(rows.bridges, r => [r.transfer_id, r.status]),
            policies: pick(rows.policies, r => [r.snapshot_id]),
            lists: listIdsOf(rows.lists).map(r => [r.snapshot_id]),
            checkpoints: pick(rows.checkpoints, r => [r.chain, r.network, r.checkpoint_seq]),
            prices: pick(rows.prices, r => [r.round_number, r.coin_pair, r.status, r.batch_block_time,
                                            sha(r.consensus_proof)]),
            tombstones: pick(rows.tombstones, r => [r.round_number, r.coin_pair])
        };
        return sha(JSON.stringify(shape, (_k, v) => typeof v === 'bigint' ? String(v) : v));
    },

    // A complete publish stamps its rows, so gathering the identical set again means
    // the stamps did not take and another round would pay DOGE to repeat an archive
    // already on chain (batches 151 to 156 on the rail, one spend per wake). Skip it
    // until a row is added or changes. The memory is per process: a restart allows
    // one repeat.
    archiveRepeatsLastPublish(fingerprint){
        if(!fingerprint || fingerprint !== this._lastPublishedArchiveFingerprint) return false;
        this._pendingMatches = 0;
        if(this._archiveRepeatLoggedFingerprint !== fingerprint){
            this._archiveRepeatLoggedFingerprint = fingerprint;
            logger.warn('StateAnchorPublisher: pending archive rows are the set batch ' +
                        this._lastPublishedArchiveBatchSeq + ' already published; not publishing ' +
                        'them again until a row is added or changes');
        }
        return true;
    },


    // The wrapper signing set takes its capability here and is judged at
    // cp.snapshot_block on the record network.
    archiveSigningCapability(cp){
        const network = resolveQuorumNetwork(cp, this.network);
        return archivePublishGate.isArchivePublishActive(Number(cp.snapshot_block), network)
            ? 'archive_publish'
            : 'oracle_publish';
    },

    // SIGNING/QUORUM set: resolved at the wrapper checkpoint's snapshot_block.
    // The block the published v1 declares on the wire is the block the indexer
    // (actions/anchor/quorum.js) + full-parse recovery verify the wrapper signatures against
    // (oracle_publish @ snapshot_block). Resolving it at the current election
    // block instead would let signers present only in the current set
    // contribute signatures the indexer later drops, pushing validSigs below
    // quorum, marking the v1 invalid on-chain while the rows get dequeued
    // anyway (see the on-chain-validity gate in publishArchive), permanently
    // losing settled cross-chain state. The election set above may differ
    // (liveness); the set that gates co-signature acceptance must not.
    // Resolve the SIGNING set as the full {pubkey, source, weight} snapshot via
    // resolveCapabilitySet (the SAME set the indexer quorum.js + full-parse
    // recovery verify the wrapper signatures against, oracle_publish @
    // snapshot_block, source-keyed). Bare pubkeys would lose the staking weight
    // the stake-weighted gate needs, so the publisher's local quorum decision
    // must use this set, not getActiveOraclePublishPubkeys.
    // Hands back the resolver's own promise, so the round awaits the read it awaited inline.
    archiveSigningSet(cp){
        return this.resolveCapabilitySet(this.archiveSigningCapability(cp), Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));
    },

    // An UNRESOLVED (empty) signing set is not a quorum of one: defer the round,
    // exactly as the two publisher-attestation rounds already do (runPublisherAttestationRound
    // / runArchiveAttestationRound both abstain on snapCount === 0). The election gate
    // above fails closed on an empty set, but it reads a DIFFERENT resolver at a
    // DIFFERENT height (getActiveOraclePublishPubkeys @ electionBlock vs
    // resolveCapabilitySet @ cp.snapshot_block), so passing it does not imply
    // snapCount > 0. Without this the `snapCount <= 1` self-sign path below treats 0
    // as single-node: the leader signs an archive whose declared signing set it is
    // not a member of, publishes a v1 that the indexer (quorum.js) and full-parse
    // recovery both refuse (their quorum verifiers need at least one qualified
    // signer), and dequeues the settled cross_chain rows anyway - a live-vs-recovered
    // ledger fork. Returning 'none' leaves every row pending, so a later flush
    // re-archives them under a fresh batch seq once the set resolves.
    archiveSigningSetUnresolved(signingSet, cp, batchSeq){
        let snapCount = signingSet.length;
        if(snapCount === 0){
            logger.warn('StateAnchorPublisher: unresolved oracle_publish set at snapshot_block ' +
                         Number(cp.snapshot_block) + ' (batch ' + batchSeq + '); deferring the archive ' +
                         'round rather than self-publishing an empty-set v1 (rows stay pending)');
            return true;
        }
        return false;
    },

    // The round record a leader holds while signatures arrive: the quorum rule for the
    // signing set, the leader's own seed signature, and the ids the back-fill stamps.
    openArchiveRound(o){
        let { cp, batchSeq, wire, canonical, signer, electionBlock, archive, rows, rewardRows, signingSet, myPubkey, mySig } = o;
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        // STAKE_WEIGHTED_QUORUM: weighted (source-deduped) at/above activation, else
        // legacy 2f+1 count; keyed on the BTC snapshot_block so the hub flips on the
        // same anchor as the indexer's verifyHeadQuorum (`swq.isStakeWeightedQuorumActive(snapshotBlock, NETWORK)`).
        let weighted       = swq.isStakeWeightedQuorumActive(Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));   // gate on the RECORD network to match the indexer
        let quorum         = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        // Seed the leader's own signature only if the leader is itself in the
        // signing set. A leader elected for liveness but absent from the
        // snapshot_block set must not inflate the local quorum with a signature
        // the indexer will drop on-chain.
        //
        // Membership binds the SINGLE-member set too, so no `snapCount <= 1` disjunct
        // short-circuits this test: a one-member set is not a degenerate self-sign,
        // because the one member may be validator A while the election (a DIFFERENT
        // resolver at a DIFFERENT height, see above) picked replacement publisher B.
        // The indexer's verifyHeadQuorum filters B's seeded signature out by snapshot membership and records
        // the v1 'invalid: insufficient valid signatures (0/1)', while full-parse recovery
        // throws on the same wrapper - and this hub would dequeue the settled rows behind
        // it. The two sibling attestation rounds prove membership before their own
        // singleton fast path (runPublisherAttestationRound /
        // runArchiveAttestationRound); this round holds the same guard.
        let signatures = new Map();
        if(signingPubkeys.includes(myPubkey)) signatures.set(myPubkey, mySig);

        // Full {pubkey, source, weight} set so checkArchiveQuorum can tally
        // distinct-source stake (weight carries the source's stake when weighted).
        // Preserve the truncation flag so the weighted archive quorum (checkArchiveQuorum
        // via meetsStakeThreshold) fails closed on an over-cap oracle_publish snapshot.
        let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
        if(signingSet.truncated === true) roundValidators.truncated = true;

        let round = {
            cp, batchSeq, crc: wire.crc, b64: wire.b64, chunks: wire.chunks, canonical, quorum, weighted, signer, electionBlock,
            count:      archive.count,
            rowsFingerprint: rows.rowsFingerprint,
            matchIds:   rows.matches.map(m => ({ match_id: m.match_id, status: m.status })),
            callIds:    rows.calls.map(c => ({ call_id: c.call_id, phase: c.phase, status: c.status })),
            rewardIds:  rewardRows.map(({row}) => ({ reward_type: String(row.reward_type), round_number: Number(row.round_number), validator_pubkey: String(row.validator_pubkey).toLowerCase(), round_qualifier: Number(row.round_qualifier || 0) })),
            bridgeIds:  rows.bridges.map(r => ({ transfer_id: String(r.transfer_id), status: String(r.status) })),
            policyIds:  rows.policies.map(r => ({ snapshot_id: String(r.snapshot_id) })),
            listIds:    listIdsOf(rows.lists),
            checkpointIds: rows.checkpoints.map(r => ({ chain: String(r.chain), network: String(r.network), checkpoint_seq: Number(r.checkpoint_seq) })),
            priceIds: rows.prices.map(r => ({ round_number: Number(r.round_number), coin_pair: String(r.coin_pair), status: String(r.status), batch_block_time: Number(r.batch_block_time), proof_sha: crypto.createHash('sha256').update(String(r.consensus_proof)).digest('hex') })),
            tombstoneIds: rows.tombstones.map(r => ({ round_number: Number(r.round_number), coin_pair: String(r.coin_pair) })),
            validators: roundValidators,
            signatures: signatures,
            done:       false,
            timer:      null
        };
        return round;
    },

    // ... but only when the self-signature actually satisfies quorum. snapCount is
    // exactly 1 here (0 deferred above), so quorum is 1 and this holds iff the seed
    // in openArchiveRound fired, i.e. iff this leader IS the sole member. A non-member leader holds
    // nothing, so publishing would broadcast a v1 with zero qualified signatures and
    // dequeue the settled rows behind an anchor no verifier can confirm. Defer
    // instead, exactly as the snapCount === 0 branch does: the rows stay pending and
    // a later flush re-archives them under a fresh batch seq, either once the signing
    // set resolves to include this hub or under a leader that is already a member.
    singleMemberCannotSelfSign(round, cp, batchSeq){
        if(round.signatures.size < round.quorum){
            logger.warn('StateAnchorPublisher: single-member oracle_publish set at snapshot_block ' +
                         Number(cp.snapshot_block) + ' (batch ' + batchSeq + ') does not contain this ' +
                         'publisher; deferring the archive round rather than self-publishing a v1 the ' +
                         'indexer records invalid (rows stay pending)');
            return true;
        }
        return false;
    },

    // A held publish never archived anything, so the pending counter must NOT be
    // cleared: the rows really are still pending and the next flush re-checks.
    async publishSingleMemberArchive(round){
        let result;
        this._archivePublishing = round;
        try {
            result = await this.publishArchive(round);
        } finally {
            this._archivePublishing = null;
        }
        if(result === 'intent_held') return 'intent_held';
        this._pendingMatches = 0;
        return 'published';
    },

    // Hold the round open until quorum or the round timeout.
    armArchiveRound(round, batchSeq){
        this._archiveRound = round;
        round.timer = setTimeout(() => {
            if(this._archiveRound === round && !round.done){
                logger.warn('StateAnchorPublisher: archive round (batch ' + batchSeq + ') timed out at ' +
                             round.signatures.size + '/' + round.quorum + ' sigs; retrying next flush');
                this._archiveRound = null;
            }
        }, this.roundTimeoutMs);
        if(round.timer.unref) round.timer.unref();
    },

    broadcastArchiveSignReq(cp, batchSeq, archive, wire, electionBlock, myPubkey, mySig){
        this.peerManager.broadcast(XANC_SIGN_REQ, {
            checkpoint: cp, batch_seq: batchSeq, match_count: archive.count,
            batch_crc32: wire.crc, total_chunks: wire.chunks.length, archive_b64: wire.b64,
            election_block: (Number.isFinite(electionBlock) ? electionBlock : 0),
            sig_pubkey: myPubkey, sig: mySig
        });
    }

};
