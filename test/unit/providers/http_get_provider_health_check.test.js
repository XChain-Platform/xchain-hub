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
 **********************************************************************
 *
 * XChain Hub - http_get attestation provider tests (byte_equality agree)
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const nock       = require('nock');
const dns        = require('dns');
const httpGet    = require('../../../src/providers/http_get.js');

// Resolve every hostname to a public address so unit tests never touch real
// DNS (the SSRF guard resolves before nock's request interception kicks in).
function stubPublicDns() {
    sinon.stub(dns.promises, 'lookup').resolves([{ address: '93.184.216.34', family: 4 }]);
}

function p(body, meta){ return { body: Buffer.from(body, 'utf8'), meta: String(meta || '200') }; }

// ---- healthCheck() ---------------------------------------------------------

describe('http_get.healthCheck', function () {

    beforeEach(stubPublicDns);

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    it('returns ok:true with the status code when the probe succeeds', async function () {
        nock('https://checkip.amazonaws.com').get('/').reply(200, '1.2.3.4\n');
        const result = await httpGet.healthCheck();
        expect(result.ok).to.equal(true);
        expect(result.status).to.equal('200');
    });

    it('returns ok:false with an error message when the probe fails', async function () {
        nock('https://checkip.amazonaws.com').get('/').replyWithError('ETIMEDOUT');
        const result = await httpGet.healthCheck();
        expect(result.ok).to.equal(false);
        expect(result.error).to.be.a('string');
        expect(result.error).to.match(/request error/);
    });

});
