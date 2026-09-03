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

const StakeShareWatcher = require('../../src/StakeShareWatcher.js');
const { LEVELS } = require('../../src/lib/stake_share_monitor.js');

const OURS = ['ours1', 'ours2', 'ours3', 'ours4', 'ours5'];

function stakeRows(sources, weight) {
    return sources.map((s, i) => ({ pubkey: 'pk' + i, source: s, weight: String(weight) }));
}

// A stand-in indexer whose stake set the test can mutate between polls, which is
// exactly what a real drill does by broadcasting a competing STAKE.
function makeVenue(opts) {
    opts = opts || {};
    const venue = {
        tip:        150000,
        sources:    OURS.concat(['community1']),
        weight:     25000,
        truncated:  false,
        error:      null,
        throwOn:    null,          // 'getlatestblock' | 'getstakeweightsbycapability'
        httpStatus: null,
        calls:      []
    };
    venue.axios = {
        post: async (url, body) => {
            venue.calls.push({ url, method: body.method, params: body.params });
            if (venue.throwOn === body.method) {
                const err = new Error('boom');
                if (venue.httpStatus) err.response = { status: venue.httpStatus };
                throw err;
            }
            if (body.method === 'getlatestblock') return { data: { result: { block_index: venue.tip } } };
            if (body.method === 'getstakeweightsbycapability') {
                if (venue.error) return { data: { result: { error: venue.error } } };
                return { data: { result: {
                    capability:   body.params.capability,
                    block_index:  body.params.block_index,
                    count:        venue.sources.length,
                    source_count: venue.sources.length,
                    truncated:    venue.truncated,
                    validators:   stakeRows(venue.sources, venue.weight)
                } } };
            }
            return { data: { result: {} } };
        }
    };
    Object.assign(venue, opts);
    return venue;
}

function makeHub(venue, opts) {
    opts = opts || {};
    return {
        capabilitySnapshot: { reorgBufferBlocks: opts.reorgBuffer === undefined ? 6 : opts.reorgBuffer },
        capabilityRegistry: opts.noRegistry ? null : {
            getMinStake: () => opts.minStake === undefined ? '25000' : opts.minStake
        },
        _btcIndexerHeaders: () => ({ 'Content-Type': 'application/json', 'x-api-key': 'k' }),
        _resolveIndexerUrl: async (coin) => (opts.urls === undefined ? 'http://indexer/' + coin : opts.urls[coin] || null)
    };
}

function makeWatcher(venue, env, hubOpts, opts) {
    const lines = [];
    const hub = makeHub(venue, hubOpts);
    const watcher = new StakeShareWatcher(hub, Object.assign({
        env:    Object.assign({ HUB_OPERATOR_STAKE_SOURCES: OURS.join(',') }, env || {}),
        axios:  venue.axios,
        log:    (m) => lines.push(m),
        chains: ['BTC'],
        capabilities: ['price']
    }, opts || {}));
    return { watcher, lines, hub };
}

describe('StakeShareWatcher', function () {

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
    });

    describe('per chain', function () {

        it('watches every configured chain and capability separately', async function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, null, null,
                { chains: ['BTC', 'DOGE'], capabilities: ['price', 'oracle_publish'] });
            await watcher.pollOnce();
            const stats = watcher.getStats();
            expect(Object.keys(stats.chains).sort()).to.deep.equal(['BTC', 'DOGE']);
            expect(Object.keys(stats.chains.BTC).sort()).to.deep.equal(['oracle_publish', 'price']);
            expect(stats.watched_chains).to.deep.equal(['BTC', 'DOGE']);
        });

        it('scopes operator sources per chain, because staking addresses are chain-specific', function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, {
                HUB_OPERATOR_STAKE_SOURCES: '',
                HUB_OPERATOR_STAKE_SOURCES_BTC: 'btc1, btc2',
                HUB_OPERATOR_STAKE_SOURCES_DOGE: 'doge1'
            }, null, { chains: ['BTC', 'DOGE', 'LTC'] });
            expect(watcher.operatorSourcesFor('BTC')).to.deep.equal(['btc1', 'btc2']);
            expect(watcher.operatorSourcesFor('DOGE')).to.deep.equal(['doge1']);
            expect(watcher.operatorSourcesFor('LTC')).to.deep.equal([]);
        });

        it('skips a chain this operator does not stake on rather than filing a finding', async function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, {
                HUB_OPERATOR_STAKE_SOURCES: '',
                HUB_OPERATOR_STAKE_SOURCES_BTC: OURS.join(',')
            }, null, { chains: ['BTC', 'LTC'] });
            await watcher.pollOnce();
            expect(Object.keys(watcher.getStats().chains)).to.deep.equal(['BTC']);
        });
    });

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
            expect(watcher.chains).to.deep.equal(['DOGE']);
            expect(watcher.capabilities).to.deep.equal(['price']);
        });

        it('defaults to every registered coin and the price rails', function () {
            const venue = makeVenue();
            const { watcher } = makeWatcher(venue, null, null, { chains: null, capabilities: null });
            expect(watcher.chains).to.deep.equal(['BTC', 'LTC', 'DOGE']);
            expect(watcher.capabilities).to.deep.equal(['price', 'oracle_publish']);
            expect(watcher.pollMs).to.equal(StakeShareWatcher.DEFAULT_POLL_MS);
        });
    });
});
