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

// The two cadence knobs are fleet-uniform; a hub resolving non-canonical values
// must say so unless the skip variable is set.

const { expect } = require('chai');
const { assertCanonicalCadence, resolveCheckpointIntervalBlocks } =
    require('../../../src/anchor/checkpoint_cadence.js');

const ENV = ['CHECKPOINT_INTERVAL_BLOCKS', 'ANCHOR_CHECKPOINT_EVERY_N', 'XCHAIN_HUB_SKIP_ANCHOR_CADENCE_ASSERT'];

describe('checkpoint cadence canonical assertion', function () {
    let saved = {};
    beforeEach(function () {
        for (let k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        for (let k of ENV) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
    });

    it('reports nothing for the canonical 6 / 1', function () {
        expect(assertCanonicalCadence(6, 1)).to.deep.equal([]);
    });

    it('names each drifting knob', function () {
        expect(assertCanonicalCadence(12, 1)).to.deep.equal(['CHECKPOINT_INTERVAL_BLOCKS']);
        expect(assertCanonicalCadence(6, 3)).to.deep.equal(['ANCHOR_CHECKPOINT_EVERY_N']);
        expect(assertCanonicalCadence(7, 2)).to.deep.equal(['CHECKPOINT_INTERVAL_BLOCKS', 'ANCHOR_CHECKPOINT_EVERY_N']);
    });

    it('is silenced by XCHAIN_HUB_SKIP_ANCHOR_CADENCE_ASSERT=1', function () {
        process.env.XCHAIN_HUB_SKIP_ANCHOR_CADENCE_ASSERT = '1';
        expect(assertCanonicalCadence(12, 4)).to.deep.equal([]);
    });

    it('the shared resolver still returns the operator value and never throws on drift', function () {
        process.env.CHECKPOINT_INTERVAL_BLOCKS = '12';
        process.env.ANCHOR_CHECKPOINT_EVERY_N = '2';
        expect(resolveCheckpointIntervalBlocks({})).to.equal(12);
    });
});
