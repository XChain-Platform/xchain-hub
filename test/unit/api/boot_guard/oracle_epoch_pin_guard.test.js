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

const sinon = require('sinon');
const { expect } = require('chai');
const { refuseInvalidNetwork } = require('../../../../src/api/boot_guard.js');

const EPOCH_ERROR = 'Missing required environment variable: ORACLE_EPOCH_START (Unix ms timestamp anchoring oracle round numbering; all hubs must share the same value)';
const NETWORK_ERROR = 'Missing/invalid required environment variable: HUB_NETWORK (must be one of mainnet|testnet|regtest; names the deployment network for consensus activation gating; must match the indexers this hub federates)';

describe('refuseInvalidNetwork() oracle epoch pins', function () {
    let exits, errors, logger;

    beforeEach(function () {
        exits = [];
        errors = [];
        logger = { error: (message) => errors.push(message), warn: sinon.stub(), info: sinon.stub() };
        sinon.stub(process, 'exit').callsFake((code) => { exits.push(code); });
    });

    afterEach(function () {
        sinon.restore();
    });

    function run({ epoch, network, pins, passPins = true }) {
        const options = {
            logger,
            hubConfig: { ORACLE_EPOCH_START: epoch },
            P2P_VALIDATOR_ADDR: 'validator-address',
            HUB_NETWORK: network
        };
        if (passPins) options.oracleEpochPins = pins;
        refuseInvalidNetwork(options);
    }

    it('accepts a testnet validator with no epoch env and an illustrative testnet pin', function () {
        run({ network: 'testnet', pins: { testnet: 1700000000000 } });
        expect(exits).to.deep.equal([]);
        expect(errors).to.deep.equal([]);
    });

    it('refuses the same testnet validator when the pin table is empty', function () {
        run({ network: 'testnet', pins: {} });
        expect(exits).to.deep.equal([1]);
        expect(errors).to.deep.equal([EPOCH_ERROR]);
    });

    it('refuses the same testnet validator when no pin table is passed', function () {
        run({ network: 'testnet', passPins: false });
        expect(exits).to.deep.equal([1]);
        expect(errors).to.deep.equal([EPOCH_ERROR]);
    });

    it('still refuses regtest when the table has a regtest entry', function () {
        run({ network: 'regtest', pins: { regtest: 1700000000000 } });
        expect(exits).to.deep.equal([1]);
        expect(errors).to.deep.equal([EPOCH_ERROR]);
    });

    it('still refuses mainnet when the table has only a testnet entry', function () {
        run({ network: 'mainnet', pins: { testnet: 1700000000000 } });
        expect(exits).to.deep.equal([1]);
        expect(errors).to.deep.equal([EPOCH_ERROR]);
    });

    it('accepts a set epoch env on a pinned network', function () {
        run({ epoch: '1700000000000', network: 'testnet', pins: { testnet: 1700000000000 } });
        expect(exits).to.deep.equal([]);
        expect(errors).to.deep.equal([]);
    });

    it('reports only the HUB_NETWORK error when the epoch env is set and HUB_NETWORK is invalid', function () {
        run({ epoch: '1700000000000', network: 'bogusnet', pins: { testnet: 1700000000000 } });
        expect(exits).to.deep.equal([1]);
        expect(errors).to.deep.equal([NETWORK_ERROR]);
    });
});
