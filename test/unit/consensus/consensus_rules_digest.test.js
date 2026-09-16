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

const { expect } = require('chai');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crd  = require('../../../src/consensus_rules_digest.js');
const PeerManager = require('../../../src/peers/manager.js');
const ValidatorIdentity = require('../../../src/validators/identity.js');

const INDEXER_COPY = path.resolve(__dirname, '../../../../xchain-indexer/src/consensus_rules_digest.js');
function registerDigestBasics() {
    it('covers every shared gate and is stable across calls', function () {
        const a = crd.computeConsensusRulesDigest();
        const b = crd.computeConsensusRulesDigest();
        expect(a.digest).to.match(/^[0-9a-f]{64}$/);
        expect(a.digest).to.equal(b.digest);
        const expected = crd.SHARED_GATES.reduce((n, g) => n + g[1].length, 0);
        expect(Object.keys(a.gates)).to.have.lengthOf(expected);
    });

    it('resolves every shared gate in THIS repo (none absent)', function () {
        const { gates } = crd.computeConsensusRulesDigest();
        const absent = Object.keys(gates).filter(k => gates[k] === crd.ABSENT);
        expect(absent, 'gates this repo cannot resolve: ' + absent.join(', ')).to.deep.equal([]);
    });
}

// A carrier this build LACKS and a carrier that is here and will not load are two
// different facts, and only the first of them has a digest. src/stake_weighted_
// quorum.js requires mathjs, so a checkout without node_modules reports 87637dfa
// rather than 26ba9cce unless the second case refuses, and two revisions measured
// that way agree with each other while agreeing with no real build. The indexer copy
// carries the same pair of cases, so a one-sided revert cannot pass by running only
// the other repo's suite.
const CARRIER_SRC          = path.resolve(__dirname, '../../../src');
const CARRIER_MODULE_SRC   = path.join(CARRIER_SRC, 'consensus_rules_digest.js');
const CARRIER_REGISTRY_SRC = path.join(CARRIER_SRC, 'consensus', 'gate_registry.js');
const CARRIER_PARTS_SRC    = path.join(CARRIER_SRC, 'consensus', 'gate_registry');

// A standalone tree: the module under test, a copy of the registry it reads its
// values from (the entry, the config it reads the venue's environment through,
// and the part files that hold the rows), and a stub for every carrier it names
// (a function under every name that is a function on the real carrier, since only
// those are read from the carrier). __dirname is what the loader resolves against,
// so the cases have to own the directory in order to delete a row or break a
// carrier, which no checkout may do.
function scratchTree(mutate) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-carrier-'));
    fs.copyFileSync(CARRIER_MODULE_SRC, path.join(dir, 'consensus_rules_digest.js'));
    fs.copyFileSync(path.join(CARRIER_SRC, 'config.js'), path.join(dir, 'config.js'));
    fs.mkdirSync(path.join(dir, 'consensus', 'gate_registry'), { recursive: true });
    fs.copyFileSync(CARRIER_REGISTRY_SRC, path.join(dir, 'consensus', 'gate_registry.js'));
    for (const part of fs.readdirSync(CARRIER_PARTS_SRC)) {
        fs.copyFileSync(path.join(CARRIER_PARTS_SRC, part), path.join(dir, 'consensus', 'gate_registry', part));
    }
    const byModule = new Map();
    for (const [mod, names] of crd.SHARED_GATES) {
        if (!byModule.has(mod)) byModule.set(mod, []);
        byModule.get(mod).push(...names);
    }
    for (const [mod, names] of byModule) {
        const real = require('../../../src/' + mod + '.js');
        const body = names.map(n => 'exports.' + n + ' = '
            + (typeof real[n] === 'function' ? 'function () {};' : '{ regtest: 0 };')).join('\n');
        fs.writeFileSync(path.join(dir, mod + '.js'), body + '\n');
    }
    mutate(dir);
    return require(path.join(dir, 'consensus_rules_digest.js'));
}

