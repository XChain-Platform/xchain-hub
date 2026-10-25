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
 **********************************************************************
 *
 * Checkpoint supersession follows witnessed replay disagreement.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const roundMethods = require('../../../../src/anchor/checkpoint_engine/round.js');
const stateCheckpointMethods = require('../../../../src/db/state_checkpoints.js');

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);

function rules(digest, overrides) {
    return {
        digest,
        replay: Object.assign({
            state: 'replayed',
            target: 40,
            replay_to: 80,
            witness: 'passed',
            changed: true,
        }, overrides),
    };
}

function engineWithRows(rows) {
    const calls = [];
    return {
        calls,
        engine: {
            db: {
                async findUnsupersededStateCheckpointsInReplayWindow(...args) {
                    calls.push(args);
                    return rows;
                },
            },
            supersedeFieldsForRound: roundMethods.supersedeFieldsForRound,
        },
    };
}

function registerDigestReuseTest() {
    it('supersedes an A to B to A replay even though digest A was used before', async function () {
        const rows = [
            { checkpoint_seq: 10, effective_rules_digest: A },
        ];
        const fixture = engineWithRows(rows);

        const toB = await fixture.engine.supersedeFieldsForRound(
            'BTC', 'regtest', { rules: rules(B) });
        rows.splice(0, rows.length,
            { checkpoint_seq: 20, effective_rules_digest: B });
        const backToA = await fixture.engine.supersedeFieldsForRound(
            'BTC', 'regtest', { rules: rules(A) });

        expect(toB).to.deep.equal({ supersedes_from: 40, rules_digest: B });
        expect(backToA).to.deep.equal({ supersedes_from: 40, rules_digest: A });
        expect(fixture.calls).to.deep.equal([
            ['BTC', 'regtest', 40, 80],
            ['BTC', 'regtest', 40, 80],
        ]);
    });
}

function registerWitnessGateTests() {
    it('does not supersede a pre-witness replay', async function () {
        const fixture = engineWithRows([
            { checkpoint_seq: 10, effective_rules_digest: B },
        ]);

        const fields = await fixture.engine.supersedeFieldsForRound(
            'BTC', 'regtest', { rules: rules(A, { witness: null }) });

        expect(fields).to.equal(null);
        expect(fixture.calls).to.deep.equal([]);
    });

    it('does not supersede a passed replay whose witness found no change', async function () {
        const fixture = engineWithRows([
            { checkpoint_seq: 10, effective_rules_digest: B },
        ]);

        const fields = await fixture.engine.supersedeFieldsForRound(
            'BTC', 'regtest', { rules: rules(A, { changed: false }) });

        expect(fields).to.equal(null);
        expect(fixture.calls).to.deep.equal([]);
    });
}

function registerAgreementTest() {
    it('does not supersede again after the surviving window agrees', async function () {
        const fixture = engineWithRows([
            { checkpoint_seq: 30, effective_rules_digest: A },
            { checkpoint_seq: 31, rules_digest: A, effective_rules_digest: null },
        ]);

        const fields = await fixture.engine.supersedeFieldsForRound(
            'BTC', 'regtest', { rules: rules(A) });

        expect(fields).to.equal(null);
        expect(fixture.calls).to.deep.equal([['BTC', 'regtest', 40, 80]]);
    });
}

function registerReplayWindowQueryTest() {
    it('reads only effective finalized rows in the inclusive replay window', async function () {
        const calls = [];
        const resultRows = [{ checkpoint_seq: 20, effective_rules_digest: B }];
        const result = await stateCheckpointMethods
            .findUnsupersededStateCheckpointsInReplayWindow.call({
                async doQuery(sql, params) {
                    calls.push({ sql, params });
                    return resultRows;
                },
            }, 'BTC', 'regtest', 40, 80);

        expect(result).to.equal(resultRows);
        expect(calls).to.have.length(1);
        expect(calls[0].params).to.deep.equal(['BTC', 'regtest', 40, 80]);
        expect(calls[0].sql).to.include('sc.block_index BETWEEN ? AND ?');
        expect(calls[0].sql).to.include('NOT EXISTS');
        expect(calls[0].sql).to.include('superseder.checkpoint_seq > sc.checkpoint_seq');
        expect(calls[0].sql).to.include('epoch.supersedes_from <= sc.block_index');
        expect(calls[0].sql).to.include('AS effective_rules_digest');
    });
}

describe('checkpoint supersede on witnessed disagreement @regression', function () {
    registerDigestReuseTest();
    registerWitnessGateTests();
    registerAgreementTest();
    registerReplayWindowQueryTest();
});
