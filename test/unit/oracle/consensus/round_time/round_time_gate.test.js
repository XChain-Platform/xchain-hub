'use strict';

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
 ********************************************************************/

const assert = require('assert');
const sinon = require('sinon');

const gateRegistry = require('../../../../../src/consensus/gate_registry');
const roundTimeGate = require('../../../../../src/oracle/consensus/round_time_gate');
const { ROUND_TIME_GATE, roundTimeGateActive } = roundTimeGate;

describe('oracle consensus round time gate', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('exports only the shared key and reader', function () {
        assert.deepStrictEqual(
            Object.keys(roundTimeGate).sort(),
            ['ROUND_TIME_GATE', 'roundTimeGateActive']
        );
    });

    it('passes true and the exact gate coordinates through', function () {
        const activeAt = sinon.stub(gateRegistry, 'activeAt').returns(true);

        assert.strictEqual(roundTimeGateActive({ network: 'testnet', btcHeight: 42 }), true);
        assert.deepStrictEqual(activeAt.args, [[
            ROUND_TIME_GATE,
            'testnet',
            'BTC',
            42,
            null
        ]]);
    });

    it('passes false through', function () {
        sinon.stub(gateRegistry, 'activeAt').returns(false);

        assert.strictEqual(roundTimeGateActive({ network: 'mainnet', btcHeight: 0 }), false);
    });

    const invalidHeights = [
        ['negative', -1],
        ['fractional', 1.5],
        ['NaN', NaN],
        ['null', null],
        ['string', '42']
    ];

    for (const [label, btcHeight] of invalidHeights) {
        it(`returns false without a registry read for a ${label} height`, function () {
            const activeAt = sinon.stub(gateRegistry, 'activeAt');

            assert.strictEqual(roundTimeGateActive({ network: 'testnet', btcHeight }), false);
            assert.strictEqual(activeAt.called, false);
        });
    }

    it('propagates registry errors', function () {
        const error = new Error('missing gate key');
        sinon.stub(gateRegistry, 'activeAt').throws(error);

        assert.throws(
            () => roundTimeGateActive({ network: 'regtest', btcHeight: 7 }),
            thrown => thrown === error
        );
    });
});
