'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const fixturePath = path.resolve(__dirname, '../../fixtures/anchor_canonical_vectors.json');
const authorityPath = path.resolve(__dirname,
    '../../../../xchain-documentation/protocol/test-vectors/anchor_canonical.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('vendored anchor canonical vectors', function () {
    it('carries the archive-fold vector variants and fixtures', function () {
        expect(fixture.vectors.v3).to.be.a('string').and.not.empty;
        expect(fixture.vectors.v3_no_archive).to.be.a('string').and.not.empty;
        expect(fixture.fixture.bundle_v3).to.be.an('object');
        expect(fixture.fixture.bundle_v3_no_archive).to.be.an('object');
    });

    it('is byte-identical to the documentation authority when available', function () {
        if (!fs.existsSync(authorityPath)) this.skip();
        expect(fs.readFileSync(fixturePath)).to.deep.equal(fs.readFileSync(authorityPath));
    });
});
