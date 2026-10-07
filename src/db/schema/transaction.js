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
 * XChain Hub - explicit transactions, as a Database.prototype mixin.
 *
 * Class plumbing beside doQuery, not a table family, so it carries no SQL of its
 * own: a caller passes a body that runs one-statement, connection-first query
 * methods from the families on the connection it is handed. Use it only where
 * statements must land together; one statement under autocommit is already its
 * own transaction and needs none.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    // Run `work(conn)` as one InnoDB transaction on a connection of its own. Rolls back
    // and rethrows on any error, and reruns the whole body on a deadlock (InnoDB rolled
    // it all back), as doQuery does for one statement. Never sets the per-Db
    // transactionConnection, which would capture unrelated concurrent queries.
    async withTransaction(work) {
        if (this.transactionConnection)
            throw new Error('withTransaction: a transactionConnection is already open on this Db');
        for (let attempt = 1; ; attempt++) {
            const conn = await this.getConnection();
            try {
                await conn.beginTransaction();
                const result = await work(conn);
                await conn.commit();
                return result;
            } catch (error) {
                await conn.rollback().catch(e => logger.error(nodeUtil.format('Error rolling back transaction:', e)));
                const deadlock = error && (error.errno === 1213 || error.code === 'ER_LOCK_DEADLOCK');
                if (!deadlock || attempt >= 3)
                    throw error;
            } finally {
                await conn.release();
            }
            await this.sleep(25 * attempt);
        }
    }
};
