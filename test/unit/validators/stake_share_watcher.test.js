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
// The drill this file is built around is the one operators need: a competing
// stake appears, and the alert must rise from that alone, with the
// weighted commit gate still met and no round having failed. That is the signal
// a prior outage did not have; there, the first evidence was a tester reporting that
// prices had been dead for 18 hours.

const { expect } = require('chai');

const StakeShareWatcher = require('../../../src/validators/stake_share_watcher.js');
const { LEVELS } = require('../../../src/validators/stake_share_monitor.js');
const { OURS, makeVenue, makeWatcher } = require('../../helpers/stakeShareVenue.js');
const proxyquire = require('proxyquire');

// The real CapabilitySnapshot over the venue's indexer, with the canonical buffer stubbed.
function snapshotClassWithCanonical(venue, canonical) {
    const bootSettings = proxyquire('../../../src/validators/capability_snapshot/boot_settings.js',
        { '../../consensus/snapshot_reorg_buffer.js': { CANONICAL_REORG_BUFFER: canonical } });
    return proxyquire('../../../src/validators/capability_snapshot',
        { axios: venue.axios, './capability_snapshot/boot_settings.js': bootSettings });
}

describe('StakeShareWatcher', function () {

    registerStakeShareDrillTests();
    registerStakeShareReadTests();
    registerStakeShareBufferFallbackTests();
    registerStakeShareChainTests();
    registerStakeShareFailureTests();
    registerStakeShareLifecycleTests();
    registerStakeShareDefaultCapabilityTests();
});

function registerStakeShareDefaultCapabilityTests() {
    it('watches by default every capability whose rounds lock a weighted snapshot', function () {
        // A capability added to the snapshot writers but not here would halt with no forecast.
        const { DERIVED_CAPABILITIES } = require('../../../src/oracle/price_aggregator/derived_capabilities.js');
        expect(DERIVED_CAPABILITIES.length).to.be.above(0);
        expect(StakeShareWatcher.DEFAULT_CAPABILITIES.slice().sort())
            .to.deep.equal(DERIVED_CAPABILITIES.slice().sort());
    });
}

function registerStakeShareDrillTests() {

    describe('the drill: a competing stake raises the alert before any round fails', function () {

        it('goes from a quiet WARNING to an alerting CRITICAL on one new community stake', async function () {
            // Five operator stakes and one community stake: 125000 of 150000.
            const venue = makeVenue();
            const { watcher, lines } = makeWatcher(venue);

            await watcher.pollOnce();
            let entry = watcher.monitor.entries.get('BTC:price');
            expect(entry.level).to.equal(LEVELS.WARNING);
            expect(entry.meetsGate).to.equal(true);
            expect(entry.headroom).to.equal('37500');
            expect(entry.stakesToHalt).to.equal(2);
            expect(watcher.monitor.isAlerting()).to.equal(false);

            // The drill: someone else stakes. No round has failed; the gate is
            // still met; nothing in the oracle path has moved at all.
            venue.sources = venue.sources.concat(['community2']);
            await watcher.pollOnce();

            entry = watcher.monitor.entries.get('BTC:price');
            expect(entry.meetsGate).to.equal(true);        // rounds are still finalizing
            expect(entry.level).to.equal(LEVELS.CRITICAL);
            expect(entry.stakesToHalt).to.equal(1);
            expect(watcher.monitor.isAlerting()).to.equal(true);
            expect(lines.join('\n')).to.contain('STAKE SHARE CRITICAL [BTC/price]');
        });

        it('reports HALTED with the exact top-up once the gate is actually lost', async function () {
            const venue = makeVenue({ sources: OURS.concat(['c1', 'c2', 'c3']) });
            const { watcher } = makeWatcher(venue);
            await watcher.pollOnce();
            const entry = watcher.monitor.entries.get('BTC:price');
            expect(entry.level).to.equal(LEVELS.HALTED);
            expect(entry.meetsGate).to.equal(false);
            expect(entry.totalStake).to.equal('200000');
            expect(entry.operatorStake).to.equal('125000');
            expect(entry.headroom).to.equal('-12500');
        });

        it('clears the alert when the operator tops up', async function () {
            const venue = makeVenue({ sources: OURS.concat(['c1', 'c2']) });
            const { watcher, lines } = makeWatcher(venue);
            await watcher.pollOnce();
            expect(watcher.monitor.isAlerting()).to.equal(true);

            // Two more operator sources' worth of stake lands.
            venue.sources = OURS.concat(['ours6', 'ours7', 'c1', 'c2']);
            const env = { HUB_OPERATOR_STAKE_SOURCES: OURS.concat(['ours6', 'ours7']).join(',') };
            watcher.env = Object.assign(watcher.env, env);
            await watcher.pollOnce();

            expect(watcher.monitor.isAlerting()).to.equal(false);
            expect(lines.join('\n')).to.contain('STAKE SHARE ALERT CLEARED');
        });
    });
}

