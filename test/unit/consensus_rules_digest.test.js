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
const path = require('path');
const crd  = require('../../src/consensus_rules_digest.js');
const PeerManager = require('../../src/peers/manager.js');
const ValidatorIdentity = require('../../src/validators/identity.js');

const INDEXER_COPY = path.resolve(__dirname, '../../../xchain-indexer/src/consensus_rules_digest.js');
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

function registerBrokenCarrierTests() {
    // A carrier this build LACKS and a carrier that is here and will not load are two
    // different facts, and only the first of them has a digest. src/stake_weighted_
    // quorum.js requires mathjs, so a checkout without node_modules reports 87637dfa
    // rather than 26ba9cce unless the second case refuses, and two revisions measured
    // that way agree with each other while agreeing with no real build. The indexer copy
    // carries the same pair of cases, so a one-sided revert cannot pass by running only
    // the other repo's suite.
    describe('a broken carrier is not an absent one', function () {

        const os = require('os');
        const MODULE_SRC = path.resolve(__dirname, '../../src/consensus_rules_digest.js');

        // A standalone tree: the module under test plus a stub for every carrier it
        // names. __dirname is what the loader resolves against, so the cases have to own
        // the directory in order to delete and break carriers, which no checkout may do.
        function scratchTree(mutate) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-carrier-'));
            fs.copyFileSync(MODULE_SRC, path.join(dir, 'consensus_rules_digest.js'));
            const byModule = new Map();
            for (const [mod, names] of crd.SHARED_GATES) {
                if (!byModule.has(mod)) byModule.set(mod, []);
                byModule.get(mod).push(...names);
            }
            for (const [mod, names] of byModule) {
                const body = names.map(n => 'exports.' + n + ' = { regtest: 0 };').join('\n');
                fs.writeFileSync(path.join(dir, mod + '.js'), body + '\n');
            }
            mutate(dir);
            return require(path.join(dir, 'consensus_rules_digest.js'));
        }

        it('digests an absent carrier FILE as the absent sentinel and does not throw', function () {
            const victim = 'cross_chain_royalty_activation';
            const mod = scratchTree(dir => fs.unlinkSync(path.join(dir, victim + '.js')));
            expect(mod.computeConsensusRulesDigest().gates[victim + '.CROSS_CHAIN_ROYALTY_ACTIVATION'])
                .to.equal(crd.ABSENT);
            // Absent is a real protocol state, so it must still produce a digest, and one
            // that differs from the same tree with the carrier present.
            const whole = scratchTree(() => {});
            expect(mod.computeConsensusRulesDigest().digest)
                .to.not.equal(whole.computeConsensusRulesDigest().digest);
        });

        it('REFUSES when a carrier is present and fails to load, naming it and the cause', function () {
            const victim = 'stake_weighted_quorum';
            const mod = scratchTree(dir => fs.writeFileSync(path.join(dir, victim + '.js'),
                "require('a-dependency-that-is-not-installed');\n"));
            expect(() => mod.computeConsensusRulesDigest())
                .to.throw(Error).and.to.satisfy((e) => e.message.includes(victim)
                    && e.message.includes('a-dependency-that-is-not-installed'));
            // The signed GATES field reads the same loader, so a broken carrier must take
            // it down too rather than publish a silently shortened gate list.
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
