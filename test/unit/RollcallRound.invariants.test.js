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
// ROLLCALL publish-tunable ARITHMETIC. Both invariants are silent when broken:
// a ladder whose step is too coarse leaves a dead leader with no sweeper and the
// epoch simply closes unrolled, and a self-publish scheduled past the window's
// real edge lands a transaction the BTC close has already stopped counting. In
// both cases every log line is green and the only symptom is validators being
// evicted for absences they answered. Pinned per network so a retune of one
// default cannot quietly break the other.

const assert = require('assert');

const RollcallRound = require('../../src/RollcallRound.js');
const rca           = require('../../src/rollcall_activation.js');
const { CANONICAL_REORG_BUFFER } = require('../../src/snapshot_reorg_buffer.js');

const NETWORKS = ['mainnet', 'testnet', 'regtest'];

// The margin the self-publish must finish inside: the DOGE landing plus a
// Dogecoin miner's two-hour timestamp slack.
//
// The spec states this as a flat 24 BTC blocks, and 24 is exactly one SIXTH of
// the live networks' 144-block accept window. Stated as an absolute it is
// UNSATISFIABLE on regtest, whose whole window is 12 blocks: no self-publish
// height can be below 12 - 24. Regtest scales every roll-call constant down by
// the same 12x (1008 -> 30 interval, 144 -> 12 window, 36 -> 2 proof delay), and
// a margin denominated in a fixed number of BTC blocks does not travel with it.
// So the invariant is pinned as the RATIO the spec's own number expresses, which
// reproduces 24 exactly on mainnet and testnet and yields 2 on regtest.
const MARGIN_DIVISOR = 6;
function landingMargin(windowBlocks){ return Math.ceil(windowBlocks / MARGIN_DIVISOR); }

// How many ranks past the leader must come up inside one accept window.
const REQUIRED_SWEEPERS = 3;

