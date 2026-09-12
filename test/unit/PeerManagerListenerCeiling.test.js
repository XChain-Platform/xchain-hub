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
//
// The roster counts LISTENERS, not source files, and those stopped being the same
// number when the bridge engine landed: CrossChainDexConsensus is a parameterized
// PBFT channel and one file now boots several instances of it, each with its own
// handler. So the roster carries one `<module>:<channel>` entry per extra channel
// and the derivation below compares MODULES for parity while checking each extra
// entry against a real construction site, which is what stops the ceiling from
// being raised by inventing entries.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { expect } = require('chai');

const PeerManager = require('../../src/PeerManager.js');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

// Modules that register a handler on a PeerManager's 'message' event, read from
// the sources rather than from a list. `ws.on('message', ...)` is a socket-level
// handler on a per-connection object, not a subscriber to the fan-out, so it is
// excluded; that is what the two registrations inside PeerManager itself are.
function subscribersFromSource(dir = SRC_DIR) {
    const found = new Map();
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.js')) continue;
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        const hits = text.match(/([A-Za-z_$][\w$]*)\s*\.\s*(?:on|once|addListener|prependListener)\(\s*['"]message['"]/g) || [];
        const fanout = hits.filter(h => !/^ws\s*\./.test(h));
        if (fanout.length) found.set(file.replace(/\.js$/, ''), fanout.length);
    }
    return found;
}

// A roster entry is one LISTENER a full boot creates. Most are a bare module name;
// a parameterized subscriber carries one `<module>:<channel>` entry per extra
// channel, so the module half is everything before the first ':'.
const rosterModule  = (entry) => String(entry).split(':')[0];
const rosterChannel = (entry) => {
    const i = String(entry).indexOf(':');
    return i < 0 ? null : String(entry).slice(i + 1);
};

// Every place the sources CONSTRUCT `module`, with the channel each site names. A
// parameterized PBFT channel is identified by the message types it is built with
// (`PROPOSE: 'XBRIDGE_TRANSFER_PROPOSE'` is channel XBRIDGE_TRANSFER); a site that
// passes no message types is the default channel and takes a bare entry. Read from
// the sources for the same reason the roster is: a channel list written down in
// this file would drift exactly the way the hand-picked ceiling did.
function constructionSites(module, dir = SRC_DIR) {
    const sites  = [];
    const needle = 'new ' + module + '(';
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.js')) continue;
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        let from = 0;
        for (;;) {
            const at = text.indexOf(needle, from);
            if (at < 0) break;
            from = at + needle.length;
            // The call's arguments end at its first `);`: an options object of
            // literals closes no parenthesis of its own, so nothing ends earlier.
            const rest  = text.slice(from);
            const close = rest.search(/\)\s*;/);
            const call  = close < 0 ? rest : rest.slice(0, close);
            const named = call.match(/PROPOSE:\s*'([A-Z0-9_]+)_PROPOSE'/);
            sites.push({ file, channel: named ? named[1] : null });
        }
    }
    return sites;
}

