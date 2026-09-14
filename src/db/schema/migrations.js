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
 * XChain Hub - the migration STEP LIST, as a Database.prototype mixin.
 *
 * What runMigrations actually runs, in the order it runs it. The steps live here
 * and the entry point stays on the class in src/db/index.js, so a reader still
 * finds migrations where the style guide says they are and the sequence is one
 * list rather than a method long enough to hide a step.
 *
 * ORDER IS THE CONTRACT ACROSS ALL THREE. src/db/index.js awaits them in the
 * order below and each is a prefix of the old single pass, so a hub applies
 * exactly the statements it applied before, in the same sequence: a backfill
 * before the widen that needs it, a column before the key that names it.
 *
 * Each step is idempotent and swallows its own failure loudly (see the notes on
 * the helpers in schema/keys.js and schema/columns.js): this is one sequential
 * pass at boot, so a throw takes every later migration and the boot with it.
 *
 ********************************************************************/

module.exports = {

    // The oracle_submissions and validator_rewards keys, the archive-round
    // backfill the widened reward key needs, and the batch_seq index.
    async runRewardKeyMigrations(){
        await this.migrateUniqueKey(
            'oracle_submissions',
            'uq_submission',
            '(round_number, coin_pair, validator_pubkey)',
            ['round_number', 'coin_pair', 'validator_pubkey']
        );
        // The reward key carries round_qualifier: snapshot_block for the anchor_archive
        // leg, 0 for every other type, so non-archive keys are exactly what they were.
        // The archive leg keys on MATCH_BATCH_SEQ, which a wipe-and-replay rebase
        // reissues, so the four-column key collapsed two genuinely distinct archive
        // anchors into one row. Backfill BEFORE widening: a pre-column archive row left
        // at the DEFAULT 0 falls out of every qualified predicate and reads as absent.
        await this.migrateUniqueKey(
            'validator_rewards',
            'uq_reward',
            '(validator_pubkey, round_number, reward_type, round_qualifier)',
            ['validator_pubkey', 'round_number', 'reward_type', 'round_qualifier']
        );
        await this.backfillArchiveRoundQualifier();
        await this._widenUniqueKey(
            'validator_rewards',
            'uq_reward',
            'round_qualifier',
            '(validator_pubkey, round_number, reward_type, round_qualifier)'
        );
        // Plain (non-unique) indexes declared in a table's SQL source AFTER the
        // table first shipped. alterTableForDrift back-fills missing columns but
        // deliberately never touches indexes, so an index added to the source
        // later never reaches a table that already exists on a deployed node.
        // idx_batch_seq is the case in point: the batch_seq column was
        // drift-reconciled onto prod validator_rewards during the ANCHOR rollout,
        // but its index had to be added by hand on every box. This folds that
        // hand-step into the code-side self-heal.
        await this.migrateIndex('validator_rewards', 'idx_batch_seq', '(batch_seq)');
    },

    // The capability ENUM a new tier needs, the state_checkpoints re-key that
    // closes checkpoint split-brain, and the two UNIQUE keys widened in place.
    async runCapabilityAndCheckpointMigrations(){
        // The capability ENUM gains values as new capability tiers ship (e.g.
        // 'full_node' added for WI-2). alterTableForDrift only adds missing
        // columns and relaxes NULL; it never MODIFYs a column's type. So an
        // already-deployed validator_capabilities keeps the narrower ENUM and
        // rejects the new value (WARN_DATA_TRUNCATED) on the capability self-test
        // INSERT. Widen it in place to match CapabilityRegistry.KNOWN_CAPABILITIES.
        await this.migrateEnumColumn(
            'validator_capabilities',
            'capability',
            ['price', 'cross_chain', 'oracle_publish', 'attestation', 'full_node'],
            'NOT NULL'
        );
        // Checkpoint split-brain: tighten the state_checkpoints uniqueness from
        // (chain, network, block_index, checkpoint_seq) to (chain, network, checkpoint_seq)
        // so a same-seq race can never seat two divergent rows (and double-anchor DOGE).
        // migrateUniqueKey dedups any pre-existing (chain, network, checkpoint_seq)
        // collisions (keeping the lowest id) before adding the key; the audit the spec
        // asks for is exactly that dedup step. Then retire the now-redundant wider
        // indexes so fresh installs and migrated nodes carry the same index set.
        await this.migrateUniqueKey(
            'state_checkpoints',
            'uq_chain_seq',
            '(chain, network, checkpoint_seq)',
            ['chain', 'network', 'checkpoint_seq']
        );
        await this.migrateIndex('state_checkpoints', 'sc_chain_blk', '(chain, network, block_index)');
        await this.dropIndexIfExists('state_checkpoints', 'chain_block_seq');
        await this.dropIndexIfExists('state_checkpoints', 'checkpoint_seq');
        // Widen capability_snapshots.uq_cap_snap to add `source`. At/above
        // STAKE_WEIGHTED_QUORUM a signing key delegated by two staking sources yields
        // one row per (source, pubkey); the old 3-column key collapsed them on
        // INSERT IGNORE and silently dropped the second source, understating stake for
        // any mirror-reading verifier. alterTableForDrift only reconciles columns and
        // migrateUniqueKey no-ops once the index NAME exists, so neither widens an
        // existing key: this reconciles the column set in place. Monotonically safe (a
        // strict superset of an already-enforced UNIQUE key can only relax it, so no
        // pre-dedup is needed).
        await this._widenUniqueKey(
            'capability_snapshots',
            'uq_cap_snap',
            'source',
            '(snapshot_block, capability, signing_pubkey, source)'
        );
        // attestation_responses: one request can finalize under two leader slots and
        // yield two honestly signed rows that differ only in effective_time; the old
        // (network, request_id) key absorbed the second as a duplicate on some hubs and
        // kept it on others, so no window carrying such a request could reach batch
        // quorum. The stamp joins the key (see the table's SQL); same widen semantics.
        await this._widenUniqueKey(
            'attestation_responses',
            'uq_attest_response',
            'effective_time',
            '(network, request_id, effective_time)'
        );
    },

    // The column-level steps: the two DATETIME conversions, the two charset
    // widens, the price fence re-key, and the mirror admission columns.
    async runColumnAndFenceMigrations(){
        // #4315: governance_proposals.voting_start/voting_end shipped as TIMESTAMP, which
        // MariaDB bounds to the signed 32-bit epoch (2038-01-19 03:14:07 UTC). Both hold a
        // FUTURE instant (voting_end is NOW() + GOV_VOTING_PERIOD), so they run out of range
        // one voting period BEFORE every 'now'-recording audit column does. alterTableForDrift
        // never MODIFYs a type, so the DDL edit alone would fix only fresh installs.
        await this._migrateColumnType('governance_proposals', 'voting_start', 'datetime', 'DATETIME NOT NULL');
        await this._migrateColumnType('governance_proposals', 'voting_end', 'datetime', 'DATETIME NOT NULL');
        // attestation_responses.response_payload / meta hold PROVIDER bytes, and the on-chain
        // twins they stand in for (attests.response_payload, attests.meta on the indexer) are
        // utf8mb4. On the table's utf8mb3 tail a 4-byte character fails the mirror INSERT with
        // errno 1366 under STRICT_TRANS_TABLES, so a body the ATTEST v1 path would have carried
        // never reaches any indexer and the request it answers expires unresolved.
        // alterTableForDrift adds a missing column and never restates an existing one, so the
        // DDL edit in src/sql/attestation_responses.sql alone reaches only fresh installs.
        await this.migrateColumnCharset('attestation_responses', 'response_payload', 'utf8mb4',
            'MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
        await this.migrateColumnCharset('attestation_responses', 'meta', 'utf8mb4',
            'TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
        // re-key price_ingest_watermarks from (source_chain) to
        // (network, source_chain). alterTableForDrift adds the `network` column on an
        // already-deployed table but never touches keys, so without this step a migrated
        // hub carries the column and STILL collapses every network onto one row per chain:
        // the fence's upsert would key on source_chain and one network's retraction would
        // overwrite another's. That is the bug this item exists to remove, so the re-key is
        // the migration, not the column.
        await this.migratePriceFencePrimaryKey();
        // The mirror admission columns (spec §5.5, C28, C35). A JS helper and NOT a dated
        // .sql, because this repo HAS no dated-.sql runner: the two files under
        // xchain-hub/migrations/ are applied by hand, so a migration copied from the
        // indexer's style would sit there and never run on a single deployed hub.
        await this.migrateAdmissionColumns();
    }

};
