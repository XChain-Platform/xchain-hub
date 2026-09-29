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
//
// The watcher must read exactly the stake set the STAKE_WEIGHTED_QUORUM gate
// reads, and refuse every read the gate refuses. Each case below is one of the
// gate's own checks; a watcher that re-implemented the read would pass none.

const { expect } = require('chai');

const { LEVELS } = require('../../../src/validators/stake_share_monitor.js');
const { makeVenue, makeWatcher } = require('../../helpers/stakeShareVenue.js');

async function pollEntry(venue, hubOpts) {
    const { watcher } = makeWatcher(venue, null, hubOpts);
    await watcher.pollOnce();
    return watcher.monitor.entries.get('BTC:price');
}

describe('StakeShareWatcher gate parity', function () {

    registerIndexerTests();
    registerThresholdTests();
    registerEchoTests();
    registerAlarmIsolationTests();
});

function registerIndexerTests() {

    describe('the indexer and its rows', function () {

        it('records unavailable, never a margin, when the BTC indexer serves another coin', async function () {
            const venue = makeVenue();
            const entry = await pollEntry(venue, { coinMismatch: true });
            expect(entry.level).to.equal(LEVELS.UNAVAILABLE);
            expect(entry.reason).to.contain('another coin');
            expect(venue.calls).to.have.length(0);
        });

        it('records unavailable when a row carries no weight', async function () {
            const entry = await pollEntry(makeVenue({ dropWeight: true }));
            expect(entry.level).to.equal(LEVELS.UNAVAILABLE);
        });
    });
}

function registerThresholdTests() {

    describe('the MIN_STAKE threshold', function () {

        it('falls back to the stake-weight feed floor when the registry has none', async function () {
            const venue = makeVenue();
            const entry = await pollEntry(venue, { minStake: null, feedMinStake: '25000' });
            const read = venue.calls.find(c => c.method === 'getstakeweightsbycapability');
            expect(read.params.min_stake).to.equal('25000');
            expect(entry.level).to.equal(LEVELS.WARNING);
        });

        it('records unavailable, and reads nothing, where the gate refuses for a missing MIN_STAKE', async function () {
            const venue = makeVenue();
            const entry = await pollEntry(venue, { minStake: null });
            expect(entry.level).to.equal(LEVELS.UNAVAILABLE);
            expect(entry.reason).to.contain('MIN_STAKE');
            expect(venue.calls.filter(c => c.method === 'getstakeweightsbycapability')).to.have.length(0);
        });
    });
}

function registerEchoTests() {

    describe('the block and capability echo', function () {

        it('records unavailable when the indexer answers for another block', async function () {
            const entry = await pollEntry(makeVenue({ echoBlock: 149000 }));
            expect(entry.level).to.equal(LEVELS.UNAVAILABLE);
            expect(entry.reason).to.contain('149000');
        });

        it('accepts a numerically equal string height', async function () {
            const entry = await pollEntry(makeVenue({ echoBlock: '149994' }));
            expect(entry.level).to.equal(LEVELS.WARNING);
            expect(entry.blockIndex).to.equal(149994);
        });

        it('records unavailable when the indexer answers for another capability', async function () {
            const entry = await pollEntry(makeVenue({ echoCapability: 'attestation' }));
            expect(entry.level).to.equal(LEVELS.UNAVAILABLE);
        });

        it('records unavailable when the indexer strips the capability echo', async function () {
            const entry = await pollEntry(makeVenue({ echoCapability: 'omit' }));
            expect(entry.level).to.equal(LEVELS.UNAVAILABLE);
        });
    });
}

function registerAlarmIsolationTests() {

    describe('the gate\'s consensus-input alarm', function () {

        it('stays untouched on a watcher success and a watcher failure', async function () {
            const venue = makeVenue();
            const { watcher, hub, lines } = makeWatcher(venue);
            await watcher.pollOnce();
            venue.echoBlock = 1;
            await watcher.pollOnce();
            expect(watcher.monitor.entries.get('BTC:price').level).to.equal(LEVELS.UNAVAILABLE);
            expect(hub.capabilitySnapshot.monitor.calls).to.equal(0);
            // Both outcomes landed on the watcher's private reader instead.
            expect(watcher.reader()).to.not.equal(hub.capabilitySnapshot);
            expect(watcher.reader().monitor.ok).to.equal(1);
            expect(watcher.reader().monitor.failures).to.equal(1);
            expect(lines.join('\n')).to.not.contain('CONSENSUS-INPUT FETCH FAILED');
        });
    });
}
