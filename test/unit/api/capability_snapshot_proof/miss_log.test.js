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

const sinon = require('sinon');
const { expect } = require('chai');
const { createMissLog } = require('../../../../src/api/rest/capability_snapshot_proof/miss_log.js');

describe('capability snapshot proof not-checkpointed diagnostic', function () {
    it('names the block, the missing checkpoint and the NULL-stamped rows, once a minute per block', async function () {
        let clock = 0;
        const logger = { warn: sinon.spy() };
        const db = { countCapabilitySnapshotChainIdStamps: sinon.stub().resolves([{ rows_total: 3, rows_null: '3' }]) };
        const log = createMissLog({ logger, now: () => clock });

        expect(await log.report(db, 34, 28)).to.equal(true);
        expect(logger.warn.firstCall.args[0]).to.equal('CapabilitySnapshotProof: no snapshot_checkpoints row at ' +
            'BTC block 28 for snapshot_block 34 (answering SNAPSHOT_NOT_YET_CHECKPOINTED); capability_snapshots ' +
            'at that block: 3 of 3 row(s) with NULL btc_chain_id');
        clock = 59999;
        expect(await log.report(db, 34, 28)).to.equal(false);
        expect(await log.report(db, 40, 34)).to.equal(true);
        clock = 60000;
        expect(await log.report(db, 34, 28)).to.equal(true);
        expect(logger.warn.callCount).to.equal(3);
    });

    it('never throws when the count is unavailable or fails', async function () {
        const logger = { warn: sinon.spy() };
        const log = createMissLog({ logger, now: () => 0 });
        expect(await log.report({}, 34, 28)).to.equal(true);
        expect(logger.warn.firstCall.args[0]).to.match(/capability_snapshots at that block: unknown$/);
        const failing = { countCapabilitySnapshotChainIdStamps: sinon.stub().rejects(new Error('down')) };
        expect(await log.report(failing, 50, 44)).to.equal(false);
    });
});
