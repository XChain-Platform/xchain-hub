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
 ********************************************************************/

'use strict';

const hubConfig = require('../../config');
const { exactU64TypeCast } = require('./exact_u64.js');

// The mariadb pool options for one hub database connection.
function buildPoolParams(host, port, dbName, user, pass){
    const queryTimeout = parseInt(hubConfig.DB_QUERY_TIMEOUT) || 30000;

    return {
        host:               host,
        user:               user,
        password:           pass,
        database:           dbName,
        port:               port,
        connectionLimit:    10,
        connectTimeout:     parseInt(hubConfig.DB_CONNECT_TIMEOUT) || 10000,
        acquireTimeout:     parseInt(hubConfig.DB_ACQUIRE_TIMEOUT) || 10000,
        idleTimeout:        60000,
        insertIdAsNumber:   true,
        bigIntAsNumber:     true,
        // Preserve exact BIGINT values used in signed canonicals. Safe values
        // remain Numbers; wider values become decimal strings. This cast uses
        // field.string(), so hub reads must remain on query/queryStream rather
        // than the binary execute/batch protocol.
        typeCast:           exactU64TypeCast,
        // Pin BOTH halves of datetime handling to UTC. The driver
        // otherwise binds a JS Date using the Node process's LOCAL timezone while
        // the server evaluates NOW() / CURRENT_TIMESTAMP / FROM_UNIXTIME in the
        // session's own, so a hub whose host is not on UTC writes and compares
        // datetimes that are hours apart. Two real consequences, both silent:
        // Governance.propose() wrote a voting_end already in the past, so a
        // proposal expired the instant it was created, and ReorgHandler's rollback
        // DELETE matched nothing because the attestation rows it was meant to
        // remove appeared to predate the reorg bound. This option makes the driver
        // serialize/parse Dates as UTC and issue `SET time_zone='+00:00'` per
        // connection, so both sides agree no matter where the hub runs - which
        // also keeps a geographically-spread federation comparing like with like.
        // Safe for existing data: every temporal column in src/sql is TIMESTAMP
        // (UTC-normalized in storage) or DATETIME (stores the literal), and the
        // session's UTC pin makes the two agree.
        timezone:           'Z',
        minDelayValidation: 3000,
        queryTimeout:       queryTimeout,
        // queryTimeout is enforced by the SERVER (SET STATEMENT max_statement_time),
        // so a frozen or partitioned server leaves an in-flight query with no
        // client-side bound: it holds its pool slot and HTTP request until the
        // server returns. socketTimeout cuts the dead socket client-side. It sits
        // above queryTimeout so a healthy server's own limit always fires first.
        socketTimeout:      parseInt(hubConfig.DB_SOCKET_TIMEOUT) || (queryTimeout + 15000)
    };
}

module.exports = { buildPoolParams };
