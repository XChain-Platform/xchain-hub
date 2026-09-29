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
// A stand-in BTC indexer, hub and watcher for the StakeShareWatcher suites.
// The watcher reads through the gate's real CapabilitySnapshot, so these
// suites exercise the gate's own URL, threshold, row and echo checks.

const proxyquire = require('proxyquire');

const StakeShareWatcher = require('../../src/validators/stake_share_watcher.js');

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
        // Echo overrides: answer for a height or capability other than the one
        // asked for ('omit' strips the capability field), and weightless rows.
        echoBlock:      null,
        echoCapability: null,
        dropWeight:     false,
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
                let rows = stakeRows(venue.sources, venue.weight);
                if (venue.dropWeight) delete rows[0].weight;
                let result = {
                    capability:   venue.echoCapability === null ? body.params.capability : venue.echoCapability,
                    block_index:  venue.echoBlock === null ? body.params.block_index : venue.echoBlock,
                    count:        venue.sources.length,
                    source_count: venue.sources.length,
                    truncated:    venue.truncated,
                    validators:   rows
                };
                if (venue.echoCapability === 'omit') delete result.capability;
                return { data: { result: result } };
            }
            return { data: { result: {} } };
        }
    };
    Object.assign(venue, opts);
    return venue;
}

// The hub's own snapshot carries a counting monitor, so a test can prove the
// watcher never touches the consensus-input alarm the gate builds on.
function makeHub(venue, opts) {
    opts = opts || {};
    const gateMonitor = { calls: 0 };
    gateMonitor.recordFailure = () => { gateMonitor.calls++; };
    gateMonitor.recordSuccess = () => { gateMonitor.calls++; };
    const urlFor = (coin) => (opts.urls === undefined ? 'http://indexer/' + coin : opts.urls[coin] || null);
    return {
        network: 'regtest',
        capabilitySnapshot: {
            reorgBufferBlocks: opts.reorgBuffer === undefined ? 6 : opts.reorgBuffer,
            monitor:           gateMonitor
        },
        capabilityRegistry: opts.noRegistry ? null : {
            getMinStake: () => opts.minStake === undefined ? '25000' : opts.minStake
        },
        stakeWeightFeed: opts.feedMinStake === undefined ? null : { minStake: () => opts.feedMinStake },
        btcIndexerHeaders: () => ({ 'Content-Type': 'application/json', 'x-api-key': 'k' }),
        resolveIndexerUrl: async (coin) => urlFor(coin),
        // A coin mismatch is the one case where the raw lookup has a URL and the
        // coin-verified lookup the gate uses does not.
        resolveBtcIndexerUrl: async () => (opts.coinMismatch ? null : urlFor('BTC'))
    };
}

// The watcher reads through the gate's real CapabilitySnapshot, with this
// venue's indexer standing in for axios inside that module.
function snapshotClassFor(venue) {
    return proxyquire('../../src/validators/capability_snapshot', { axios: venue.axios });
}

function makeWatcher(venue, env, hubOpts, opts) {
    const lines = [];
    const hub = makeHub(venue, hubOpts);
    const watcher = new StakeShareWatcher(hub, Object.assign({
        env:    Object.assign({ HUB_OPERATOR_STAKE_SOURCES: OURS.join(',') }, env || {}),
        axios:  venue.axios,
        CapabilitySnapshot: snapshotClassFor(venue),
        log:    (m) => lines.push(m),
        chains: ['BTC'],
        capabilities: ['price']
    }, opts || {}));
    return { watcher, lines, hub };
}

module.exports = { OURS, stakeRows, makeVenue, makeHub, snapshotClassFor, makeWatcher };
