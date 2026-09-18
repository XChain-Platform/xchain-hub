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
// The per-table per-chain admission HEIGHT watermark: the bounded
// advance rule, the round-abandon timeout that bounds its trail, the anchor rail's
// queue-drain cap, the relay republish rule, the durable floor, the late-finalization
// refusal and the frame shape on both WS carriers.
//
// Every case drives wall clock explicitly rather than sleeping: the whole rule is a
// statement about how long ago an observation was made, so an injected instant is the
// only way to assert the boundary rather than a neighbourhood of it.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const HubDbBroadcaster = proxyquire('../../../../src/peers/hub_db_broadcaster.js', { ws: { OPEN: 1 } });
const { AdmissionHeightWatermark } = HubDbBroadcaster;
const StateAnchorPublisher = require('../../../../src/anchor/publisher.js');
const Database             = require('../../../../src/db');
const { admitMarginBlocks } = require('../../../../src/consensus/gates/mirror_admission_gate.js');

// Short, distinct windows per rail so "which rail settled" is observable without
// waiting out a production timeout. The xdex window is the longest in production too
// (a view change re-arms a round's timeout), so the ordering under test is the real one.
const WINDOWS = {
    XDEX_ROUND_MAX_LIFETIME_MS:           400000,
    ATTESTATION_ROUND_TIMEOUT_MS:         100000,
    ANCHOR_ROUND_TIMEOUT_MS:              100000,
    ORACLE_ROUND_INTERVAL:                200000,
    ADMISSION_ORACLE_INGEST_WINDOW_MS:    200000,
};

// process.env beats the config object in every knob this class resolves, so a stray
// XDEX_ROUND_TIMEOUT_MS in the environment would silently resize the windows under test.
function withCleanEnv(fn) {
    const keys = ['XDEX_ROUND_TIMEOUT_MS', 'XDEX_ROUND_MAX_LIFETIME_MS', 'ATTESTATION_ROUND_TIMEOUT_MS',
                  'ANCHOR_ROUND_TIMEOUT_MS', 'ORACLE_ROUND_INTERVAL', 'ADMISSION_ORACLE_INGEST_WINDOW_MS',
                  'HUB_ADMISSION_RELAY'];
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    try { return fn(); }
    finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function makeWatermark(extra) {
    return withCleanEnv(() => new AdmissionHeightWatermark(Object.assign({}, WINDOWS, extra || {})));
}

const T0 = 1_700_000_000_000;

function registerBoundedAdvanceEdgeTests() {
it('does NOT refresh a frozen tip, so the claim stops advancing with the chain', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        // The same height arriving again and again is a decoder that has not moved. Its age
        // is what dates the claim, so a refresh here would let the watermark keep claiming.
        for (let i = 1; i <= 20; i++) expect(w.observeTip('BTC', 900000, T0 + i * 100000)).to.equal(false);
        expect(w.heights(T0 + 20 * 100000).cross_chain_matches).to.deep.equal({ BTC: 899999 });
    });

    it('ignores a tip that is not a number, rather than reading it as height zero', function () {
        let w = makeWatermark();
        // Number(null), Number('') and Number(false) are all 0, a finite non-negative
        // integer. A coercing observer would claim height -1 ... 0 here and the entry would
        // exist at all, which is the guess the whole rule refuses.
        for (const bad of [null, undefined, '', '900000', NaN, Infinity, -1, 1.5, false, {}])
            expect(w.observeTip('BTC', bad, T0), JSON.stringify(String(bad))).to.equal(false);
        expect(w.heights(T0 + 1000000)).to.deep.equal({});
    });

    it('refuses a chain code outside the closed vocabulary', function () {
        let w = makeWatermark();
        expect(w.observeTip('bt c', 900000, T0)).to.equal(false);
        expect(w.observeTip(null, 900000, T0)).to.equal(false);
        // lower case normalises, because that is how the rest of the admission path spells it
        expect(w.observeTip('btc', 900000, T0)).to.equal(true);
        expect(w.heights(T0 + 400000).cross_chain_matches).to.deep.equal({ BTC: 899999 });
    });

    it('keeps a BTC-only rail BTC-only even with other chains observed', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        w.observeTip('LTC', 2900000, T0);
        w.observeTip('DOGE', 5900000, T0);
        let h = w.heights(T0 + 400000);
        expect(Object.keys(h.attestation_responses)).to.deep.equal(['BTC']);
        expect(Object.keys(h.anchor_reward_attestations)).to.deep.equal(['BTC']);
        expect(h.cross_chain_matches).to.deep.equal({ BTC: 899999, LTC: 2899999, DOGE: 5899999 });
    });

    it('publishes per chain, so one chain with no observation leaves the others claiming', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        w.observeTip('DOGE', 5900000, T0);
        let h = w.heights(T0 + 400000);
        expect(h.cross_chain_matches).to.deep.equal({ BTC: 899999, DOGE: 5899999 });
        expect(h.cross_chain_matches).to.not.have.property('LTC');
    });
}

