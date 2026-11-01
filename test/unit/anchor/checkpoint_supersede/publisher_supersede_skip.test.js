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
//
// A supersession marker never becomes an ANCHOR v0 section or the fold wrapper. Its
// signatures end in the SUPERSEDE segment, which neither the v0 section wire nor the
// fold canonical carries, so the selector skips it and the fold canonical refuses it.

const { expect }            = require('chai');
const StateAnchorPublisher  = require('../../../../src/anchor/publisher');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine');
const { foldArchiveCanonical } = require('../../../../src/anchor/publisher/canonical_forms.js');
const stateCheckpoints      = require('../../../../src/db/state_checkpoints.js');
const { CP_ROW }            = require('../../../helpers/anchor_mesh.js');

const DIGEST = 'ab'.repeat(32);

function row(chain, over) {
    return Object.assign({}, CP_ROW, { chain: chain, anchor_txid: null }, over || {});
}

function group(rows) {
    let pub = new StateAnchorPublisher({ db: {}, p2pConfig: {} });
    return pub.groupSectionsByNetwork(rows);
}

describe('StateAnchorPublisher supersession markers stay out of bundles and folds', function () {
    it('keeps a plain row and drops the same row once it carries supersession fields', function () {
        expect(group([row('BTC')]).get('regtest').length).to.equal(1);
        expect(group([row('BTC', { supersedes_from: 400, rules_digest: DIGEST })]).size).to.equal(0);
        expect(group([row('BTC', { rules_digest: DIGEST })]).size, 'a digest alone still marks the row').to.equal(0);
        expect(group([row('BTC', { supersedes_from: 0 })]).size, 'supersedes_from 0 still marks the row').to.equal(0);
    });

    it('drops only the superseding section when a bundle mixes plain and superseding rows', function () {
        let out = group([row('BTC'), row('LTC', { supersedes_from: 400, rules_digest: DIGEST }), row('DOGE')]);
        expect(out.get('regtest').map(r => r.chain)).to.deep.equal(['BTC', 'DOGE']);
    });

    it('refuses a superseding fold wrapper and leaves the plain wrapper bytes alone', function () {
        let plain = foldArchiveCanonical(row('BTC'), 5, 1, '8665563e', 1);
        expect(plain).to.be.a('string').and.not.include('SUPERSEDE');
        expect(() => foldArchiveCanonical(row('BTC', { supersedes_from: 400, rules_digest: DIGEST }), 5, 1, '8665563e', 1))
            .to.throw(/supersession fields/);
        expect(() => foldArchiveCanonical(row('BTC', { rules_digest: DIGEST }), 5, 1, '8665563e', 1))
            .to.throw(/supersession fields/);
    });

    // Expect the segment in the v0 signing string: regtest arms the supersede gate at genesis.
    it('skips exactly the rows whose v0 signing string carries the SUPERSEDE segment', function () {
        let marker = row('BTC', { supersedes_from: 400, rules_digest: DIGEST });
        expect(StateCheckpointEngine.canonicalCheckpoint(marker)).to.include('|SUPERSEDE|400|' + DIGEST);
        expect(StateCheckpointEngine.canonicalCheckpoint(row('BTC'))).to.not.include('SUPERSEDE');
    });

    it('keeps supersedes_from IS NULL inside the pending-anchor MAX subquery', async function () {
        let seen = [];
        let db = { doQuery: async (sql) => { seen.push(sql); return []; } };
        await stateCheckpoints.findAnchorEligibleUnanchoredCheckpoints.call(db, 1, 1);
        await stateCheckpoints.findAnchorEligibleUnanchoredCheckpointsByNetwork.call(db, 1, 1, 'regtest');
        expect(seen).to.have.lengthOf(2);
        for (let sql of seen) {
            let at = sql.indexOf('supersedes_from IS NULL');
            expect(at, 'the plain-row filter is present').to.be.above(-1);
            expect(at, 'the plain-row filter sits before the subquery GROUP BY').to.be.below(sql.indexOf('GROUP BY'));
        }
    });
});
