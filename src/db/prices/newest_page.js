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

module.exports = {

    // Find the boundary using the round/pair key in one direction, then supply its
    // literal round to the mixed-direction page read so that read can use a range.
    async findPriceSnapshotsAnyStatus(limit) {
        const boundaryRows = await this.doQuery(
            "SELECT round_number FROM price_snapshots ORDER BY round_number DESC, coin_pair DESC LIMIT 1 OFFSET ?",
            [limit - 1]);
        if (!boundaryRows.length)
            return this.doQuery("SELECT * FROM price_snapshots ORDER BY round_number DESC, coin_pair ASC LIMIT ?", [limit]);
        return this.doQuery(
            "SELECT * FROM price_snapshots WHERE round_number >= ? ORDER BY round_number DESC, coin_pair ASC LIMIT ?",
            [boundaryRows[0].round_number, limit]);
    },

    async findPriceSnapshotsFinalized(limit) {
        const boundaryRows = await this.doQuery(
            "SELECT round_number FROM price_snapshots WHERE status = 'finalized' ORDER BY round_number DESC, coin_pair DESC LIMIT 1 OFFSET ?",
            [limit - 1]);
        if (!boundaryRows.length)
            return this.doQuery("SELECT * FROM price_snapshots WHERE status = 'finalized' ORDER BY round_number DESC, coin_pair ASC LIMIT ?", [limit]);
        return this.doQuery(
            "SELECT * FROM price_snapshots WHERE status = 'finalized' AND round_number >= ? ORDER BY round_number DESC, coin_pair ASC LIMIT ?",
            [boundaryRows[0].round_number, limit]);
    }
};
