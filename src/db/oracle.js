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
 * XChain Hub - query methods for the oracle price, submission and published-round tables.
 *
 * Owns src/sql/oracle_prices.sql, src/sql/oracle_submissions.sql, src/sql/oracle_published_rounds.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {
    // Deletes from oracle_published_rounds.
    // Moved here from src/oracle/publisher.js:2878.
    async deleteOraclePublishedRound(cutoff) {
        return this.doQuery('DELETE FROM oracle_published_rounds WHERE round < ? AND sent_at IS NOT NULL', [cutoff]);
    },

    // Deletes from oracle_submissions.
    // Moved here from src/oracle/round.js:1199.
    async deleteOracleSubmission(cutoff) {
        return this.doQuery('DELETE FROM oracle_submissions WHERE round_number < ?', [cutoff]);
    },

    // Reads rows from oracle_published_rounds.
    // Moved here from src/oracle/publisher.js:2798.
    async findAllOraclePublishedRounds() {
        return this.doQuery('SELECT round, txid, sent_at FROM oracle_published_rounds');
    },

    // Reads rows from oracle_published_rounds.
    // Moved here from src/oracle/publisher.js:2746.
    async findOraclePublishedRoundsByRound(round) {
        return this.doQuery('SELECT round, txid, sent_at FROM oracle_published_rounds WHERE round = ?', [round]);
    },

    // Reads one row from oracle_prices.
    // Moved here from src/oracle/price_aggregator.js:1434.
    async getOraclePrice(source_address, source_chain, actionIndex) {
        return this.doQuery('SELECT id, push_generation FROM oracle_prices WHERE source_address = ? AND source_chain = ? AND action_index = ? LIMIT 1', [source_address, source_chain, actionIndex]);
    },

    // Reads one row from oracle_prices.
    // Moved here from src/peers/hub_db_broadcaster.js:636.
    async getOraclePricesMaxId() {
        return this.doQuery('SELECT MAX(id) AS max_id FROM oracle_prices');
    },

    // Inserts or updates a row in oracle_published_rounds.
    // Moved here from src/oracle/publisher.js:2758.
    async setOraclePublishedRound(round) {
        return this.doQuery('INSERT INTO oracle_published_rounds (round) VALUES (?) ON DUPLICATE KEY UPDATE round = round', [round]);
    },

    // Updates oracle_published_rounds.
    // Moved here from src/oracle/publisher.js:2772.
    async updateOraclePublishedRound(txid, round) {
        return this.doQuery('UPDATE oracle_published_rounds SET txid = ?, sent_at = NOW() WHERE round = ?', [txid, round]);
    },

    // Inserts a row into oracle_submissions.
    // INSERT IGNORE relies on the UNIQUE KEY (round, coin_pair, validator_pubkey)
    // so concurrent writes across hubs collapse silently instead of raising
    // ER_DUP_ENTRY (which db.doQuery would log before our catch could filter it).
    // Moved here from src/oracle/round.js:1137.
    async createOracleSubmission(roundNumber, coinPair, validatorPubkey, price, sources) {
        return this.doQuery(`INSERT IGNORE INTO oracle_submissions (round_number, coin_pair, validator_pubkey, price, sources)
                         VALUES (?, ?, ?, ?, ?)`, [roundNumber, coinPair, validatorPubkey, price, sources]);
    },

    // Reads rows from oracle_prices: the forward page-walk the indexer bootstrap
    // mirrors byte-for-byte (see src/oracle/prices_snapshot_query.js for why it must
    // never change). since and limit arrive clamped.
    // Moved here from src/oracle/prices_snapshot_query.js:86.
    async findOraclePricesAfterId(since, limit) {
        return this.doQuery('SELECT * FROM oracle_prices WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    // Reads rows from oracle_prices: each feed's row with the greatest effective_at
    // at or before now, for the dashboard's current-per-feed view. now and limit
    // arrive clamped.
    // Feed identity is (source_address, coin, tick, fiat): the table key
    // and what dispenser settlement filters on (indexer getOraclePrice).
    // PRICE v1 is permissionless, so two operators publishing the same
    // (coin,tick,fiat) is normal; grouping without source_address would
    // return only the freshest operator's row and hide an abandoned
    // operator's stale feed from the dashboard (no feed-stale alert while
    // dispensers pinned to that ORACLE_ADDRESS settle against dead data).
    // Join each feed's MAX(effective_at) back to the full row. Ties at the
    // same effective_at (two txs from one operator) return >1 row for that
    // feed; the client re-dedups per feed key, so this is harmless and
    // still bounded to ~= feed count. ORDER BY id keeps output stable.
    // Moved here from src/oracle/prices_snapshot_query.js:74.
    async findLatestOraclePricesPerFeed(now, limit) {
        return this.doQuery(
            'SELECT op.* FROM oracle_prices op ' +
            'JOIN (SELECT source_address, coin, tick, fiat, MAX(effective_at) AS max_eff ' +
            '      FROM oracle_prices WHERE effective_at <= ? GROUP BY source_address, coin, tick, fiat) latest ' +
            '  ON op.source_address = latest.source_address ' +
            ' AND op.coin = latest.coin AND op.tick = latest.tick ' +
            ' AND op.fiat = latest.fiat AND op.effective_at = latest.max_eff ' +
            'ORDER BY op.id ASC LIMIT ?', [now, limit]);
    },

    // Forgets the durable publish markers for a set of retracted rounds.
    // Moved here from src/oracle/publisher.js:2713.
    //
    // `rounds` is the caller's list of parsed integer round numbers; each one is bound as
    // a parameter, so the only thing built from the list is the count of placeholders.
    async deleteOraclePublishedRoundsByRounds(rounds) {
        let placeholders = rounds.map(() => '?').join(',');
        return this.doQuery(
            'DELETE FROM oracle_published_rounds WHERE round IN (' + placeholders + ')', rounds);
    },

    // Writes one PRICE v1 oracle row, generation-monotonic.
    // Moved here from src/oracle/price_aggregator.js:1458.
    //
    // On the (source_chain, action_index) unique key, a lower-or-equal generation never
    // overwrites a newer row, so a late stale push can neither insert an orphan nor clobber
    // the canonical re-publication. push_generation is assigned LAST so every column IF reads
    // the pre-update generation. admit_block rides the same generation guard as every other
    // column, and is bound AFTER push_generation so every existing positional read of these
    // args keeps its index; the UPDATE clause still assigns it BEFORE push_generation, which
    // is what the IF guards depend on. `row` carries the values already coerced by the caller.
    async setOraclePriceByGeneration(row) {
        let query = `INSERT INTO oracle_prices
            (source_address, source_chain, coin, tick, fiat, value, fee, memo, block_time, effective_at, action_index, push_generation, admit_block)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                source_address = IF(VALUES(push_generation) > push_generation, VALUES(source_address), source_address),
                coin           = IF(VALUES(push_generation) > push_generation, VALUES(coin), coin),
                tick           = IF(VALUES(push_generation) > push_generation, VALUES(tick), tick),
                fiat           = IF(VALUES(push_generation) > push_generation, VALUES(fiat), fiat),
                value          = IF(VALUES(push_generation) > push_generation, VALUES(value), value),
                fee            = IF(VALUES(push_generation) > push_generation, VALUES(fee), fee),
                memo           = IF(VALUES(push_generation) > push_generation, VALUES(memo), memo),
                block_time     = IF(VALUES(push_generation) > push_generation, VALUES(block_time), block_time),
                effective_at   = IF(VALUES(push_generation) > push_generation, VALUES(effective_at), effective_at),
                admit_block    = IF(VALUES(push_generation) > push_generation, VALUES(admit_block), admit_block),
                push_generation = GREATEST(push_generation, VALUES(push_generation))`;
        let args = [
            row.source_address, row.source_chain,
            row.coin, row.tick, row.fiat,
            row.value, row.fee, row.memo,
            row.block_time, row.effective_at, row.action_index, row.push_generation, row.admit_block
        ];
        return this.doQuery(query, args);
    },

    // Deletes a rolled-back source chain's PRICE v1 rows, for a reorg retraction.
    // Moved here from src/oracle/price_aggregator.js:1610.
    //
    // oracle_prices tracks the PRICE v1 action by action_index. `bounded` closes the range at
    // `to` so a row re-published inside the original open-ended range survives a deferred
    // retraction; `fenced` limits the delete to rows stamped at or below generation `gen`.
    // The caller normalizes and validates the bounds; this only binds them.
    async deleteOraclePricesForRetraction(sourceChain, from, to, gen, bounded, fenced) {
        let col = 'action_index';
        let where = 'source_chain = ? AND ' + col + (bounded ? ' >= ? AND ' + col + ' <= ?' : ' >= ?') + (fenced ? ' AND push_generation <= ?' : '');
        let args = [sourceChain, from];
        if (bounded) args.push(to);
        if (fenced) args.push(gen);
        return this.doQuery('DELETE FROM oracle_prices WHERE ' + where, args);
    }
};
