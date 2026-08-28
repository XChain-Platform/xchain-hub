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

// The publisher had no startup pass. Its only LEADER trigger was a
// setInterval at ANCHOR_INTERVAL_MS (24h), first firing a full interval after
// start, and the 15-minute rank wake runs failover-only, which skips every
// election this hub leads. A federation recreated more often than once a day
// therefore cut checkpoints on cadence and anchored none of them, silently:
// the two publish-decision skips in _publishPendingCheckpoints logged nothing,
// so getanchorstatus read active:true, anchorsPublished:0, balance healthy.
//
// These tests pin the three halves of the fix: start() schedules ONE normal
// flush after ANCHOR_STARTUP_FLUSH_MS (0 disables, stop() cancels it), the two
// silent skips now count into getAnchorStats, and a leader flush that walks
// candidates and publishes none says so once.

const { expect }           = require('chai');
const { waitUntil }        = require('../helpers/waitUntil');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');

const BLOCK  = 100;
const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: BLOCK, snapshot_block: BLOCK, state_root: null, block_merkle_root: null,
    anchor_txid: null
};

const ENV_KEYS = ['ANCHOR_STARTUP_FLUSH_MS', 'ANCHOR_INTERVAL_MS', 'ANCHOR_RANK_WAKE_MS'];

function buildPub() {
    let identity = new ValidatorIdentity('11'.repeat(32));
    let hub = {
        db: {
            async doQuery(sql) {
                if (sql.indexOf('FROM state_checkpoints') !== -1) return [CP_ROW];
                return [];
            }
        },
        network: 'regtest',
        capabilitySnapshot: null,
        capabilityRegistry: null,
        getIdentity:    () => identity,
        getPeerManager: () => ({ broadcast() {}, on() {}, removeListener() {} }),
        p2pConfig: {},
        rewardTracker: {
            anchorReward: '10.00000000',
            resolveSourceByPubkey: async (pk) => 'src_' + String(pk).toLowerCase().substring(0, 12)
        },
        _resolveBtcLatestBlock: async () => BLOCK
    };
    return { pub: new StateAnchorPublisher(hub), me: identity.getPubkeyHex().toLowerCase() };
}

// A pending v0 row with a two-member election set. `wantLeader` picks the peer
// that puts this hub at rank 0 or rank 1 in the real hash order.
function pendingRow(wantLeader) {
    let { pub, me } = buildPub();
    let key  = pub._v0ElectionKey(CP_ROW);
    let peer = null;
    for (let i = 0; i < 256 && peer === null; i++) {
        let candidate = String(20 + (i % 80)).repeat(32).slice(0, 64);
        if (candidate === me) continue;
        let order = StateAnchorPublisher.hashOrder(key, [me, candidate]);
        if ((order[0] === me) === !!wantLeader) peer = candidate;
    }
    expect(peer, 'a peer producing the requested rank must exist').to.not.equal(null);
    pub._getActiveOraclePublishPubkeys = async () => [me, peer];
    return { pub, me, peer };
}

function captureLog(fn) {
    let lines = [];
    let orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    return Promise.resolve().then(fn).finally(() => { console.log = orig; }).then(() => lines);
}