describe('RollcallRound publish-tunable invariants (D88)', function () {

    it('the live networks carry the spec\'s literal 24-block landing margin', function () {
        // Guards the generalisation above: if a future retune moves the live
        // window off 144, the ratio silently stops meaning "24 blocks" and this
        // says so instead of letting the derived margin drift unnoticed.
        assert.strictEqual(landingMargin(rca.ROLLCALL_ACCEPT_WINDOW_BLOCKS.mainnet), 24);
        assert.strictEqual(landingMargin(rca.ROLLCALL_ACCEPT_WINDOW_BLOCKS.testnet), 24);
    });

    it('PUBLISH_DELAY < SELF_PUBLISH < ACCEPT_WINDOW - landing margin on every network', function () {
        for (const net of NETWORKS) {
            const publishDelay = RollcallRound.PUBLISH_DELAY_DEFAULTS[net];
            const selfPublish  = RollcallRound.SELF_PUBLISH_DEFAULTS[net];
            const window       = rca.ROLLCALL_ACCEPT_WINDOW_BLOCKS[net];

            assert.ok(Number.isFinite(publishDelay), net + ': no PUBLISH_DELAY default');
            assert.ok(Number.isFinite(selfPublish),  net + ': no SELF_PUBLISH default');
            assert.ok(Number.isFinite(window),       net + ': no ACCEPT_WINDOW constant');

            assert.ok(publishDelay < selfPublish,
                net + ': ROLLCALL_PUBLISH_DELAY_BLOCKS (' + publishDelay + ') must be below ' +
                'ROLLCALL_SELF_PUBLISH_BLOCKS (' + selfPublish + '), or the escape hatch fires before ' +
                'the leader has even had its slot and every hub pays for its own roll call');
            assert.ok(selfPublish < window - landingMargin(window),
                net + ': ROLLCALL_SELF_PUBLISH_BLOCKS (' + selfPublish + ') must leave at least ' +
                landingMargin(window) + ' BTC blocks of margin inside ACCEPT_WINDOW (' + window + '), ' +
                'covering the DOGE landing plus the 2-hour miner timestamp slack; past it the ' +
                'self-publish lands after the close has cut the window');
        }
    });

    it('at least three ranks past the leader unlock inside the accept window on every network', function () {
        for (const net of NETWORKS) {
            const tolerance = RollcallRound.ELECTION_TOLERANCE_DEFAULTS[net];
            const window    = rca.ROLLCALL_ACCEPT_WINDOW_BLOCKS[net];
            assert.ok(Number.isFinite(tolerance), net + ': no ELECTION_TOLERANCE default');

            // The epoch height is FIXED while the tip advances, so `since` reaches
            // the full accept window and floor(window / tolerance) ranks come up.
            // (The anchor ladder is inert on its bundle rail for the opposite
            // reason: a checkpoint's snapshot_block chases the tip.)
            const unlocked = Math.floor(window / tolerance);
            assert.ok(unlocked >= REQUIRED_SWEEPERS,
                net + ': only ' + unlocked + ' rank(s) unlock inside the ' + window + '-block accept ' +
                'window at ROLLCALL_ELECTION_TOLERANCE_BLOCKS=' + tolerance + '; at least ' +
                REQUIRED_SWEEPERS + ' sweepers must get a slot, or a dead or censoring leader costs ' +
                'the epoch outright');
        }
    });

    // The ladder arithmetic above is a claim about the defaults. This drives the
    // real predicate over a real order to prove the code agrees with it.
    it('the engine really does unlock rank 3 inside the window at the regtest defaults', function () {
        const eng = Object.create(RollcallRound.prototype);
        eng.electionToleranceBlocks = RollcallRound.ELECTION_TOLERANCE_DEFAULTS.regtest;
        const order  = ['0', '1', '2', '3', '4'].map(n => n.repeat(64));
        const window = rca.ROLLCALL_ACCEPT_WINDOW_BLOCKS.regtest;

        assert.strictEqual(eng._rankUnlocked(order, order[0], 0), true, 'rank 0 leads from the first block');
        assert.strictEqual(eng._rankUnlocked(order, order[1], 0), false, 'rank 1 must not lead at the epoch');
        assert.strictEqual(eng._rankUnlocked(order, order[3], window), true,
            'rank 3 must have a slot by the end of the accept window');
        assert.strictEqual(eng._rankUnlocked(order, 'f'.repeat(64), window), false,
            'a key outside the elected order never publishes, however long it waits');
    });

    // No network may put its self-publish deadline at or before the earliest tip
    // a round can exist at. A round needs tip - E >= CANONICAL_REORG_BUFFER,
    // because signing over a ledger_hash that can still be reorged out produces a
    // signature no peer can verify. A deadline inside that buffer has therefore
    // already expired the moment a round is born: every non-leader self-publishes
    // on its first tick, the sweeper path never executes, and the rank ladder
    // never demonstrates the failover it exists for. On the live networks the
    // deadline sits far beyond the buffer and this is free. On regtest the buffer
    // is half the whole 12-block window, which is why its deadline is 9 and its
    // tolerance 3 rather than the 6 and 2 the two would otherwise scale to.
    // Correctness does not depend on it either way, since the chain's present set
    // is the union of whatever lands, but regtest is the venue the acceptance
    // tests drive: a ladder that is inert there is a failover witnessed nowhere.
    it('keeps every self-publish deadline past the earliest signable tip', function () {
        const buffer = CANONICAL_REORG_BUFFER;
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            assert.ok(RollcallRound.SELF_PUBLISH_DEFAULTS[net] > buffer,
                net + ': the self-publish deadline must sit past the earliest signable tip');
            assert.ok(Math.floor(buffer / RollcallRound.ELECTION_TOLERANCE_DEFAULTS[net])
                      < RollcallRound.SELF_PUBLISH_DEFAULTS[net],
                net + ': sweeper ranks must unlock while self-publish is still in the future, '
                    + 'or sweeping never gets a turn');
        }
        // The leader alone holds the first tick on the live networks: their
        // tolerance is wider than the buffer, so no sweeper rank is unlocked yet.
        for (const net of ['mainnet', 'testnet']) {
            assert.strictEqual(Math.floor(buffer / RollcallRound.ELECTION_TOLERANCE_DEFAULTS[net]), 0,
                net + ': no sweeper rank may be unlocked at the first tick, or the leader has no slot');
        }
    });

    it('the three tunables have a documented row in CONFIGURATION.md', function () {
        const fs   = require('fs');
        const path = require('path');
        const doc  = fs.readFileSync(path.join(__dirname, '..', '..', 'CONFIGURATION.md'), 'utf8');
        // Read the names out of the engine rather than restating them, so a rename
        // cannot pass by renaming the assertion with it.
        const src  = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'RollcallRound.js'), 'utf8');
        const used = new Set();
        // Two read forms: the literal process.env.NAME, and the three publish
        // tunables, which go through _resolveTunable('NAME', ...) and are therefore
        // invisible to a literal scan. Missing the second form is exactly how an
        // undocumented knob would ship.
        for (const re of [/process\.env\.(ROLLCALL_[A-Z_0-9]+)/g,
                          /_resolveTunable\(\s*'(ROLLCALL_[A-Z_0-9]+)'/g]) {
            let m;
            while ((m = re.exec(src)) !== null) used.add(m[1]);
        }
        assert.ok(used.size >= 7, 'expected the ROLLCALL_ env family in RollcallRound.js, got ' + used.size);
        for (const knob of ['ROLLCALL_PUBLISH_DELAY_BLOCKS', 'ROLLCALL_ELECTION_TOLERANCE_BLOCKS',
                            'ROLLCALL_SELF_PUBLISH_BLOCKS'])
            assert.ok(used.has(knob), 'env-name extraction missed ' + knob);
        const missing = [...used].filter(name => !doc.includes(name)).sort();
        assert.deepStrictEqual(missing, [],
            'ROLLCALL_ env vars read in src/RollcallRound.js but undocumented in CONFIGURATION.md: ' +
            missing.join(', '));
    });
});

