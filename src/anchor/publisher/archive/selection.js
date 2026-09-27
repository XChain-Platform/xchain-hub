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
 * ANCHOR publisher - archive round row selection
 *
 * What a leader gathers before it can build an archive: the pending rows, the
 * wrapper checkpoint, the intent gate, each reward's earn-time source, and the
 * compressed body the round signs over.
 *
 ********************************************************************/

'use strict';

const zlib = require('zlib');
const { ANCHOR_FLAG_DAY_REWARD_TYPES, ARCHIVE_FLAG_DAY_REWARD_TYPE,
        ARCHIVE_MAX_POLICY_ROWS, ARCHIVE_MAX_PRICE_ROUNDS, ARCHIVE_MAX_JSON_BYTES } = require('../constants.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

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
    // The page of archivable reward rows; hands back the query's own promise so the
    // round awaits exactly the read it awaited when this sat inline.
    pendingArchiveRewards(){
        let flagDays = this.derivedRewardFlagDays();
        return flagDays
            ? this.db.findArchivableAnchorRewardsBelowFlagDays(ANCHOR_FLAG_DAY_REWARD_TYPES, flagDays.anchorFlagDay,
                                                                     ARCHIVE_FLAG_DAY_REWARD_TYPE, flagDays.archiveFlagDay,
                                                                     this.maxBatch)
            : this.db.findArchivableAnchorRewards(this.maxBatch);
    },

    // RETAINED, and now redundant on purpose: the SQL narrows the page, this
    // guarantees the invariant for an unscoped hub (empty clause) and for any row the
    // SQL form judged differently. Archiving a derived row was self-feeding: each
    // archive publish records an anchor_archive reward, which the next flush archived
    // alone, one reward-only ANCHOR per restart.
    dropChainDerivedRewards(rewards){
        return (rewards || []).filter(r => !this.isChainDerivedReward(r));
    },

    // Every pending archive stream, with sentinel reads for the two protocol caps.
    async gatherArchiveRows(){
        if(!this.db.findPriceSnapshotRoundsByBatchSeq || !this.db.findPriceTombstonesByBatchSeq){
            let [matches, calls, rewards] = await Promise.all([
                this.db.findCrossChainMatchesByBatchSeq(this.maxBatch),
                this.db.findCrossChainCallsByBatchSeq(this.maxBatch),
                this.pendingArchiveRewards()
            ]);
            return this.archiveRows(matches, calls, this.dropChainDerivedRewards(rewards));
        }
        let [matches, calls, rewards, bridges, policies, checkpoints, priceRounds, tombstones] = await Promise.all([
            this.db.findCrossChainMatchesByBatchSeq(this.maxBatch),
            this.db.findCrossChainCallsByBatchSeq(this.maxBatch),
            this.pendingArchiveRewards(),
            this.db.findBridgeTransfersByBatchSeq(this.maxBatch),
            this.db.findPolicySnapshotsByBatchSeq(ARCHIVE_MAX_POLICY_ROWS + 1),
            this.db.findStateCheckpointsByBatchSeq(this.maxBatch),
            this.db.findPriceSnapshotRoundsByBatchSeq(ARCHIVE_MAX_PRICE_ROUNDS + 1),
            this.db.findPriceTombstonesByBatchSeq(this.maxBatch)
        ]);
        rewards = this.dropChainDerivedRewards(rewards);
        let capped = policies.length > ARCHIVE_MAX_POLICY_ROWS || priceRounds.length > ARCHIVE_MAX_PRICE_ROUNDS;
        policies = policies.slice(0, ARCHIVE_MAX_POLICY_ROWS);
        priceRounds = priceRounds.slice(0, ARCHIVE_MAX_PRICE_ROUNDS).map(r => Number(r.round_number));
        let prices = await this.db.findPriceSnapshotsForArchiveRounds(priceRounds);
        return this.archiveRows(matches, calls, rewards, {
            bridges, policies, checkpoints, prices, tombstones, cappedOrTrimmed: capped
        });
    },

    // All row sets normalized to arrays, or null when no stream has archive cargo.
    archiveRows(matches, calls, rewards, quorumRows){
        quorumRows = quorumRows || {};
        let rows = {
            matches: matches || [], calls: calls || [], rewards: rewards || [],
            bridges: this.sortedArchiveRows(quorumRows.bridges, 'transfer_id'),
            policies: this.sortedArchiveRows(quorumRows.policies, 'snapshot_id'),
            checkpoints: this.sortedStateCheckpoints(quorumRows.checkpoints),
            prices: this.sortedPriceSnapshots(quorumRows.prices),
            tombstones: this.sortedPriceTombstones(quorumRows.tombstones),
            cappedOrTrimmed: quorumRows.cappedOrTrimmed === true
        };
        if(this.archiveRowCount(rows) === 0){ this._pendingMatches = 0; return null; }
        return rows;
    },

    archiveRowCount(rows){
        return ['matches', 'calls', 'rewards', 'bridges', 'policies', 'checkpoints', 'prices', 'tombstones']
            .reduce((count, key) => count + ((rows[key] || []).length), 0);
    },

    // Build repeatedly because removing a quorum row can also remove its capability set.
    async buildSizedArchive(network, batchSeq, rows, wrapperSnapshotBlock, rewardRows){
        let archive = await this.buildArchive(network, batchSeq, rows.matches, wrapperSnapshotBlock,
            rows.calls, rewardRows, rows);
        while(Buffer.byteLength(archive.json, 'utf8') > ARCHIVE_MAX_JSON_BYTES){
            if(!this.trimTrailingArchiveRows(rows))
                throw new Error('archive JSON exceeds ' + ARCHIVE_MAX_JSON_BYTES + ' bytes after eligible rows were trimmed');
            rows.cappedOrTrimmed = true;
            archive = await this.buildArchive(network, batchSeq, rows.matches, wrapperSnapshotBlock,
                rows.calls, rewardRows, rows);
        }
        return archive;
    },

    trimTrailingArchiveRows(rows){
        if(rows.prices.length){
            let trailingRound = String(rows.prices[rows.prices.length - 1].round_number);
            rows.prices = rows.prices.filter(row => String(row.round_number) !== trailingRound);
            return true;
        }
        for(let key of ['policies', 'checkpoints', 'bridges']){
            if(rows[key].length){ rows[key].pop(); return true; }
        }
        return false;
    },

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
    // feeds archiveElectionKey, which advertises itself as "deterministic +
    // identical on every hub"; keying that on a locally-ordered pick let two hubs
    // elect over different keys for the same batch_seq (divergent rank orders, a
    // stalled or double-published archive round). checkpoint_seq is quorum-agreed
    // and derived from snapshot_block, so it is the same value on every hub.
    latestArchiveWrapperRows(){
        return this.network
            ? this.db.getStateCheckpointByNetwork(this.network)
            : this.db.getLatestStateCheckpoint();
    },

    // Durable at-most-once for the ARCHIVE spend, the twin of the
    // anchor_published_checkpoints gate in publishPendingCheckpoints. A crash
    // between an accepted v1/v2 send and backfillBatch leaves every source row
    // pending. The archive path does read mined state, through getarchiveanchor
    // rather than getanchoraction, but only at the send: publishArchive passes
    // findExistingArchiveAnchor to broadcastWithRetry, and that lookup answers from
    // parsed on-chain actions, so a send still sitting in the DOGE mempool reads as
    // absent. Without this marker the next flush therefore rebuilds the whole batch
    // under a fresh seq and re-pays for the head plus every chunk. Checked here,
    // which is BEFORE any such lookup, before the batch seq is drawn and
    // before the co-signing round burns a quorum, so a held round costs nothing.
    // Bounded by anchorIntentTtlMs: an unbounded marker for a send that never
    // relayed would stall archiving forever.
    // True when a live intent holds this round (the warning names the batch it belongs to).
    archiveRoundIntentHeld(liveIntent, network){
        if(this.anchorIntentHolds(liveIntent)){
            logger.warn('StateAnchorPublisher: archive round for ' + network + ' held: batch ' +
                         liveIntent.batch_seq + ' recorded a broadcast intent at ' + String(liveIntent.intent_at) +
                         (liveIntent.txid ? ' (v1 txid ' + liveIntent.txid + ')' : '') +
                         ' and never finished its bookkeeping; not rebuilding a second archive until that ' +
                         'intent ages past ' + this.anchorIntentTtlMs + 'ms (rows stay pending)');
            return true;
        }
        return false;
    },

    // Pin each reward's earn-time source into the archive (resolved via the
    // BTC indexer, block-scoped; every hub gets the same answer, and
    // recovery restores rewards BEFORE the BTC reindex so it cannot resolve
    // them itself). An unresolvable source leaves the row for a later batch
    // rather than archiving a hole.
    async resolveArchiveRewardSources(rewards){
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
        return rewardRows;
    },

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
    archiveEmptyAfterResolution(rows, rewardRows){
        let resolvedRows = Object.assign({}, rows, { rewards: rewardRows || [] });
        if(this.archiveRowCount(resolvedRows) === 0){
            this._pendingMatches = 0;
            return true;
        }
        return false;
    },

    // The archive body as it travels: its crc32, the compressed base64url text, and the chunks.
    archiveWire(json){
        let crc      = this.crc32Hex(json);
        let b64      = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
        let chunks   = this.splitChunks(b64);
        return { json, crc, b64, chunks };
    }

};