function registerBoundedAdvanceCoreTests() {
it('publishes NOTHING before any tip observation', function () {
        let w = makeWatermark();
        expect(w.heights(T0)).to.deep.equal({});
    });

    it('publishes nothing while the only observation is younger than the rail window', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        // One millisecond short of the shortest window (the attest rail's 100000 ms).
        expect(w.heights(T0 + 99999)).to.deep.equal({});
    });

    it('publishes tip MINUS ONE once the observation is exactly one window old', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        let h = w.heights(T0 + 100000);
        // The observation proves the tip was at or below 899999 before it was recorded; that
        // is the claim, and 900000 itself is never claimed from this one observation.
        expect(h.attestation_responses).to.deep.equal({ BTC: 899999 });
        expect(h.anchor_reward_attestations).to.deep.equal({ BTC: 899999 });
    });

    it('settles each rail on ITS OWN round window, so a short rail leads a long one', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        let mid = w.heights(T0 + 250000);   // past attest (100000) and oracle (200000), short of xdex (400000)
        expect(mid).to.have.property('attestation_responses');
        expect(mid).to.have.property('oracle_prices');
        expect(mid).to.have.property('price_snapshots');
        expect(mid).to.not.have.property('cross_chain_matches');
        expect(mid).to.not.have.property('cross_chain_calls');
        expect(mid).to.not.have.property('bridge_transfers');
        expect(mid).to.not.have.property('policy_snapshots');

        let late = w.heights(T0 + 400000);
        expect(late.cross_chain_matches).to.deep.equal({ BTC: 899999 });
        expect(late.policy_snapshots).to.deep.equal({ BTC: 899999 });
    });

    it('trails the observed tip by the blocks one window mines, plus one', function () {
        let w = makeWatermark();
        // BTC at 600 s a block. The xdex window is 400000 ms, which spans ceil(400/600) = 1
        // block, and the claim is one below the settled height, so the trail is exactly two
        // blocks: the blocks one window mines, plus one.
        let tip = 900000;
        for (let i = 0; i <= 6; i++) w.observeTip('BTC', tip + i, T0 + i * 600000);
        let now = T0 + 6 * 600000;                     // observed tip is now 900006
        let claimed = w.heights(now).cross_chain_matches.BTC;
        expect(claimed).to.equal(900004);              // the tip from 400000 ms ago (900005) minus one
        expect(900006 - claimed).to.equal(2);          // one block of window plus one
        // The attest rail's window is 100000 ms, a fraction of a block, and it lands on the
        // SAME settled observation: observations exist only where the tip moved, so no window
        // shorter than the block interval can settle a newer one. A rail's window can only
        // ever cost whole blocks of trail, never a fraction of one.
        expect(w.heights(now).attestation_responses.BTC).to.equal(900004);
    });
}

describe('admission height watermark: the bounded advance rule', function () {

    registerBoundedAdvanceCoreTests();

    registerBoundedAdvanceEdgeTests();
});

function publisherWithQueue(entries, ttlMs) {
    let p = Object.create(StateAnchorPublisher.prototype);
    p.announceRetryTtlMs = (ttlMs === undefined) ? 21600000 : ttlMs;
    p._deferredRewardAttest = new Map();
    entries.forEach((e, i) => p._deferredRewardAttest.set('k' + i, e));
    return p;
}

function registerAnchorQueueCapTests() {
it('caps the anchor entry at one below a queued snapshot, leaving every other rail alone', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        let floor = publisherWithQueue([{ at: T0, snapshotBlock: 899500 }]).deferredRewardAttestFloor(T0);
        w.setTableCap('anchor_reward_attestations', 'BTC', floor - 1);
        let h = w.heights(T0 + 400000);
        expect(h.anchor_reward_attestations).to.deep.equal({ BTC: 899499 });
        expect(h.cross_chain_matches.BTC).to.equal(899999);
    });

    it('clears the cap when the queue drains, and the generic advance resumes', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        w.setTableCap('anchor_reward_attestations', 'BTC', 899499);
        expect(w.heights(T0 + 400000).anchor_reward_attestations.BTC).to.equal(899499);
        w.setTableCap('anchor_reward_attestations', 'BTC', null);
        expect(w.heights(T0 + 400000).anchor_reward_attestations.BTC).to.equal(899999);
    });

    it('drops the entry entirely when the cap is below zero', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        w.setTableCap('anchor_reward_attestations', 'BTC', -1);
        expect(w.heights(T0 + 400000)).to.not.have.property('anchor_reward_attestations');
    });
}

