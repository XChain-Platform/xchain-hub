'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const snapWrite = require('../../../src/lib/capability_snapshot_write.js');
const { createCapabilitySnapshots } = require('../../../src/db/capability_snapshots.js');

const BLOCK = 953200;
const CAPABILITY = 'oracle_publish';

describe('capability snapshot row order', function () {
    it('sorts normalized rows by signing_pubkey ascending', function () {
        let rows = snapWrite.normalizeCapabilitySnapshotRows(CAPABILITY, BLOCK, [
            { pubkey: 'cc'.repeat(32), weight: '30', source: 'src-c' },
            { pubkey: 'bb'.repeat(32), weight: '20', source: 'src-b' },
            { pubkey: 'aa'.repeat(32), weight: '10', source: 'src-a' }
        ]);

        expect(rows.map(row => row.signing_pubkey)).to.deep.equal([
            'aa'.repeat(32),
            'bb'.repeat(32),
            'cc'.repeat(32)
        ]);
    });

    it('breaks a signing_pubkey tie by source ascending', function () {
        let pubkey = 'aa'.repeat(32);
        let rows = snapWrite.normalizeCapabilitySnapshotRows(CAPABILITY, BLOCK, [
            { pubkey, weight: '20', source: 'source-z' },
            { pubkey, weight: '10', source: 'source-a' }
        ]);

        expect(rows.map(row => row.source)).to.deep.equal(['source-a', 'source-z']);
    });

    it('passes rows to the database statement in signing_pubkey order', async function () {
        let queryArgs;
        let db = {
            createCapabilitySnapshots,
            async getChainTip() {
                return { chainId: 'btc-chain-id' };
            },
            async doQuery(sql, args) {
                queryArgs = args;
                return [];
            }
        };

        await snapWrite.writeCapabilitySnapshotRows(db, CAPABILITY, BLOCK, [
            { pubkey: 'bb'.repeat(32), weight: '20', source: 'src-b' },
            { pubkey: 'dd'.repeat(32), weight: '40', source: 'src-d' },
            { pubkey: 'aa'.repeat(32), weight: '10', source: 'src-a' },
            { pubkey: 'cc'.repeat(32), weight: '30', source: 'src-c' }
        ]);

        let signingPubkeys = [];
        for(let i = 2; i < queryArgs.length; i += 6) signingPubkeys.push(queryArgs[i]);
        expect(signingPubkeys).to.deep.equal([
            'aa'.repeat(32),
            'bb'.repeat(32),
            'cc'.repeat(32),
            'dd'.repeat(32)
        ]);
    });
});
