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

function boot(raw, exemptLocal = true) {
    const app = express();
    const hubConfig = {};
    const warnings = [];
    const infos = [];
    if (raw !== undefined) hubConfig.HUB_TRUST_PROXY = raw;
    installTransportMiddleware(app, {
        hubConfig,
        logger: { info(message) { infos.push(message); }, warn(message) { warnings.push(message); } },
        express, helmet, cors, rateLimit,
        CORS_ORIGIN: '*',
        HUB_RATE_LIMIT_RPM: 100000,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: exemptLocal
    });
    app.bootWarnings = warnings;
    app.bootInfos = infos;
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

const LOCAL_TRUST_WARNING = /HUB_RATE_LIMIT_EXEMPT_LOCAL=false.*X-Forwarded-For.*HUB_TRUST_PROXY=false/;
const EVERY_CALLER = 'enforced for every caller';

// Each setting trusts at least one loopback or private-range peer; the witness is one
// such peer, so the case itself proves the warning is owed.
const LOCAL_TRUST_CASES = [
    [undefined, '172.17.0.1'], ['1', '127.0.0.1'], ['10.0.0.0/8', '10.9.9.9'],
    ['10.9.0.0/16', '10.9.1.1'], ['10.9.1.1', '10.9.1.1'], ['10.9.1.1/32', '10.9.1.1'],
    ['10.9.0.0/255.255.0.0', '10.9.1.1'], ['172.20.5.0/24', '172.20.5.9'],
    ['192.168.50.0/24', '192.168.50.7'], ['169.254.1.0/24', '169.254.1.2'],
    ['127.0.0.2', '127.0.0.2'], ['fd12:3456::/48', 'fd12:3456::9'], ['fe80::/64', 'fe80::2'],
    ['::ffff:10.9.0.0/112', '10.9.1.1'], ['::ffff:a09:0/112', '10.9.1.1'],
    ['203.0.113.5, 10.9.0.0/16', '10.9.1.1'], ['8.0.0.0/5', '10.0.0.1'],
    ['0.0.0.0/1', '127.0.0.1'], ['fc00::/6', 'fd00::1'], ['linklocal', '169.254.3.4']
];

describe('hub rate limit claim under the trust-proxy setting', () => {
    it('warns that a hop count lets any direct peer set the resolved client IP', () => {
        const app = boot('1', false);
        expect(app.get('trust proxy fn')('203.0.113.5', 0)).to.equal(true);
        expect(app.bootWarnings).to.have.length(1);
        expect(app.bootWarnings[0]).to.match(/numeric HUB_TRUST_PROXY.*any direct peer.*public peer/);
        expect(app.bootInfos.join('\n')).to.match(/numeric HUB_TRUST_PROXY.*any direct peer.*public peer/);
    });

    it('warns once and drops the every-caller claim whenever a local peer is a trusted proxy', () => {
        for (const [raw, witness] of LOCAL_TRUST_CASES) {
            const app = boot(raw, false);
            expect(app.get('trust proxy fn')(witness, 0), raw + ' trusts ' + witness).to.equal(true);
            expect(app.bootWarnings, String(raw)).to.have.length(1);
            expect(app.bootWarnings[0], String(raw)).to.match(LOCAL_TRUST_WARNING);
            expect(app.bootInfos.join('\n'), String(raw)).to.not.include(EVERY_CALLER);
        }
    });

    it('keeps the every-caller claim only when no peer is trusted', () => {
        for (const raw of ['false', '0']) {
            const app = boot(raw, false);
            expect(app.bootWarnings, raw).to.deep.equal([]);
            expect(app.bootInfos.join('\n'), raw).to.include(EVERY_CALLER);
        }
    });

    it('names the configured proxies when only public peers are trusted', () => {
        for (const raw of ['203.0.113.0/24', '2001:db8::/32, 198.51.100.7']) {
            const app = boot(raw, false);
            const trust = app.get('trust proxy fn');
            for (const addr of ['127.0.0.1', '::1', '10.9.1.1', '172.20.5.9', '192.168.1.1', 'fd00::1'])
                expect(trust(addr, 0), raw + ' / ' + addr).to.equal(false);
            expect(app.bootWarnings, raw).to.deep.equal([]);
            const info = app.bootInfos.join('\n');
            expect(info, raw).to.not.include(EVERY_CALLER);
            expect(info, raw).to.include('only the HUB_TRUST_PROXY peers set that IP');
        }
    });

    it('adds no second warning to the trust-all warning', () => {
        const app = boot('true', false);
        expect(app.bootWarnings).to.have.length(1);
        expect(app.bootWarnings[0]).to.match(/HUB_TRUST_PROXY=true/);
        expect(app.bootInfos.join('\n')).to.not.include(EVERY_CALLER);
    });

    it('stays silent while the local exemption is on', () => {
        const app = boot(undefined, true);
        expect(app.bootWarnings).to.deep.equal([]);
    });
});
