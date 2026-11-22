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
// Address and path spellings the per-IP limiters must not misread: ambiguous or
// junk addresses never earn the local-caller exemption, and a mixed-case snapshot
// path is charged once, by the snapshot limiter only.
const { expect } = require('chai');
const policy = require('../../../../src/api/rate_limit_policy.js');
const { isLocalCaller } = policy;

describe('isLocalCaller ambiguous spellings', function () {
    it('fails closed on zero-padded, IPv4-compatible and junk-suffixed spellings', function () {
        for (const bad of ['010.0.0.1', '::10.0.0.1', '::127.0.0.1', 'fe80:junk-x', 'fdffjunk:',
                           'fc00-junk:', 'febfzz:zz', '10.0.0.01', '127.00.0.1']) {
            expect(isLocalCaller(bad), bad).to.equal(false);
        }
    });
    it('still exempts genuine private spellings', function () {
        for (const ok of ['10.0.0.1', '127.0.0.1', '::1', '::ffff:10.0.0.1', 'fd00::1', 'fe80::1%eth0', '172.16.0.5']) {
            expect(isLocalCaller(ok), ok).to.equal(true);
        }
    });
});

describe('isSnapshotRequest case folding', function () {
    // Express matches routes case-insensitively, so a mixed-case snapshot path reaches the
    // snapshot limiter; the general limiter must skip it too or the request is charged twice.
    it('treats mixed-case snapshot paths as snapshot requests', function () {
        expect(policy.isSnapshotRequest({ originalUrl: '/HUB-DB/SNAPSHOT/oracle_prices?limit=1' })).to.equal(true);
        expect(policy.isSnapshotRequest({ originalUrl: '/Hub-Db/Snapshot/x' })).to.equal(true);
        expect(policy.isSnapshotRequest({ originalUrl: '/Hub-Db/Snapshot' })).to.equal(true);
    });
    it('keeps lowercase paths and the segment boundary', function () {
        expect(policy.isSnapshotRequest({ originalUrl: '/hub-db/snapshot/x' })).to.equal(true);
        expect(policy.isSnapshotRequest({ originalUrl: '/hub-db/snapshotx' })).to.equal(false);
        expect(policy.isSnapshotRequest({ originalUrl: '/HUB-DB/SNAPSHOTX' })).to.equal(false);
        expect(policy.isSnapshotRequest({ originalUrl: '/' })).to.equal(false);
    });
});
