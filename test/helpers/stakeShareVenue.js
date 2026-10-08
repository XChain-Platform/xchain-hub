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
const ChainTips = require('../../src/hub/chain_tips.js');

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
        lag:        0,             // getlatestblock's `lag`, which the gate's tip resolver bounds; null omits it
        sources:    OURS.concat(['community1']),
        allSources: null,          // the whole-federation set; null reuses `sources`
        weight:     25000,
        truncated:  false,
        error:      null,
        throwOn:    null,          // an RPC method name to fail
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
            if (body.method === 'getlatestblock') {
                return { data: { result: venue.lag === null ? { block_index: venue.tip }
                    : { block_index: venue.tip, lag: venue.lag } } };
            }
            if (body.method === 'getstakeweightsbycapability') return stakeAnswer(venue, body, venue.sources);
            if (body.method === 'getactivestakeweights') return stakeAnswer(venue, body, venue.allSources || venue.sources);
            return { data: { result: {} } };
        }
    };
    Object.assign(venue, opts);
    return venue;
}

// One stake-weight answer over `sources`, echoing what was asked unless the venue overrides it.
function stakeAnswer(venue, body, sources) {
    if (venue.error) return { data: { result: { error: venue.error } } };
    let rows = stakeRows(sources, venue.weight);
    if (venue.dropWeight) delete rows[0].weight;
    let result = {
        capability:   venue.echoCapability === null ? body.params.capability : venue.echoCapability,
        block_index:  venue.echoBlock === null ? body.params.block_index : venue.echoBlock,
        count:        sources.length,
        source_count: sources.length,
        truncated:    venue.truncated,
        validators:   rows
    };
    if (venue.echoCapability === 'omit' || result.capability === undefined) delete result.capability;
    return { data: { result: result } };
}

// The gate's real tip resolver, reading the venue's indexer and an optional pushed tip.
function bindTipResolver(hub, venue, opts) {
    if (opts.noTipResolver) return hub;
    hub.db = { getChainTip: async () => opts.pushedTip || null };
    hub.resolveBtcNetwork = async () => 'regtest';
    for (const m of ['resolveBtcLatestBlock', 'btcPushedTipFresh', 'btcDirectTipAcceptable'])
        hub[m] = ChainTips.prototype[m];
    return hub;
}

// The hub's own snapshot carries a counting monitor, so a test can prove the
// watcher never touches the consensus-input alarm the gate builds on.
function makeHub(venue, opts) {
    opts = opts || {};
    const gateMonitor = { calls: 0 };
    gateMonitor.recordFailure = () => { gateMonitor.calls++; };
    gateMonitor.recordSuccess = () => { gateMonitor.calls++; };
    const urlFor = (coin) => (opts.urls === undefined ? 'http://indexer/' + coin : opts.urls[coin] || null);
    // The resolver posts through axiosFor(hub), which reads the hub class's modules.
    class HubStub { static get modules() { return { axios: venue.axios }; } }
    return bindTipResolver(Object.assign(new HubStub(), {
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
    }), venue, opts);
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
        CapabilitySnapshot: snapshotClassFor(venue),
        log:    (m) => lines.push(m),
        chains: ['BTC'],
        capabilities: ['price']
    }, opts || {}));
    return { watcher, lines, hub };
}

module.exports = { OURS, stakeRows, makeVenue, makeHub, snapshotClassFor, makeWatcher };