function registerAnchorQueueFloorTests() {
it('returns null on an empty queue, so the generic advance applies', function () {
        expect(publisherWithQueue([]).deferredRewardAttestFloor(T0)).to.equal(null);
    });

    it('returns the LOWEST snapshot block still queued', function () {
        let p = publisherWithQueue([
            { at: T0 - 1000, snapshotBlock: 900010 },
            { at: T0 - 2000, snapshotBlock: 899950 },
            { at: T0 - 3000, snapshotBlock: 900002 },
        ]);
        expect(p.deferredRewardAttestFloor(T0)).to.equal(899950);
    });

    it('stops counting an entry past the TTL, which is what bounds the trail', function () {
        let p = publisherWithQueue([
            { at: T0 - 21600001, snapshotBlock: 899950 },   // abandoned
            { at: T0 - 1000,     snapshotBlock: 900010 },
        ]);
        expect(p.deferredRewardAttestFloor(T0)).to.equal(900010);
    });

    it('skips an entry with no usable snapshot block rather than reading it as zero', function () {
        let p = publisherWithQueue([
            { at: T0 - 1000, snapshotBlock: null },
            { at: T0 - 1000, snapshotBlock: 'nope' },
            { at: T0 - 1000, snapshotBlock: 900010 },
        ]);
        expect(p.deferredRewardAttestFloor(T0)).to.equal(900010);
    });
}

describe('admission height watermark: the anchor-attest queue-drain rule', function () {

    // The real method on a real prototype over the real queue shape, so the rule under test
    // is the shipped one and not a restatement of it.

    registerAnchorQueueFloorTests();

    registerAnchorQueueCapTests();
});

describe('admission height watermark: the relay republish rule', function () {

    it('a relay mints NOTHING, whatever it has observed', function () {
        let w = makeWatermark({ HUB_ADMISSION_RELAY: '1' });
        w.observeTip('BTC', 900000, T0);
        expect(w.heights(T0 + 10000000)).to.deep.equal({});
    });

    it('a relay republishes its upstream entry verbatim', function () {
        let w = makeWatermark({ HUB_ADMISSION_RELAY: 'true' });
        expect(w.republishFrom({ cross_chain_matches: { BTC: 899999, LTC: 2899999 } })).to.equal(true);
        expect(w.heights(T0)).to.deep.equal({ cross_chain_matches: { BTC: 899999, LTC: 2899999 } });
    });

    it('a relay drops an upstream entry no consumer could read', function () {
        let w = makeWatermark({ HUB_ADMISSION_RELAY: '1' });
        w.republishFrom({
            not_a_mirror_table:  { BTC: 5 },          // a table this hub does not mirror
            cross_chain_matches: { 'b t c': 7, BTC: 899999, LTC: 'later', DOGE: -3 },
            policy_snapshots:    { BTC: 1.5 },        // nothing usable, so no table key at all
        });
        expect(w.heights(T0)).to.deep.equal({ cross_chain_matches: { BTC: 899999 } });
    });

    it('a relay with no upstream publishes none, and clearing the upstream returns to none', function () {
        let w = makeWatermark({ HUB_ADMISSION_RELAY: '1' });
        expect(w.heights(T0)).to.deep.equal({});
        w.republishFrom({ cross_chain_matches: { BTC: 7 } });
        expect(w.heights(T0)).to.deep.equal({ cross_chain_matches: { BTC: 7 } });
        w.republishFrom(null);
        expect(w.heights(T0)).to.deep.equal({});
    });

    it('a consensus member REFUSES to republish and keeps minting its own claim', function () {
        let w = makeWatermark();
        w.observeTip('BTC', 900000, T0);
        expect(w.republishFrom({ cross_chain_matches: { BTC: 999999 } })).to.equal(false);
        expect(w.heights(T0 + 400000).cross_chain_matches).to.deep.equal({ BTC: 899999 });
    });
});

