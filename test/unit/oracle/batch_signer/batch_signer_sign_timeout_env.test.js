'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The PRICE batch signer's sign-round timeout honours the container env even when
// the hub's p2pConfig carries no such key, which is the shape api.js builds. The
// p2pConfig value still applies when the env is unset.
const { expect } = require('chai');
const OracleBatchSigner = require('../../../../src/oracle/batch_signer');

const KEY = 'ORACLE_BATCH_SIGN_TIMEOUT_MS';

// The api.js-shaped p2pConfig: the network and nothing for the sign timeout.
function signerFor(p2pExtra) {
    let p2pConfig = Object.assign({ HUB_NETWORK: 'regtest' }, p2pExtra || {});
    return new OracleBatchSigner({ network: 'regtest', p2pConfig });
}

describe('OracleBatchSigner sign timeout config', function () {
    let saved;

    beforeEach(function () {
        saved = Object.prototype.hasOwnProperty.call(process.env, KEY) ? process.env[KEY] : undefined;
        delete process.env[KEY];
    });

    afterEach(function () {
        if (saved === undefined) delete process.env[KEY];
        else process.env[KEY] = saved;
    });

    it('reads the env override when p2pConfig omits the key', function () {
        process.env[KEY] = '123456';
        expect(signerFor().signTimeoutMs).to.equal(123456);
    });

    it('lets the env override win over a p2pConfig value', function () {
        process.env[KEY] = '123456';
        expect(signerFor({ [KEY]: '250' }).signTimeoutMs).to.equal(123456);
    });

    it('falls back to 60000 with neither env nor p2pConfig set', function () {
        expect(signerFor().signTimeoutMs).to.equal(60000);
    });

    it('keeps the p2pConfig value when the env is unset', function () {
        expect(signerFor({ [KEY]: '250' }).signTimeoutMs).to.equal(250);
    });

    it('falls back to 60000 on a non-positive env value', function () {
        process.env[KEY] = '-5';
        expect(signerFor().signTimeoutMs).to.equal(60000);
    });
});
