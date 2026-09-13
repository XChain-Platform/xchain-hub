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
 * XChain Hub - query methods for the telemetry ping table.
 *
 * Owns src/sql/telemetry_pings.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

// The telemetry window is interpolated into an INTERVAL literal, so it must be a
// whole, positive number of days and nothing else. The routes clamp it to 1..365
// before calling; this is the statement-side guard that holds if a caller forgets.
function assertTelemetryWindowDays(days) {
    if (!Number.isInteger(days) || days < 1)
        throw new Error('telemetry window must be a positive whole number of days, got ' + days);
}

module.exports = {
    // Deletes from telemetry_pings.
    // Moved here from src/api.js:2658.
    async deleteTelemetryPing(telemetryRetentionDays) {
        return this.doQuery('DELETE FROM telemetry_pings WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [telemetryRetentionDays]);
    },

    // Inserts a row into telemetry_pings. The caller has already clamped every
    // string and serialised the module list, so the values bind as they arrive.
    // Moved here from src/api.js:2303.
    async createTelemetryPing(installId, country, region, ipHash, nodeVersion, osPlatform, osRelease, arch, dockerVersion, modules, event) {
        return this.doQuery(`INSERT INTO telemetry_pings
                         (install_id, country, region, ip_hash, node_version, os_platform, os_release, arch, docker_version, modules, event)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                installId,
                country,
                region,
                ipHash,
                nodeVersion,
                osPlatform,
                osRelease,
                arch,
                dockerVersion,
                modules,
                event
            ]);
    },

    // Reads rows from telemetry_pings: the latest ping per install inside the
    // window, with the columns the aggregate census tallies.
    // The window is inlined rather than bound because MariaDB won't bind inside an
    // INTERVAL literal cleanly, so assertTelemetryWindowDays refuses anything but a
    // whole number of days before it reaches the statement.
    // Moved here from src/api.js:2342.
    async findLatestTelemetryPingPerInstall(days) {
        assertTelemetryWindowDays(days);
        return this.doQuery(
                `SELECT t.install_id, t.country, t.node_version, t.os_platform, t.arch, t.docker_version, t.modules
                   FROM telemetry_pings t
                   JOIN (
                     SELECT install_id, MAX(created_at) AS mx
                       FROM telemetry_pings
                      WHERE created_at > (NOW() - INTERVAL ${days} DAY)
                      GROUP BY install_id
                   ) l ON t.install_id = l.install_id AND t.created_at = l.mx
                  LIMIT 50000`,
                []
            );
    },

    // Reads one row from telemetry_pings: total pings inside the window (activity
    // volume, not unique installs). Same inlined, integer-checked window as above.
    // Moved here from src/api.js:2404.
    async getTelemetryPingCountInWindow(days) {
        assertTelemetryWindowDays(days);
        return this.doQuery(
                `SELECT COUNT(*) AS c FROM telemetry_pings WHERE created_at > (NOW() - INTERVAL ${days} DAY)`,
                []
            );
    },

    // Reads rows from telemetry_pings: the latest ping per install inside the
    // window with the per-server detail columns (region, ip_hash, os_release,
    // last_seen) the admin-gated operators view needs. Same inlined,
    // integer-checked window as above.
    // Moved here from src/api.js:2448.
    async findLatestTelemetryOperatorPingPerInstall(days) {
        assertTelemetryWindowDays(days);
        return this.doQuery(
                `SELECT t.install_id, t.country, t.region, t.ip_hash, t.node_version,
                        t.os_platform, t.os_release, t.arch, t.docker_version, t.modules,
                        t.created_at AS last_seen
                   FROM telemetry_pings t
                   JOIN (
                     SELECT install_id, MAX(created_at) AS mx
                       FROM telemetry_pings
                      WHERE created_at > (NOW() - INTERVAL ${days} DAY)
                      GROUP BY install_id
                   ) l ON t.install_id = l.install_id AND t.created_at = l.mx
                  LIMIT 50000`,
                []
            );
    },

    // Reads rows from telemetry_pings: ping count and first_seen per install inside
    // the window. Same inlined, integer-checked window as above.
    // Moved here from src/api.js:2464.
    async findTelemetryPingStatsPerInstall(days) {
        assertTelemetryWindowDays(days);
        return this.doQuery(
                `SELECT install_id, COUNT(*) AS pings, MIN(created_at) AS first_seen
                   FROM telemetry_pings
                  WHERE created_at > (NOW() - INTERVAL ${days} DAY)
                  GROUP BY install_id`,
                []
            );
    }
};