describe('admission height watermark: the durable floor', function () {

    it('republishes a floor before any observation has aged, closing the restart window', function () {
        let w = makeWatermark();
        w.setFloor({ cross_chain_matches: { BTC: 899000 } });
        expect(w.heights(T0)).to.deep.equal({ cross_chain_matches: { BTC: 899000 } });
    });

    it('is a floor and not a ceiling: the hub s own observation wins when it is higher', function () {
        let w = makeWatermark();
        w.setFloor({ cross_chain_matches: { BTC: 899000 } });
        w.observeTip('BTC', 900000, T0);
        expect(w.heights(T0 + 400000).cross_chain_matches.BTC).to.equal(899999);
    });

    it('a cap still pulls a floored entry down, because a queued round is positive evidence', function () {
        let w = makeWatermark();
        w.setFloor({ anchor_reward_attestations: { BTC: 899000 } });
        w.setTableCap('anchor_reward_attestations', 'BTC', 898500);
        expect(w.heights(T0).anchor_reward_attestations.BTC).to.equal(898500);
    });

    it('drops a floor entry that is not a usable height', function () {
        let w = makeWatermark();
        w.setFloor({ cross_chain_matches: { BTC: 'soon', LTC: -1, DOGE: 5 }, nope: { BTC: 1 } });
        expect(w.heights(T0)).to.deep.equal({ cross_chain_matches: { DOGE: 5 } });
    });
});

function makeDb() {
    let store = new Map();
    let db = Object.create(Database.prototype);
    db.doQuery = async function (sql, args) {
        let text = String(sql);
        if (text.startsWith('SELECT param_name, param_value FROM configs')) {
            let [coin, network, mod] = args;
            let out = [];
            for (let [k, v] of store) {
                let [c, n, m, p] = k.split('|');
                if (c === coin && n === network && m === mod) out.push({ param_name: p, param_value: v });
            }
            return out;
        }
        if (text.includes('INSERT INTO configs')) {
            for (let i = 0; i < args.length; i += 5)
                store.set([args[i], args[i + 1], args[i + 2], args[i + 3]].join('|'), args[i + 4]);
            return [];
        }
        throw new Error('unexpected SQL: ' + text);
    };
    db._store = store;
    return db;
}

describe('admission height watermark: the floor round-trips through the configs store', function () {

    // The real Database methods over a recording driver: no MariaDB, and the SQL the
    // methods actually issue is what is asserted.

    it('writes what the producer published and reads the same map back', async function () {
        let db = makeDb();
        let written = await db.saveAdmissionWatermarkFloor('regtest', {
            cross_chain_matches:        { BTC: 899999, LTC: 2899999 },
            anchor_reward_attestations: { BTC: 899855 },
        });
        expect(written).to.equal(3);
        expect(await db.getAdmissionWatermarkFloor('regtest')).to.deep.equal({
            cross_chain_matches:        { BTC: 899999, LTC: 2899999 },
            anchor_reward_attestations: { BTC: 899855 },
        });
    });

    it('writes only what MOVED, and never lets the floor retreat', async function () {
        let db = makeDb();
        await db.saveAdmissionWatermarkFloor('regtest', { cross_chain_matches: { BTC: 900000 } });
        expect(await db.saveAdmissionWatermarkFloor('regtest', { cross_chain_matches: { BTC: 900000 } })).to.equal(0);
        expect(await db.saveAdmissionWatermarkFloor('regtest', { cross_chain_matches: { BTC: 899000 } })).to.equal(0);
        expect(await db.saveAdmissionWatermarkFloor('regtest', { cross_chain_matches: { BTC: 900001 } })).to.equal(1);
        expect((await db.getAdmissionWatermarkFloor('regtest')).cross_chain_matches.BTC).to.equal(900001);
    });

    it('keeps networks apart, so a regtest floor never arms a mainnet claim', async function () {
        let db = makeDb();
        await db.saveAdmissionWatermarkFloor('regtest', { cross_chain_matches: { BTC: 5 } });
        expect(await db.getAdmissionWatermarkFloor('mainnet')).to.deep.equal({});
    });

    it('skips a stored row it cannot parse rather than guessing a height', async function () {
        let db = makeDb();
        db._store.set(['xchain', 'regtest', 'admission_watermark', 'cross_chain_matches.BTC'].join('|'), '007');
        db._store.set(['xchain', 'regtest', 'admission_watermark', 'no_dot_here'].join('|'), '5');
        db._store.set(['xchain', 'regtest', 'admission_watermark', 'cross_chain_calls.LTC'].join('|'), '12');
        expect(await db.getAdmissionWatermarkFloor('regtest')).to.deep.equal({ cross_chain_calls: { LTC: 12 } });
    });
});