function registerStakeShareReadTests() {

    describe('reading the same set the gate reads', function () {

        it('asks the chain indexer at the buried height, with the registry MIN_STAKE', async function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue);
            await watcher.pollOnce();
            const read = venue.calls.find(c => c.method === 'getstakeweightsbycapability');
            expect(read.url).to.equal('http://indexer/BTC');
            expect(read.params).to.deep.equal({ capability: 'price', block_index: 149994, min_stake: '25000' });
        });

        it('never asks below block 0 on a short chain', async function () {
            const venue = makeVenue({ tip: 2 });
            const { watcher } = makeWatcher(venue);
            await watcher.pollOnce();
            const read = venue.calls.find(c => c.method === 'getstakeweightsbycapability');
            expect(read.params.block_index).to.equal(0);
        });

        it('omits min_stake when no capability registry is live', async function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, null, { noRegistry: true });
            await watcher.pollOnce();
            const read = venue.calls.find(c => c.method === 'getstakeweightsbycapability');
            expect(read.params).to.not.have.property('min_stake');
            // The margin is then sized off the largest third-party stake present.
            expect(watcher.monitor.entries.get('BTC:price').unitStakeFrom).to.equal('largest_other_source');
        });

        it('refuses a truncated snapshot the way the quorum predicate refuses it', async function () {
            const venue = makeVenue({ truncated: true });
            const { watcher } = makeWatcher(venue);
            await watcher.pollOnce();
            const entry = watcher.monitor.entries.get('BTC:price');
            expect(entry.level).to.equal(LEVELS.BLOCKED);
            expect(watcher.monitor.isAlerting()).to.equal(true);
        });

        it('buries by the gate\'s live reorg buffer, not a default of its own', async function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, null, { reorgBuffer: 3 });
            await watcher.pollOnce();
            const read = venue.calls.find(c => c.method === 'getstakeweightsbycapability');
            expect(read.params.block_index).to.equal(149997);
        });

        it('labels the reading with the height the indexer answered for', async function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue);
            await watcher.pollOnce();
            expect(watcher.monitor.entries.get('BTC:price').blockIndex).to.equal(149994);
        });
    });
}

function registerStakeShareBufferFallbackTests() {

    describe('burying with no usable live buffer', function () {

        // A stand-in canonical of 4 (not today's 6) so a copied literal cannot pass.
        for (const [label, mutate] of [
            ['the hub has no snapshot', (hub) => { delete hub.capabilitySnapshot; }],
            ['the live buffer is null', (hub) => { hub.capabilitySnapshot.reorgBufferBlocks = null; }]
        ]) {
            it('falls back to CANONICAL_REORG_BUFFER when ' + label, async function () {
                const saved = process.env.HUB_SNAPSHOT_REORG_BUFFER;
                delete process.env.HUB_SNAPSHOT_REORG_BUFFER;
                try {
                    const venue = makeVenue();
                    const { watcher, hub } = makeWatcher(venue, null, null,
                        { CapabilitySnapshot: snapshotClassWithCanonical(venue, 4) });
                    mutate(hub);
                    await watcher.pollOnce();
                    const read = venue.calls.find(c => c.method === 'getstakeweightsbycapability');
                    expect(read.params.block_index).to.equal(149996);
                } finally {
                    if (saved === undefined) delete process.env.HUB_SNAPSHOT_REORG_BUFFER;
                    else process.env.HUB_SNAPSHOT_REORG_BUFFER = saved;
                }
            });
        }
    });
}

function registerStakeShareChainTests() {

    describe('BTC only, because capability staking is BTC-only', function () {

        it('watches the BTC set alone and says once which named chains it dropped', async function () {
            const venue = makeVenue();
            const { watcher, lines } = makeWatcher(venue, null, null,
                { chains: ['BTC', 'DOGE'], capabilities: ['price', 'oracle_publish'] });
            await watcher.pollOnce();
            const stats = watcher.getStats();
            expect(Object.keys(stats.chains)).to.deep.equal(['BTC']);
            expect(Object.keys(stats.chains.BTC).sort()).to.deep.equal(['oracle_publish', 'price']);
            expect(stats.watched_chains).to.deep.equal(['BTC']);
            expect(venue.calls.every(c => c.url === 'http://indexer/BTC')).to.equal(true);
            expect(lines.filter(l => l.indexOf('DOGE') !== -1)).to.have.length(1);
        });

        it('reads BTC operator sources from the scoped and the bare lists', function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, {
                HUB_OPERATOR_STAKE_SOURCES: 'shared1',
                HUB_OPERATOR_STAKE_SOURCES_BTC: 'btc1, btc2'
            });
            expect(watcher.operatorSourcesFor('BTC')).to.deep.equal(['btc1', 'btc2', 'shared1']);
        });

        it('ignores sources scoped to another chain, and is unconfigured with only those', function () {
            const venue = makeVenue();
            const { watcher, lines } = makeWatcher(venue, {
                HUB_OPERATOR_STAKE_SOURCES: '',
                HUB_OPERATOR_STAKE_SOURCES_DOGE: 'doge1'
            });
            expect(watcher.isConfigured()).to.equal(false);
            expect(lines.join('\n')).to.contain('HUB_OPERATOR_STAKE_SOURCES_DOGE');
        });
    });
}

