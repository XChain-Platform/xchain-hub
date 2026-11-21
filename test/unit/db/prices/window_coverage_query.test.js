'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const prices = require('../../../../src/db/prices/index.js');

describe('price window coverage query', function () {
    it('projects the proof prefix needed to distinguish landed-batch rows', async function () {
        let call;
        const db = { doQuery: async (sql, args) => { call = { sql, args }; return []; } };
        await prices.findPriceSnapshotsByRoundNumberAndStatus.call(db, 10, 20, 'finalized');
        expect(call.sql).to.match(/LEFT\(consensus_proof, 8\) AS proof_head/);
        expect(call.args).to.deep.equal([10, 20, 'finalized']);
    });
});