describe('StateAnchorPublisher: startup catch-up flush', function () {

    let saved;
    before(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    after(function () {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
    afterEach(function () { delete process.env.ANCHOR_STARTUP_FLUSH_MS; });

    describe('the knob', function () {
        it('defaults to one minute, well inside the interval it exists to cover for', function () {
            const { pub } = buildPub();
            expect(pub.startupFlushMs).to.equal(60000);
            expect(pub.startupFlushMs).to.be.below(pub.intervalMs);
        });
        it('is operator-tunable and 0 disables', function () {
            process.env.ANCHOR_STARTUP_FLUSH_MS = '5';
            expect(buildPub().pub.startupFlushMs).to.equal(5);
            process.env.ANCHOR_STARTUP_FLUSH_MS = '0';
            expect(buildPub().pub.startupFlushMs).to.equal(0);
        });
        it('garbage and negatives fall back to the default', function () {
            process.env.ANCHOR_STARTUP_FLUSH_MS = 'soon';
            expect(buildPub().pub.startupFlushMs).to.equal(60000);
            process.env.ANCHOR_STARTUP_FLUSH_MS = '-1';
            expect(buildPub().pub.startupFlushMs).to.equal(60000);
        });
    });

    describe('start() runs one NORMAL flush after the delay', function () {
        it('the flush fires once, not in failover-only mode', async function () {
            process.env.ANCHOR_STARTUP_FLUSH_MS = '5';
            const { pub } = buildPub();
            let calls = [];
            pub.flush = async (opts) => { calls.push(opts); return { anchored: [], archive: 'none' }; };
            await pub.start();
            expect(pub._startupTimer, 'a startup timer is armed').to.not.equal(null);
            await waitUntil(() => calls.length >= 1, { label: 'the startup flush fired' });
            expect(calls.length, 'exactly one startup flush').to.equal(1);
            expect(calls[0] && calls[0].failoverOnly, 'a leader flush, so a led election publishes').to.not.equal(true);
            expect(pub._startupTimer, 'the one-shot handle is released').to.equal(null);
            await pub.stop();
        });
        it('0 arms no startup timer, so the interval is the only leader cadence', async function () {
            process.env.ANCHOR_STARTUP_FLUSH_MS = '0';
            const { pub } = buildPub();
            let calls = 0;
            pub.flush = async () => { calls++; return { anchored: [], archive: 'none' }; };
            await pub.start();
            // No timer handle means nothing can fire later; no settle needed.
            expect(pub._startupTimer).to.equal(null);
            expect(calls).to.equal(0);
            await pub.stop();
        });
        it('stop() before the delay cancels it', async function () {
            process.env.ANCHOR_STARTUP_FLUSH_MS = '30';
            const { pub } = buildPub();
            let calls = 0;
            pub.flush = async () => { calls++; return { anchored: [], archive: 'none' }; };
            await pub.start();
            await pub.stop();
            // stop() clears the handle, so the armed callback can never run.
            expect(pub._startupTimer).to.equal(null);
            expect(calls, 'no flush after stop').to.equal(0);
        });
    });

    describe('the two silent stand-downs are now counted and, on a leader flush, said once', function () {
        it('a WAKE flush that skips a led row counts it as skippedLeaderOnWake and stays quiet', async function () {
            const { pub } = pendingRow(true);
            let lines = await captureLog(async () => {
                let anchored = await pub._publishPendingCheckpoints(null, BLOCK, true);
                expect(anchored).to.deep.equal([]);
            });
            expect(pub.getAnchorStats().skippedLeaderOnWake).to.equal(1);
            expect(pub.getAnchorStats().skippedNotOurElection).to.equal(0);
            expect(lines.filter(l => l.indexOf('nothing anchored by this hub') !== -1), 'the wake is the steady state; no line').to.have.length(0);
        });
        it('a LEADER flush on a row another hub leads counts skippedNotOurElection and logs once', async function () {
            const { pub } = pendingRow(false);
            let lines = await captureLog(async () => {
                let anchored = await pub._publishPendingCheckpoints(null, BLOCK, false);
                expect(anchored).to.deep.equal([]);
            });
            expect(pub.getAnchorStats().skippedNotOurElection).to.equal(1);
            expect(pub.getAnchorStats().skippedLeaderOnWake).to.equal(0);
            let said = lines.filter(l => l.indexOf('nothing anchored by this hub') !== -1);
            expect(said, 'one summary line for the whole flush').to.have.length(1);
            expect(said[0]).to.contain('1 pending checkpoint(s)');
        });
        it('the counters are reported by getAnchorStats alongside the knob', function () {
            const stats = buildPub().pub.getAnchorStats();
            expect(stats).to.include({ skippedNotOurElection: 0, skippedLeaderOnWake: 0, startupFlushMs: 60000 });
        });
    });
});