function registerStakeShareFailureTests() {

    describe('when the read fails', function () {

        it('records unavailable, not a lost gate, when no indexer URL resolves', async function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, null, { urls: {} });
            await watcher.pollOnce();
            const entry = watcher.monitor.entries.get('BTC:price');
            expect(entry.level).to.equal(LEVELS.UNAVAILABLE);
            expect(entry.reason).to.contain('BTC_INDEXER_API_URL');
            expect(watcher.monitor.isAlerting()).to.equal(false);
        });

        it('names an auth mismatch rather than calling it a dead indexer', async function () {
            const venue = makeVenue({ throwOn: 'getstakeweightsbycapability', httpStatus: 403 });
            const { watcher } = makeWatcher(venue);
            await watcher.pollOnce();
            expect(watcher.monitor.entries.get('BTC:price').reason).to.contain('BTC_INDEXER_API_KEY');
        });

        it('records unavailable when the tip cannot be read', async function () {
            const venue = makeVenue({ throwOn: 'getlatestblock' });
            const { watcher } = makeWatcher(venue);
            await watcher.pollOnce();
            expect(watcher.monitor.entries.get('BTC:price').level).to.equal(LEVELS.UNAVAILABLE);
        });

        it('records unavailable on a JSON-RPC error from the stake read', async function () {
            const venue = makeVenue({ error: 'capability not configured: price' });
            const { watcher } = makeWatcher(venue);
            await watcher.pollOnce();
            const entry = watcher.monitor.entries.get('BTC:price');
            expect(entry.level).to.equal(LEVELS.UNAVAILABLE);
            expect(entry.reason).to.contain('capability not configured');
        });
    });
}

function registerStakeShareLifecycleTests() {

    describe('lifecycle', function () {

        it('refuses to start with no operator sources, and says why', function () {
            const venue = makeVenue();
            const { watcher, lines } = makeWatcher(venue, { HUB_OPERATOR_STAKE_SOURCES: '' });
            expect(watcher.isConfigured()).to.equal(false);
            expect(watcher.start()).to.equal(false);
            expect(lines[0]).to.contain('Stake-share monitor DISABLED');
            expect(lines[0]).to.contain('HUB_OPERATOR_STAKE_SOURCES');
            watcher.stop();
        });

        it('starts a single timer and stops it cleanly', function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, null, null, { pollMs: 60000 });
            expect(watcher.start()).to.equal(true);
            expect(watcher.start()).to.equal(false);     // idempotent
            expect(watcher._timer).to.not.equal(null);
            watcher.stop();
            expect(watcher._timer).to.equal(null);
        });

        it('skips an overlapping pass instead of stacking them on a slow indexer', async function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue);
            const first  = watcher.pollOnce();
            const second = watcher.pollOnce();
            expect(await second).to.equal(false);
            expect(await first).to.equal(true);
            expect(watcher.passes).to.equal(1);
        });

        it('reads its cadence and margins from the environment', function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, {
                HUB_STAKE_SHARE_POLL_MS: '90000',
                HUB_STAKE_SHARE_WARN_STAKES: '5',
                HUB_STAKE_SHARE_CRITICAL_STAKES: '3',
                HUB_STAKE_SHARE_CHAINS: 'doge',
                HUB_STAKE_SHARE_CAPABILITIES: 'price'
            }, null, { chains: null, capabilities: null, pollMs: undefined });
            expect(watcher.pollMs).to.equal(90000);
            expect(watcher.warnAtStakes).to.equal(5);
            expect(watcher.criticalAtStakes).to.equal(3);
            expect(watcher.chains).to.deep.equal(['BTC']);
            expect(watcher.capabilities).to.deep.equal(['price']);
        });

        it('defaults to the BTC stake set and every weighted-gate rail', function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, null, null, { chains: null, capabilities: null });
            expect(watcher.chains).to.deep.equal(['BTC']);
            expect(watcher.capabilities).to.deep.equal(['price', 'oracle_publish', 'attestation', 'cross_chain']);
            expect(watcher.pollMs).to.equal(StakeShareWatcher.DEFAULT_POLL_MS);
        });
    });
}
