'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { selectReading, clearFrontierActive } = require('../../../../src/peers/hub_db/landing_watermark.js');

const KEY = 'peers/hub_db/landing_watermark.LANDING_CLEAR_FRONTIER_ACTIVATION';
const delivered = { block: 100, protocol_time: 1791144200 };
const ahead = { block: 120, protocol_time: 1791145400 };
const behind = { block: 90, protocol_time: 1791143000 };

describe('landing watermark clear frontier', function () {
    it('registers a gate armed on regtest only', function () {
        expect(gateRegistry.has(KEY)).to.equal(true);
        expect(gateRegistry.activeAt(KEY, 'regtest', 'DOGE', 1, null)).to.equal(true);
        expect(gateRegistry.activeAt(KEY, 'testnet', 'DOGE', 999999999, null)).to.equal(false);
        expect(gateRegistry.activeAt(KEY, 'mainnet', 'DOGE', 999999999, null)).to.equal(false);
    });

    it('publishes the clear frontier when it is ahead of hub_push_delivered', function () {
        expect(selectReading('DOGE', delivered, ahead, 'regtest')).to.deep.equal(ahead);
    });

    it('keeps hub_push_delivered when the clear frontier is level or behind', function () {
        expect(selectReading('DOGE', delivered, behind, 'regtest')).to.deep.equal(delivered);
        expect(selectReading('DOGE', delivered, delivered, 'regtest')).to.deep.equal(delivered);
    });

    it('uses the clear frontier when hub_push_delivered is unknown', function () {
        expect(selectReading('DOGE', null, ahead, 'regtest')).to.deep.equal(ahead);
    });

    it('ignores the clear frontier below the activation', function () {
        expect(clearFrontierActive('testnet', 'DOGE', 120)).to.equal(false);
        expect(selectReading('DOGE', delivered, ahead, 'testnet')).to.deep.equal(delivered);
        expect(selectReading('DOGE', null, ahead, 'mainnet')).to.equal(null);
    });

    it('ignores a malformed clear frontier', function () {
        expect(selectReading('DOGE', delivered, { block: 'x', protocol_time: 1 }, 'regtest')).to.deep.equal(delivered);
        expect(selectReading('DOGE', delivered, undefined, 'regtest')).to.deep.equal(delivered);
    });
});
