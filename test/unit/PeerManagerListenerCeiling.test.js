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

// PeerManager's 'message' listener ceiling.
//
// Node's default of 10 sat below the number of modules that subscribe to the
// fan-out, so every hub printed a MaxListenersExceededWarning at boot. A warning
// that always fires is a warning nobody reads, which is where a genuine listener
// leak (a subscriber that registers on every restart without removing its old
// handler) would have gone unnoticed.
//
// Two things are asserted here, and they only mean something together:
//   - the declared subscriber roster still matches what the sources actually do,
//     so the ceiling cannot drift away from reality, and
//   - a full set of legitimate subscribers is silent while one extra listener
//     still warns, so the ceiling is sized rather than switched off.

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const PeerManager = require('../../src/PeerManager.js');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

// Modules that register a handler on a PeerManager's 'message' event, read from
// the sources rather than from a list. `ws.on('message', ...)` is a socket-level
// handler on a per-connection object, not a subscriber to the fan-out, so it is
// excluded; that is what the two registrations inside PeerManager itself are.
function subscribersFromSource() {
    const found = new Map();
    for (const file of fs.readdirSync(SRC_DIR)) {
        if (!file.endsWith('.js')) continue;
        const text = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
        const hits = text.match(/([A-Za-z_$][\w$]*)\s*\.\s*(?:on|once|addListener|prependListener)\(\s*['"]message['"]/g) || [];
        const fanout = hits.filter(h => !/^ws\s*\./.test(h));
        if (fanout.length) found.set(file.replace(/\.js$/, ''), fanout.length);
    }
    return found;
}

function makePeerManager() {
    return new PeerManager({ P2P_VALIDATOR_ADDR: 'test-validator', REQUIRE_SIGNATURES: false }, null);
}

// Collect process warnings raised while `fn` runs, including the ones Node defers.
async function warningsDuring(fn) {
    const seen = [];
    const onWarning = (w) => seen.push(w);
    process.on('warning', onWarning);
    try {
        await fn();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
    } finally {
        process.removeListener('warning', onWarning);
    }
    return seen;
}

describe('PeerManager: message listener ceiling', function () {

    it('the declared subscriber roster matches what the sources register', function () {
        const fromSource = subscribersFromSource();
        const declared   = [...PeerManager.MESSAGE_SUBSCRIBERS].sort();
        expect([...fromSource.keys()].sort()).to.deep.equal(declared,
            'PeerManager.MESSAGE_SUBSCRIBERS is out of date; the ceiling is derived from it');
    });

    // One handler per subscriber. If a module ever needs two, the roster has to say
    // so, or the ceiling under-counts the legitimate boot load by one.
    it('each subscriber registers exactly one message handler', function () {
        for (const [name, count] of subscribersFromSource())
            expect(count, name + ' registers ' + count + ' message handlers').to.equal(1);
    });

    it('the ceiling is the subscriber count, not a hand-picked number', function () {
        expect(PeerManager.MAX_MESSAGE_LISTENERS).to.equal(PeerManager.MESSAGE_SUBSCRIBERS.length);
        expect(makePeerManager().getMaxListeners()).to.equal(PeerManager.MESSAGE_SUBSCRIBERS.length);
    });

    it('the ceiling is finite, so a leak can still be reported', function () {
        expect(PeerManager.MAX_MESSAGE_LISTENERS).to.be.finite;
        expect(makePeerManager().getMaxListeners()).to.be.finite;
    });

    it('every legitimate subscriber can attach without a MaxListenersExceededWarning', async function () {
        const pm = makePeerManager();
        const warnings = await warningsDuring(async () => {
            for (const name of PeerManager.MESSAGE_SUBSCRIBERS) pm.on('message', function () { return name; });
        });
        const exceeded = warnings.filter(w => w.name === 'MaxListenersExceededWarning');
        expect(exceeded.map(w => w.message)).to.deep.equal([]);
        expect(pm.listenerCount('message')).to.equal(PeerManager.MESSAGE_SUBSCRIBERS.length);
    });

    it('one listener past the roster still warns, which is the leak signal', async function () {
        const pm = makePeerManager();
        for (const name of PeerManager.MESSAGE_SUBSCRIBERS) pm.on('message', function () { return name; });
        const warnings = await warningsDuring(async () => {
            pm.on('message', function leaked() {});
        });
        const exceeded = warnings.filter(w => w.name === 'MaxListenersExceededWarning');
        expect(exceeded.length, 'a listener leak would now be silent').to.be.at.least(1);
    });
});