// A network whose activation height is the INERT placeholder must cost nothing
// at runtime, not merely decide nothing. Without this the engine starts, polls
// its BTC indexer every 30 seconds forever, and each poll throws and logs on a
// hub that has no BTC indexer configured, which is every mainnet hub today.
// A recurring warning about a feature nobody armed reads as a fault.
describe('RollcallRound stays inert where the operator has not armed it', function () {

    // Constructed without going through the real hub: start() must decide from
    // the network alone, before it touches an indexer, a peer manager or a log.
    function engineFor(network) {
        const eng = Object.create(RollcallRound.prototype);
        eng.enabled = true;
        eng.network = network;
        eng.interval = rca.ROLLCALL_INTERVAL_BLOCKS[network];
        eng.pollMs = 30000;
        eng.peerManager = null;
        eng._started = false;
        eng._loadSignLog = () => { eng._started = true; };
        eng._loadSpendLog = () => { eng._started = true; };
        eng.spendGuard = { persistTo: () => { eng._started = true; } };
        eng._tick = async () => { eng._started = true; };
        // start() logs a summary line that reads both of these on the armed path.
        eng._signatures = new Map();
        eng.broadcastCapable = () => false;
        return eng;
    }

    // Regtest joined mainnet as inert on 2026-08-31: arming a network commits every
    // BTC indexer on it to a wired DOGE peer, and a single-coin regtest venue has none.
    ['mainnet', 'regtest'].forEach(function (net) {
        it('refuses to start on ' + net + ', which has no activation height', async function () {
            assert.strictEqual(rca.ROLLCALL_ACTIVATION[net], null,
                'this test is about the inert placeholder; if ' + net + ' has been armed, retarget it');
            const eng = engineFor(net);
            const logged = [];
            const real = console.log;
            console.log = (...a) => { logged.push(a.join(' ')); };
            try { await eng.start(); } finally { console.log = real; }
            assert.strictEqual(eng._started, false,
                'an inert network must not load logs, arm a spend guard, or tick even once');
            assert.strictEqual(eng._timer, undefined, 'an inert network must not install a poll timer');
            assert.ok(logged.some((l) => /inert/.test(l)), 'it must say why it is idle rather than start silently');
        });
    });

    it('does start on the networks that are armed', async function () {
        for (const net of ['testnet']) {
            assert.ok(Number.isFinite(rca.ROLLCALL_ACTIVATION[net]), net + ' is expected to be armed');
            const eng = engineFor(net);
            const real = console.log;
            console.log = () => {};
            try { await eng.start(); } finally { console.log = real; clearInterval(eng._timer); }
            assert.strictEqual(eng._started, true, net + ' must start: it has an activation height');
        }
    });
});
