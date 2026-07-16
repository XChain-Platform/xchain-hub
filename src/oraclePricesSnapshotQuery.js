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
 * XChain Hub - oracle_prices snapshot query builder
 *
 * The /hub-db/snapshot/oracle_prices REST route serves two consumers with
 * opposite needs from the same append-only table:
 *
 *   1. Indexer bootstrap (hub_db_sync): pages the WHOLE table forward via a
 *      rising since_id (`WHERE id > since ORDER BY id ASC LIMIT n`) to build a
 *      byte-for-byte mirror. This is the DEFAULT and must never change - a
 *      mirror that skipped rows would diverge.
 *
 *   2. The dashboard oracle-feed monitor: wants only the CURRENT price per
 *      (coin, tick, fiat) feed. The ascending page-walk returns the OLDEST
 *      rows first, so once oracle_prices exceeds the page cap the monitor
 *      never reaches the live tail and shows stale/absent feeds (DASH-ORACLE-
 *      PAGE-1). Paging newer-first by id does NOT fix it either: a PRICE
 *      UPDATE is future-dated (effective_at = block_time + 86400), so a later
 *      publish (higher id) can carry an EARLIER effective_at than a prior
 *      update. "Latest" is therefore defined by MAX(effective_at) per feed,
 *      NOT by MAX(id).
 *
 * The `latest` mode answers consumer 2 directly and boundedly: one row per
 * feed (plus the rare effective_at tie), independent of table size, no page
 * walk. It is opt-in; absent the flag the route behaves exactly as before.
 */
'use strict';

// Hard ceiling on rows returned, mirroring the route's other snapshot caps.
// In `latest` mode the natural result size is the number of distinct feeds
// (tiny); the cap only guards a pathologically large feed set.
const MAX_SNAPSHOT_ROWS = 10000;

// Build the SQL + params for the oracle_prices snapshot route.
//   opts.latest : truthy -> latest-row-per-feed mode (MAX(effective_at))
//   opts.since  : since_id for the default ascending page-walk (ignored when latest)
//   opts.limit  : row cap (clamped to [1, MAX_SNAPSHOT_ROWS])
// Returns { sql, params, mode }. `mode` is echoed to the client so it can tell
// whether an older hub silently ignored the `latest` flag and served a page.
function buildOraclePricesSnapshotQuery(opts = {}) {
    const limit = clampLimit(opts.limit);

    if (opts.latest) {
        // now gates the MAX(effective_at) subquery so a future-dated PRICE
        // UPDATE (effective_at = block_time + 86400, during its 24h lock
        // window) never wins the feed's "latest" slot ahead of the row that
        // is actually in effect. Without this gate the currently-served
        // price is hidden from the dashboard for the entire lock window.
        const now = clampNow(opts.now);
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
        const sql =
            'SELECT op.* FROM oracle_prices op ' +
            'JOIN (SELECT source_address, coin, tick, fiat, MAX(effective_at) AS max_eff ' +
            '      FROM oracle_prices WHERE effective_at <= ? GROUP BY source_address, coin, tick, fiat) latest ' +
            '  ON op.source_address = latest.source_address ' +
            ' AND op.coin = latest.coin AND op.tick = latest.tick ' +
            ' AND op.fiat = latest.fiat AND op.effective_at = latest.max_eff ' +
            'ORDER BY op.id ASC LIMIT ?';
        return { sql, params: [now, limit], mode: 'latest' };
    }

    const since = clampSince(opts.since);
    return {
        sql: 'SELECT * FROM oracle_prices WHERE id > ? ORDER BY id ASC LIMIT ?',
        params: [since, limit],
        mode: 'page',
    };
}

function clampLimit(limit) {
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return MAX_SNAPSHOT_ROWS;
    return Math.min(n, MAX_SNAPSHOT_ROWS);
}

function clampSince(since) {
    const n = parseInt(since, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
}

function clampNow(now) {
    const n = parseInt(now, 10);
    if (!Number.isFinite(n) || n < 0) return Math.floor(Date.now() / 1000);
    return n;
}

module.exports = { buildOraclePricesSnapshotQuery, MAX_SNAPSHOT_ROWS };