// Cut one addGate() statement out of the scratch registry, by key, from whichever
// part file carries it.
function deleteRow(dir, key) {
    const parts = path.join(dir, 'consensus', 'gate_registry');
    const carrying = fs.readdirSync(parts).map(f => path.join(parts, f))
        .filter(f => fs.readFileSync(f, 'utf8').includes("addGate('" + key + "'"));
    expect(carrying, 'exactly one scratch part file carries ' + key).to.have.lengthOf(1);
    const text = fs.readFileSync(carrying[0], 'utf8');
    const at = text.indexOf("addGate('" + key + "'");
    const stop = text.indexOf(');\n', at) + 3;
    fs.writeFileSync(carrying[0], text.slice(0, at) + text.slice(stop));
}

function registerBrokenCarrierTests() {
    describe('a missing row or a broken carrier is never an absent gate', function () {
        it('digests the whole scratch tree to the shipped digest, so the cases below start green', function () {
            expect(scratchTree(() => {}).computeConsensusRulesDigest().digest)
                .to.equal(crd.computeConsensusRulesDigest().digest);
        });

        it('THROWS naming the key when a registry row is missing, instead of digesting it as absent', function () {
            const victim = 'cross_chain_royalty_activation.CROSS_CHAIN_ROYALTY_ACTIVATION';
            const mod = scratchTree(dir => deleteRow(dir, victim));
            expect(() => mod.computeConsensusRulesDigest()).to.throw(victim);
            // The signed GATES field reads the same loader, so a missing row must take it
            // down too rather than publish a silently shortened gate list.
            expect(() => mod.knownGateKeys()).to.throw(victim);
            expect(() => mod.activeGatesAt(0, 'regtest')).to.throw(victim);
        });

        it('THROWS naming the key when the carrier of a function-valued gate is gone', function () {
            const mod = scratchTree(dir => fs.unlinkSync(path.join(dir, 'mirror_admission_activation.js')));
            expect(() => mod.computeConsensusRulesDigest()).to.throw('mirror_admission_activation.encodeAdmitBlocks');
        });

        it('REFUSES when a carrier is present and fails to load, naming it and the cause', function () {
            const victim = 'mirror_admission_activation';
            const mod = scratchTree(dir => fs.writeFileSync(path.join(dir, victim + '.js'),
                "require('a-dependency-that-is-not-installed');\n"));
            expect(() => mod.computeConsensusRulesDigest())
                .to.throw(Error).and.to.satisfy((e) => e.message.includes(victim)
                    && e.message.includes('a-dependency-that-is-not-installed'));
            expect(() => mod.knownGateKeys()).to.throw(victim);
            expect(() => mod.activeGatesAt(0, 'regtest')).to.throw(victim);
        });
    });
}

function registerDigestParityTests() {
    // The property the whole feature rests on: a hub and an indexer share no source
    // file, so only a VALUE-based digest can be compared between them.
    it('matches the indexer copy exactly, across two repos with no shared file', function () {
        if (!fs.existsSync(INDEXER_COPY)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('xchain-indexer sibling checkout missing: ' + INDEXER_COPY);
            this.skip();
            return;
        }
        const idx = require(INDEXER_COPY);
        const mine = crd.computeConsensusRulesDigest();
        const theirs = idx.computeConsensusRulesDigest();
        expect(crd.diffGates(mine.gates, theirs.gates),
            'gates that disagree between hub and indexer').to.deep.equal([]);
        expect(theirs.digest).to.equal(mine.digest);
    });

    it('is insensitive to key order but sensitive to a changed height', function () {
        const a = crd.canonical({ mainnet: null, testnet: 0, regtest: 0 });
        const b = crd.canonical({ regtest: 0, mainnet: null, testnet: 0 });
        expect(a).to.equal(b);
        expect(crd.canonical({ mainnet: null, testnet: 1 })).to.not.equal(crd.canonical({ mainnet: null, testnet: 0 }));
    });

    it('reports a dropped gate as a difference rather than hiding it', function () {
        const full = { 'a.A': '1', 'b.B': '2' };
        const short = { 'a.A': '1' };
        expect(crd.diffGates(full, short)).to.deep.equal(['b.B']);
        expect(crd.diffGates(short, full)).to.deep.equal(['b.B']);
        expect(crd.diffGates(full, full)).to.deep.equal([]);
    });
}

describe('consensus_rules_digest: the digest', function () {
    registerDigestBasics();
    registerBrokenCarrierTests();
    registerDigestParityTests();
});
