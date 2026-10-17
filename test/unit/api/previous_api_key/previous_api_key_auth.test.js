'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { authGate } = require('../../../../src/api/auth_gate.js');

const NEW_KEY = 'new-key-value';
const OLD_KEY = 'old-key-value';

function authContext(logs, overrides) {
    const log = (m) => logs.push(String(m));
    return Object.assign({
        HUB_API_KEY: NEW_KEY,
        HUB_API_KEY_PREVIOUS: OLD_KEY,
        HUB_FEED_API_KEY: '',
        HUB_REORG_API_KEY: '',
        HUB_CONFIG_SECRETS_API_KEY: '',
        WRITE_METHODS: new Set(['pushchaintip']),
        REORG_WRITE_METHODS: new Set(),
        SENSITIVE_READ_METHODS: new Set(),
        SENSITIVE_READ_AUTH: true,
        logger: { info: log, warn: log, debug: log, error: log }
    }, overrides || {});
}

function drive(ctx, key) {
    let nexted = false;
    const res = { status() { return this; }, json() { return this; } };
    const req = { body: { method: 'pushchaintip', id: 1 }, headers: key ? { 'x-api-key': key } : {} };
    authGate(ctx)(req, res, () => { nexted = true; });
    return nexted;
}

describe('HUB_API_KEY_PREVIOUS bulk-tier rotation', function () {
    it('accepts both the current and the previous key', function () {
        const ctx = authContext([]);
        expect(drive(ctx, NEW_KEY)).to.equal(true);
        expect(drive(ctx, OLD_KEY)).to.equal(true);
    });

    it('refuses an unknown or missing key', function () {
        const ctx = authContext([]);
        expect(drive(ctx, 'bad-key')).to.equal(false);
        expect(drive(ctx)).to.equal(false);
    });

    it('refuses the old key once HUB_API_KEY_PREVIOUS is unset', function () {
        const ctx = authContext([], { HUB_API_KEY_PREVIOUS: '' });
        expect(drive(ctx, OLD_KEY)).to.equal(false);
        expect(drive(ctx, NEW_KEY)).to.equal(true);
    });

    it('debug-logs the variable name and never a key value', function () {
        const logs = [];
        const ctx = authContext(logs);
        drive(ctx, OLD_KEY);
        drive(ctx, NEW_KEY);
        expect(logs.some(l => /HUB_API_KEY_PREVIOUS/.test(l))).to.equal(true);
        expect(logs.some(l => l.includes(OLD_KEY) || l.includes(NEW_KEY))).to.equal(false);
    });
});