// What a roster claims about a multi-entry module, checked against those sites.
// Returned as a list rather than asserted inline so the teeth can be driven
// against a deliberately wrong roster below: an entry naming a channel nothing
// constructs, or more entries than there are instances to carry them, is how the
// ceiling would get raised to cover a leak instead of the leak getting fixed.
function rosterChannelProblems(roster, dir = SRC_DIR) {
    const problems = [];
    const byModule = new Map();
    for (const entry of roster) {
        const module = rosterModule(entry);
        if (!byModule.has(module)) byModule.set(module, []);
        byModule.get(module).push(entry);
    }
    for (const [module, entries] of byModule) {
        if (entries.length === 1 && rosterChannel(entries[0]) === null) continue;
        const sites     = constructionSites(module, dir);
        const named     = new Set(sites.map(s => s.channel).filter(Boolean));
        const defaults  = sites.filter(s => s.channel === null).length;
        const bare      = entries.filter(e => rosterChannel(e) === null).length;
        if (entries.length > sites.length)
            problems.push(module + ': ' + entries.length + ' roster entries but only '
                + sites.length + ' construction sites, so the ceiling is inflated');
        if (bare > defaults)
            problems.push(module + ': ' + bare + ' default-channel entries but only '
                + defaults + ' construction sites take no message types');
        for (const entry of entries) {
            const channel = rosterChannel(entry);
            if (channel !== null && !named.has(channel))
                problems.push(entry + ': no construction site names channel ' + channel);
        }
    }
    return problems;
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

    it('the declared subscriber roster covers exactly the modules the sources register', function () {
        const fromSource = subscribersFromSource();
        const declared   = [...new Set(PeerManager.MESSAGE_SUBSCRIBERS.map(rosterModule))].sort();
        expect([...fromSource.keys()].sort()).to.deep.equal(declared,
            'PeerManager.MESSAGE_SUBSCRIBERS is out of date; the ceiling is derived from it');
    });

    // One handler per INSTANCE, which is what makes the roster countable: a module's
    // boot listeners are its instances, so a module registering twice per instance
    // would make every entry worth two listeners and under-count the boot load.
    it('each subscriber registers exactly one message handler per instance', function () {
        for (const [name, count] of subscribersFromSource())
            expect(count, name + ' registers ' + count + ' message handlers').to.equal(1);
    });

    it('every extra roster entry names a channel the sources actually construct', function () {
        expect(rosterChannelProblems(PeerManager.MESSAGE_SUBSCRIBERS)).to.deep.equal([]);
    });

    // Entries are counted, so a repeat is a silent +1 on the ceiling.
    it('roster entries are distinct', function () {
        const roster = [...PeerManager.MESSAGE_SUBSCRIBERS];
        expect(roster.length).to.equal(new Set(roster).size);
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

    // The derivation counting channels instead of files is only worth something if
    // it still goes red the two ways a leak gets in: a module that subscribes with
    // no entry at all, and an entry invented to cover listeners nothing constructs.
    // Both are driven here rather than asserted about, because a guard nobody has
    // seen fail is a guard nobody has tested.
    it('a subscriber the roster does not carry fails the parity derivation', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-ceiling-'));
        try {
            fs.writeFileSync(path.join(dir, 'Consensus.js'),        "this.peerManager.on('message', h);\n");
            fs.writeFileSync(path.join(dir, 'LeakySubscriber.js'),  "this.peerManager.on('message', h);\n");
            fs.writeFileSync(path.join(dir, 'SocketOnly.js'),       "ws.on('message', h);\n");
            const found = [...subscribersFromSource(dir).keys()].sort();
            expect(found).to.deep.equal(['Consensus', 'LeakySubscriber'],
                'a per-connection ws handler is not a fan-out subscriber, a new module handler is');
            // What the parity assertion above would compare: a roster carrying only
            // Consensus does NOT match, so the new subscriber cannot slip in silently.
            expect(found).to.not.deep.equal(['Consensus']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('an invented channel entry fails the channel derivation', function () {
        const invented = [...PeerManager.MESSAGE_SUBSCRIBERS, 'CrossChainDexConsensus:NOT_A_CHANNEL'];
        expect(rosterChannelProblems(invented)).to.not.deep.equal([],
            'an entry naming a channel nothing constructs must not be able to raise the ceiling');
    });

    it('padding the roster with repeats of a real module fails the channel derivation', function () {
        const sites  = constructionSites('CrossChainDexConsensus').length;
        const padded = [...PeerManager.MESSAGE_SUBSCRIBERS];
        while (padded.filter(e => rosterModule(e) === 'CrossChainDexConsensus').length <= sites)
            padded.push('CrossChainDexConsensus');
        expect(rosterChannelProblems(padded)).to.not.deep.equal([],
            'more entries than instances is an inflated ceiling, not a bigger federation');
    });

    // The padding above is BARE, so the default-channel check catches it on its own
    // and the entry-count check never gets a turn. Copies of a channel the sources
    // really construct are the case only the count check sees: a copy is not bare,
    // so the default-channel tally is untouched, and its name resolves to a real
    // site, so the unknown-channel check passes it too. Each copy is still a silent
    // +1 on MAX_MESSAGE_LISTENERS with no instance behind it, which is exactly how
    // the ceiling would get raised to cover a leak instead of the leak getting
    // fixed. Driven here because an untested branch of this derivation is a branch
    // the ceiling cannot be trusted to have.
    it('padding the roster with repeats of a real channel fails the channel derivation', function () {
        const sites = constructionSites('CrossChainDexConsensus');
        // Taken from the sources for the same reason the roster is: a channel name
        // written down in this file would drift the way the hand-picked ceiling did.
        const channel = sites.map(s => s.channel).find(Boolean);
        expect(channel, 'no CrossChainDexConsensus site names a channel to repeat').to.be.a('string');
        const padded = [...PeerManager.MESSAGE_SUBSCRIBERS];
        while (padded.filter(e => rosterModule(e) === 'CrossChainDexConsensus').length <= sites.length)
            padded.push('CrossChainDexConsensus:' + channel);
        expect(rosterChannelProblems(padded)).to.not.deep.equal([],
            'a roster claiming more instances of a real channel than the sources construct is an inflated ceiling');
    });
});
