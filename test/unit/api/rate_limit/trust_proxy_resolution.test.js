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
 * Trust only the configured reverse-proxy boundary when resolving req.ip.
 *
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { installTransportMiddleware } = require('../../../../src/api/middleware.js');

function boot(raw) {
    const app = express();
    const hubConfig = {};
    const warnings = [];
    if (raw !== undefined) hubConfig.HUB_TRUST_PROXY = raw;
    installTransportMiddleware(app, {
        hubConfig,
        logger: { info() {}, warn(message) { warnings.push(message); } },
        express, helmet, cors, rateLimit,
        CORS_ORIGIN: '*',
        HUB_RATE_LIMIT_RPM: 100000,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: true
    });
    app.bootWarnings = warnings;
    return app;
}

describe('hub trust proxy resolution', () => {
    it('defaults to loopback and private proxy peers, never public peers', () => {
        for (const raw of [undefined, '']) {
            const app = boot(raw);
            const trust = app.get('trust proxy fn');
            expect(app.get('trust proxy')).to.equal('loopback, uniquelocal');
            for (const addr of ['127.0.0.1', '::1', '172.17.0.1', '10.1.2.3', '192.168.1.5'])
                expect(trust(addr, 0), addr).to.equal(true);
            for (const addr of ['203.0.113.5', '8.8.8.8'])
                expect(trust(addr, 0), addr).to.equal(false);
        }
    });

    it('supports disabling proxy trust', () => {
        const app = boot('false');
        expect(app.get('trust proxy')).to.equal(false);
        expect(app.get('trust proxy fn')('127.0.0.1', 0)).to.equal(false);
    });

    it('supports explicit hop counts', () => {
        const one = boot('1');
        expect(one.get('trust proxy')).to.equal(1);
        expect(one.get('trust proxy fn')('203.0.113.5', 0)).to.equal(true);
        expect(one.get('trust proxy fn')('203.0.113.5', 1)).to.equal(false);
        const zero = boot('0');
        expect(zero.get('trust proxy')).to.equal(0);
        expect(zero.get('trust proxy fn')('127.0.0.1', 0)).to.equal(false);
    });

    it('supports an explicit address range', () => {
        const trust = boot('10.0.0.0/8').get('trust proxy fn');
        expect(trust('10.9.9.9', 0)).to.equal(true);
        expect(trust('127.0.0.1', 0)).to.equal(false);
        expect(trust('172.17.0.1', 0)).to.equal(false);
    });

    it('warns at boot when trust-all leaves client addresses spoofable', () => {
        const app = boot('true');
        expect(app.get('trust proxy')).to.equal(true);
        expect(app.bootWarnings).to.have.length(1);
        expect(app.bootWarnings[0]).to.match(/HUB_TRUST_PROXY=true.*spoof.*bypass.*local-caller exemption/);
    });

    it('lets Express reject an invalid address setting', () => {
        expect(() => boot('not-an-ip')).to.throw(/invalid IP address/);
    });
});
