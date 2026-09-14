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

const canonicalForms = require('../canonical_forms.js');
const zlib = require('zlib');
const { bftQuorumOrSingle } = require('../../../lib/bft_quorum.js');
const { resolveQuorumNetwork } = require('../../quorum_network.js');
const swq = require('../../../stake_weighted_quorum.js');
const { XANC_SIGN_REQ } = require('../constants.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();
const { ANCHOR_FLAG_DAY_REWARD_TYPES, ARCHIVE_FLAG_DAY_REWARD_TYPE } = require('../constants.js');

module.exports = {

    // Archive round (v1/v2).
    // Leader = hash-order rank 0 over the oracle_publish set, with the same
    // failover ladder as the checkpoint leg: the election key is anchored on the archive
    // CONTENT (wrapper checkpoint + batch seq; deterministic + identical on
    // every hub, and stable while the batch is stalled), and each further rank
    // unlocks after another ANCHOR_ELECTION_TOLERANCE_BLOCKS past the wrapper
    // checkpoint's snapshot_block. Without the ladder a signer-less elected
    // leader stalled archiving (live on a 3-hub test cluster: only 1-of-3 elections could
    // publish; on a static regtest tip the same leader won forever). Returns
    // the flush summary's archive status.
    async _startArchiveRound(signer, electionBlock, failoverOnly){
        // One at a time across BOTH phases: a round collecting signatures, and a round
        // whose publish is already in flight (see _archivePublishing).
        if(this._archiveRound || this._archivePublishing) return 'round_pending';

        // Fail closed on an unresolved BTC tip. flush() passes whatever
        // hub._resolveBtcLatestBlock() returned, and that is null whenever the pushed tip
        // is stale, the indexer lags past MAX_INDEXER_LAG_BLOCKS, or the RPC fails. A null
        // block makes _getActiveOraclePublishPubkeys take its block-UNPINNED branch, whose
        // own contract scopes it to the coarse BUNDLE_DONE / FINALIZED sender pre-filter: it
        // answers from the per-hub, gossip-driven capabilityRegistry, so two hubs would
        // elect over different member lists on a path that spends real DOGE. The follower
        // side already refuses this round (handleSignReq bounds election_block to its own
        // tip), so the leader-side defer costs a stalled multi-hub round it was never going
        // to complete, and closes the single-member case that self-quorums today. Same
        // fail-closed idiom as the empty-set defer below; rows stay pending for the next
        // flush, exactly like the balance and spend-guard gates in flush().
        if(!Number.isFinite(electionBlock)){
            logger.warn('StateAnchorPublisher: BTC tip unresolved (' + electionBlock +
                         '); deferring archive round rather than electing over the ' +
                         'block-unpinned live registry (fail closed)');
            return 'none';
        }

        // Leader ELECTION runs over the set at the current BTC block (liveness: a
        // freshly-joined validator can take over a stalled publish even when the
        // wrapper checkpoint's snapshot_block is hours old). This set decides only
        // WHO drives the round + pays the DOGE; it does NOT gate which signatures
        // count on-chain (that is the snapshot_block signing set resolved below).
        let electionPubkeys = await this._getActiveOraclePublishPubkeys(electionBlock);
        let me = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
        // Fail closed: an empty/unresolved oracle_publish set must defer the
        // archive round, not let every hub drive it independently (each would
        // broadcast a competing v1 + burn DOGE for the same batch slot).
        if(electionPubkeys.length === 0){
            logger.info('StateAnchorPublisher: archive election at block ' + electionBlock +
                        ': empty oracle_publish set, deferring round (fail closed)');
            return 'none';
        }
        if(!me) return 'none';
        if(!electionPubkeys.includes(me)){
            logger.info('StateAnchorPublisher: archive election at block ' + electionBlock +
                        ': own pubkey not in the oracle_publish election set (' + electionPubkeys.length + ' eligible)');
            return 'none';                                               // not an eligible publisher right now
        }

        let matches = await this.db.findCrossChainMatchesByBatchSeq(this.maxBatch);
        let calls = await this.db.findCrossChainCallsByBatchSeq(this.maxBatch);
        // Archive transport for the anchor_% reward rails. Read this before touching
        // recovery dedup: the "indexer can never re-derive these" invariant is NOT
        // uniformly true any more, and the difference matters because these rows land
        // on the COLLECT-spendable ledger.
        //   - anchor_<CHAIN> BELOW the anchor-reward flag-day, and anchor_archive BELOW
        //     the archive-reward flag-day: genuinely hub-pushed. The chain
        //     carries no parse for them, so the archive is their only recovery
        //     transport. The original invariant holds here.
        //   - anchor_<CHAIN> AT/ABOVE the anchor-reward flag-day, and anchor_archive
        //     AT/ABOVE the archive-reward flag-day: the indexer DOES re-derive these
        //     on-chain from the v0/v1 XANCPUB publisher attestation (anchor.js
        //     createValidatorReward / reconcileAnchorRewardWinner), crediting the same
        //     frozen ANCHOR_REWARD_AMOUNT / ARCHIVE_REWARD_AMOUNT. The hub still records the row locally
        //     (RewardTracker isDerived path) and this selector still archives it, so the
        //     archive redundantly transports a row the chain reproduces.
        // That redundancy is safe ONLY because restore and derive both key on the UNIQUE
        // (validator_pubkey, round_number, reward_type), so the two paths dedup and the
        // amounts agree. Weaken that dedup and the archived anchor_<CHAIN> row becomes a
        // genuine SECOND credit. Do not treat "archived" as proof of "not re-derivable".
        // (oracle_round/attest_fee rows are indexer-derived and NEVER archived.)
        // Rows are immutable, so batch_seq IS NULL is the only pending test;
        // pre-upgrade rows without a deterministic block_index stay local.
        // ELIGIBILITY BEFORE LIMIT. Derived rows keep batch_seq NULL forever by design, so
        // they stay eligible for this SELECT on every round and their number only grows
        // (each archive publish records another anchor_archive). Filtered after the LIMIT,
        // a maxBatch-sized block of them occupied the page permanently, and an older
        // below-flag-day reward sorted behind them was never examined again: those rows
        // have no chain parse, so the archive is their ONLY recovery transport, and
        // nothing else clears the blockers.
        let flagDays = this.derivedRewardFlagDays();
        let rewards = flagDays
            ? await this.db.findArchivableAnchorRewardsBelowFlagDays(ANCHOR_FLAG_DAY_REWARD_TYPES, flagDays.anchorFlagDay,
                                                                     ARCHIVE_FLAG_DAY_REWARD_TYPE, flagDays.archiveFlagDay,
                                                                     this.maxBatch)
            : await this.db.findArchivableAnchorRewards(this.maxBatch);
        // RETAINED, and now redundant on purpose: the SQL narrows the page, this
        // guarantees the invariant for an unscoped hub (empty clause) and for any row the
        // SQL form judged differently. Archiving a derived row was self-feeding: each
        // archive publish records an anchor_archive reward, which the next flush archived
        // alone, one reward-only ANCHOR per restart.
        rewards = (rewards || []).filter(r => !this._isChainDerivedReward(r));
        if((!matches || matches.length === 0) && (!calls || calls.length === 0) && (!rewards || rewards.length === 0)){ this._pendingMatches = 0; return 'none'; }
        matches = matches || [];
        calls   = calls   || [];
        rewards = rewards || [];

        // The checkpoint wrapper: latest checkpoint (prefer BTC; its height also
        // selects validator sets). Without any checkpoint there is nothing to bind
        // the archive's signatures to, so defer until the checkpoint engine has run.
        // Scoped to this.network when one is configured, so a prior-network
        // leftover row can never become the archive wrapper (same hazard the
        // latch loader defends against); unconfigured-network hubs keep the
        // legacy unscoped selection.
        // Ordered on the CONSENSUS key (checkpoint_seq, then snapshot_block, then
        // block_index), never on `id`. `id` is this hub's AUTO_INCREMENT insertion
        // cursor: every hub writes its own state_checkpoints rows (acceptFinalized on
        // both the leader and follower paths), so id ordering is local insertion order,
        // which MATCH_KEYS already calls "the hub-assigned mirror cursor" and
        // verifyArchiveAgainstLocal deletes before byte-comparing. The selected row
        // feeds _archiveElectionKey, which advertises itself as "deterministic +
        // identical on every hub"; keying that on a locally-ordered pick let two hubs
        // elect over different keys for the same batch_seq (divergent rank orders, a
        // stalled or double-published archive round). checkpoint_seq is quorum-agreed
        // and derived from snapshot_block, so it is the same value on every hub.
        let cps = this.network
            ? await this.db.getStateCheckpointByNetwork(this.network)
            : await this.db.getLatestStateCheckpoint();
        if(!cps || cps.length === 0){
            logger.info('StateAnchorPublisher: no state checkpoint yet; archive deferred');
            return 'none';
        }
        let cp = this.cpFromRow(cps[0]);

        let network  = String(cps[0].network);

        // Durable at-most-once for the ARCHIVE spend, the twin of the
        // anchor_published_checkpoints gate in _publishPendingCheckpoints. A crash
        // between an accepted v1/v2 send and backfillBatch leaves every source row
        // pending. The archive path does read mined state, through getarchiveanchor
        // rather than getanchoraction, but only at the send: _publishArchive passes
        // findExistingArchiveAnchor to broadcastWithRetry, and that lookup answers from
        // parsed on-chain actions, so a send still sitting in the DOGE mempool reads as
        // absent. Without this marker the next flush therefore rebuilds the whole batch
        // under a fresh seq and re-pays for the head plus every chunk. Checked here,
        // which is BEFORE any such lookup, before the batch seq is drawn and
        // before the co-signing round burns a quorum, so a held round costs nothing.
        // Bounded by anchorIntentTtlMs: an unbounded marker for a send that never
        // relayed would stall archiving forever.
        let liveIntent = await this.getLiveArchiveIntent(network);
        if(this.anchorIntentHolds(liveIntent)){
            logger.warn('StateAnchorPublisher: archive round for ' + network + ' held: batch ' +
                         liveIntent.batch_seq + ' recorded a broadcast intent at ' + String(liveIntent.intent_at) +
                         (liveIntent.txid ? ' (v1 txid ' + liveIntent.txid + ')' : '') +
                         ' and never finished its bookkeeping; not rebuilding a second archive until that ' +
                         'intent ages past ' + this.anchorIntentTtlMs + 'ms (rows stay pending)');
            return 'intent_held';
        }

        let batchSeq = await this._getNextBatchSeq();

        {
            // Unconditional (all set sizes): the membership check above already
            // pins the size-1 identity, and a single-member ladder resolves to
            // rank 0 (always unlocked), so this is uniform, not a behavior change.
            let order = canonicalForms.hashOrder(this._archiveElectionKey(cp), electionPubkeys);
            let since = Number.isFinite(electionBlock) ? electionBlock - Number(cp.snapshot_block) : null;
            // Same backup-only rule as the v0 path. A leader driving its
            // own batch on the wake cadence would archive whatever few rows are
            // pending every 15 minutes instead of accumulating them to the interval
            // or the size trigger, which is the over-anchoring this mode exists to
            // avoid. Backups are exactly who the wake is for.
            if(failoverOnly && this._isRankZero(order)) return 'none';
            if(!this._rankUnlocked(order, me, since)){
                // Operator visibility: a hub that never wins the archive
                // election (e.g. signer-less peers keep ranking first) is
                // indistinguishable from a broken publisher without this.
                logger.info('StateAnchorPublisher: archive election (batch ' + batchSeq + ') at block ' + electionBlock +
                            ': rank ' + order.indexOf(me) + '/' + order.length + ' (leader ' +
                            order[0].substring(0, 12) + '..., ladder unlocks a rank every ' +
                            this.electionToleranceBlocks + ' blocks), not publishing');
                return 'none';                                               // not unlocked on the failover ladder
            }
        }
        // Pin each reward's earn-time source into the archive (resolved via the
        // BTC indexer, block-scoped; every hub gets the same answer, and
        // recovery restores rewards BEFORE the BTC reindex so it cannot resolve
        // them itself). An unresolvable source leaves the row for a later batch
        // rather than archiving a hole.
        let rewardRows = [];
        for(let r of rewards){
            let source = this.hub.rewardTracker
                ? await this.hub.rewardTracker.resolveSourceByPubkey(String(r.validator_pubkey), Number(r.block_index))
                : null;
            if(!source){
                logger.warn('StateAnchorPublisher: reward ' + r.reward_type + '/#' + r.round_number +
                             ' source unresolved for ' + String(r.validator_pubkey).substring(0, 12) + '... deferred to a later batch');
                continue;
            }
            rewardRows.push({ row: r, source: source });
        }

        // After source resolution, a round with no matches, no calls, and no
        // RESOLVABLE rewards has nothing to archive. The raw empty-check above
        // counts unresolvable rewards as pending, so without this an unstaked
        // single-validator hub (its own anchor-reward pubkey resolves to no
        // stake source) re-publishes an empty 0/0/0 archive to DOGE every cycle
        // (a live prod fee-burn finding). The unresolvable rows stay pending
        // (batch_seq NULL) for a later batch that can resolve them; recording is
        // deliberately unconditional (every hub holds identical rows for the
        // federation re-derivation invariant), so we suppress the empty PUBLISH,
        // not the record. Real federations are unaffected: a staked publisher's
        // rewards resolve, so rewardRows is non-empty whenever rewards are.
        if(matches.length === 0 && calls.length === 0 && rewardRows.length === 0){
            this._pendingMatches = 0;
            return 'none';
        }

        let archive  = await this.buildArchive(network, batchSeq, matches, cp.snapshot_block, calls, rewardRows);
        let json     = archive.json;
        let crc      = this.crc32Hex(json);
        let b64      = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
        let chunks   = this.splitChunks(b64);

        let canonical = this.archiveCanonical(cp, batchSeq, archive.count, crc, chunks.length);
        if(!this.identity) throw new Error('no validator identity: cannot sign archives');
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let mySig    = this.identity.sign(canonical);

        // SIGNING/QUORUM set: resolved at the wrapper checkpoint's snapshot_block.
        // The block the published v1 declares on the wire is the block the indexer
        // (anchor.js) + full-parse recovery verify the wrapper signatures against
        // (oracle_publish @ snapshot_block). Resolving it at the current election
        // block instead would let signers present only in the current set
        // contribute signatures the indexer later drops, pushing validSigs below
        // quorum, marking the v1 invalid on-chain while the rows get dequeued
        // anyway (see the on-chain-validity gate in _publishArchive), permanently
        // losing settled cross-chain state. The election set above may differ
        // (liveness); the set that gates co-signature acceptance must not.
        // Resolve the SIGNING set as the full {pubkey, source, weight} snapshot via
        // _resolveCapabilitySet (the SAME set the indexer anchor.js + full-parse
        // recovery verify the wrapper signatures against, oracle_publish @
        // snapshot_block, source-keyed). Bare pubkeys would lose the staking weight
        // the stake-weighted gate needs, so the publisher's local quorum decision
        // must use this set, not _getActiveOraclePublishPubkeys.
        let signingSet     = await this._resolveCapabilitySet('oracle_publish', Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        // An UNRESOLVED (empty) signing set is not a quorum of one: defer the round,
        // exactly as the two publisher-attestation rounds already do (runPublisherAttestationRound
        // / runArchiveAttestationRound both abstain on snapCount === 0). The election gate
        // above fails closed on an empty set, but it reads a DIFFERENT resolver at a
        // DIFFERENT height (_getActiveOraclePublishPubkeys @ electionBlock vs
        // _resolveCapabilitySet @ cp.snapshot_block), so passing it does not imply
        // snapCount > 0. Without this the `snapCount <= 1` self-sign path below treats 0
        // as single-node: the leader signs an archive whose declared signing set it is
        // not a member of, publishes a v1 that the indexer (anchor.js) and full-parse
        // recovery both refuse (their quorum verifiers need at least one qualified
        // signer), and dequeues the settled cross_chain rows anyway - a live-vs-recovered
        // ledger fork. Returning 'none' leaves every row pending, so a later flush
        // re-archives them under a fresh batch seq once the set resolves.
        if(snapCount === 0){
            logger.warn('StateAnchorPublisher: unresolved oracle_publish set at snapshot_block ' +
                         Number(cp.snapshot_block) + ' (batch ' + batchSeq + '); deferring the archive ' +
                         'round rather than self-publishing an empty-set v1 (rows stay pending)');
            return 'none';
        }
        // STAKE_WEIGHTED_QUORUM: weighted (source-deduped) at/above activation, else
        // legacy 2f+1 count; keyed on the BTC snapshot_block so the hub flips on the
        // same anchor as anchor.js (`swq.isStakeWeightedQuorumActive(snapshotBlock, NETWORK)`).
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
        // anchor.js filters B's seeded signature out by snapshot membership and records
        // the v1 'invalid: insufficient valid signatures (0/1)', while full-parse recovery
        // throws on the same wrapper - and this hub would dequeue the settled rows behind
        // it. The two sibling attestation rounds prove membership before their own
        // singleton fast path (runPublisherAttestationRound /
        // runArchiveAttestationRound); this round holds the same guard.
        let signatures = new Map();
        if(signingPubkeys.includes(myPubkey)) signatures.set(myPubkey, mySig);

        // Full {pubkey, source, weight} set so _checkArchiveQuorum can tally
        // distinct-source stake (weight carries the source's stake when weighted).
        // Preserve the truncation flag so the weighted archive quorum (_checkArchiveQuorum
        // via meetsStakeThreshold) fails closed on an over-cap oracle_publish snapshot.
        let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
        if(signingSet.truncated === true) roundValidators.truncated = true;

        let round = {
            cp, batchSeq, crc, b64, chunks, canonical, quorum, weighted, signer, electionBlock,
            count:      archive.count,
            matchIds:   matches.map(m => ({ match_id: m.match_id, status: m.status })),
            callIds:    calls.map(c => ({ call_id: c.call_id, phase: c.phase, status: c.status })),
            rewardIds:  rewardRows.map(({row}) => ({ reward_type: String(row.reward_type), round_number: Number(row.round_number), validator_pubkey: String(row.validator_pubkey).toLowerCase(), round_qualifier: Number(row.round_qualifier || 0) })),
            validators: roundValidators,
            signatures: signatures,
            done:       false,
            timer:      null
        };

        if(snapCount <= 1){                                                   // single-node: self-sign suffices
            // ... but only when the self-signature actually satisfies quorum. snapCount is
            // exactly 1 here (0 deferred above), so quorum is 1 and this holds iff the seed
            // above fired, i.e. iff this leader IS the sole member. A non-member leader holds
            // nothing, so publishing would broadcast a v1 with zero qualified signatures and
            // dequeue the settled rows behind an anchor no verifier can confirm. Defer
            // instead, exactly as the snapCount === 0 branch does: the rows stay pending and
            // a later flush re-archives them under a fresh batch seq, either once the signing
            // set resolves to include this hub or under a leader that is already a member.
            if(signatures.size < quorum){
                logger.warn('StateAnchorPublisher: single-member oracle_publish set at snapshot_block ' +
                             Number(cp.snapshot_block) + ' (batch ' + batchSeq + ') does not contain this ' +
                             'publisher; deferring the archive round rather than self-publishing a v1 the ' +
                             'indexer records invalid (rows stay pending)');
                return 'none';
            }
            // A held publish never archived anything, so the pending counter must NOT be
            // cleared: the rows really are still pending and the next flush re-checks.
            let result;
            this._archivePublishing = round;
            try {
                result = await this._publishArchive(round);
            } finally {
                this._archivePublishing = null;
            }
            if(result === 'intent_held') return 'intent_held';
            this._pendingMatches = 0;
            return 'published';
        }

        this._archiveRound = round;
        round.timer = setTimeout(() => {
            if(this._archiveRound === round && !round.done){
                logger.warn('StateAnchorPublisher: archive round (batch ' + batchSeq + ') timed out at ' +
                             round.signatures.size + '/' + quorum + ' sigs; retrying next flush');
                this._archiveRound = null;
            }
        }, this.roundTimeoutMs);
        if(round.timer.unref) round.timer.unref();

        this.peerManager.broadcast(XANC_SIGN_REQ, {
            checkpoint: cp, batch_seq: batchSeq, match_count: archive.count,
            batch_crc32: crc, total_chunks: chunks.length, archive_b64: b64,
            election_block: (Number.isFinite(electionBlock) ? electionBlock : 0),
            sig_pubkey: myPubkey, sig: mySig
        });
        await this._checkArchiveQuorum();
        return 'round_started';
    }

};
