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
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const fixturePath = path.resolve(__dirname, '../../fixtures/checkpoint_canonical_vectors.json');
const authorityPath = path.resolve(__dirname,
    '../../../../xchain-documentation/protocol/test-vectors/checkpoint_canonical.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('vendored checkpoint canonical vectors', function () {
    it('carries named expected or throwing cases', function () {
        expect(fixture.cases).to.be.an('array').and.not.empty;
        for (const vector of fixture.cases) {
            expect(vector.name).to.be.a('string').and.not.empty;
            expect(typeof vector.expected === 'string' || Object.hasOwn(vector, 'throws')).to.equal(true);
        }
    });

    it('is byte-identical to the documentation authority when available', function () {
        const verdict = siblingCheckout(__dirname, authorityPath);
        if (!verdict.usable) return skipOrFail(this, verdict, 'the hub checkpoint canonical vectors byte-identity guard');
        expect(fs.readFileSync(fixturePath)).to.deep.equal(fs.readFileSync(authorityPath));
    });
});
