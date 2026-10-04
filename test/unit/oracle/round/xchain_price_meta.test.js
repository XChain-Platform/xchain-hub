'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const { expect } = require('chai');
const { formatXchainPriceMeta } = require('../../../../src/oracle/round/xchain_price_meta');

function formatsMissingMetadataTest() {
    expect(formatXchainPriceMeta(null)).to.equal('(no metadata)');
}

function formatsDerivedMetadataTest() {
    const meta = {
        derived: true,
        window: { fromBlockExclusive: 10, toBlockInclusive: 20 },
        usedFills: 5,
        clampedFills: 1,
        droppedFills: 2,
        btcVolume: 3,
        totalXchain: 99,
        rawXchainBtc: 0.1,
        xchainBtc: 0.2,
        refRate: 0.15
    };
    expect(formatXchainPriceMeta(meta)).to.equal(
        '(window (10, 20], 5 fills, 1 clamped, 2 excluded, vol 3 BTC / 99 XCHAIN, ' +
        'raw 0.1 -> published 0.2 BTC, ref 0.15)'
    );
}

function formatsCarryForwardMetadataTest() {
    const meta = { carriedFrom: 7, fillCount: 0, reason: 'quiet' };
    expect(formatXchainPriceMeta(meta)).to.equal(
        '(window (?, ?], carry-forward from 7, 0 fills in window, quiet)'
    );
}

function formatsDisabledVolumeThresholdTest() {
    const meta = {
        carriedFrom: 7,
        fillCount: 0,
        btcVolume: 1,
        minBtcVolume: null,
        wouldHaveBeen: 0.5
    };
    expect(formatXchainPriceMeta(meta)).to.equal(
        '(window (?, ?], carry-forward from 7, 0 fills in window, ' +
        'vol 1 BTC vs threshold DISABLED, would have been 0.5 BTC)'
    );
}

function formatsConfiguredVolumeThresholdTest() {
    const meta = {
        carriedFrom: 7,
        fillCount: 0,
        btcVolume: 1,
        minBtcVolume: 4,
        wouldHaveBeen: 0.5
    };
    expect(formatXchainPriceMeta(meta)).to.equal(
        '(window (?, ?], carry-forward from 7, 0 fills in window, ' +
        'vol 1 BTC vs threshold 4, would have been 0.5 BTC)'
    );
}

describe('formatXchainPriceMeta()', function () {
    it('formats missing metadata', formatsMissingMetadataTest);
    it('formats derived price metadata', formatsDerivedMetadataTest);
    it('formats carry-forward metadata without a window', formatsCarryForwardMetadataTest);
    it('shows a disabled carry-forward volume threshold', formatsDisabledVolumeThresholdTest);
    it('shows a configured carry-forward volume threshold', formatsConfiguredVolumeThresholdTest);
});
