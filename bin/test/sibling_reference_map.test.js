/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The sibling reference map: the indirect idioms it exists to see, and the
 * scratch trees it must refuse to count.
 *
 * The matchers are driven over fixture STRINGS rather than over the tree,
 * because an assertion against the tree passes for as long as some file happens
 * to be written that way and says nothing about the matcher. The sweep rules are
 * driven over a directory this suite builds, for the same reason.
 *
 *   npx mocha --no-config --timeout 120000 bin/test/sibling_reference_map.test.js
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const refs = require('../sibling-reference-map.js');

describe('bin/sibling-reference-map.js', function () {
    this.timeout(120000);

    describe('the indirect idioms', () => {
        it('follows a checkout held in a variable to the file joined onto it', () => {
            const source = [
                "const path = require('path');",
                "const HUB = path.resolve(__dirname, '../../xchain-hub');",
                "const engine = require(path.join(HUB, 'src', 'cross_chain', 'bridge_engine.js'));",
                'const other = `${HUB}/src/peers/manager.js`;',
            ].join('\n');
            const hits = refs.scanIndirectIdioms(source, {}).found.map((h) => h.path).sort();
            assert.deepStrictEqual(hits, ['src/cross_chain/bridge_engine.js', 'src/peers/manager.js'],
                'neither site spells the repo name beside the file name, which is why a grep misses both');
        });

        it('follows the checkout through an environment variable', () => {
            const source = [
                "const path = require('path');",
                'const root = process.env.XCHAIN_HUB_PATH;',
                "const sql = path.join(root, 'src', 'sql', 'validators.sql');",
            ].join('\n');
            const hits = refs.scanIndirectIdioms(source, {}).found.map((h) => h.path);
            assert.deepStrictEqual(hits, ['src/sql/validators.sql']);
        });

        it('expands a helper called over a literal list into one site per element', () => {
            const source = [
                "const path = require('path');",
                "const HUB = path.resolve(__dirname, '../../xchain-hub');",
                'function hubFile(rel){ return path.join(HUB, rel); }',
                "for (const twin of ['xchainPrice.js', 'price_batch_compression.js']) {",
                "    check(hubFile('src/' + twin));",
                '}',
            ].join('\n');
            const hits = refs.scanIndirectIdioms(source, {}).found.map((h) => h.path).sort();
            assert.deepStrictEqual(hits, ['src/price_batch_compression.js', 'src/xchainPrice.js'],
                'a move has to repoint every element, so one "dynamic, ask a human" line would hide both');
        });

    });
});

// The blocks below carry the same suite title on purpose: the readability limit is
// per callback, so one long body becomes several same-titled blocks and every full
// test title stays exactly what it was.
describe('bin/sibling-reference-map.js', function () {
    this.timeout(120000);

    describe('the indirect idioms', () => {
        it('reports a tail it cannot resolve instead of guessing at it', () => {
            const source = [
                "const path = require('path');",
                "const HUB = path.resolve(__dirname, '../../xchain-hub');",
                "const p = path.join(HUB, 'src', someModule);",
            ].join('\n');
            const scan = refs.scanIndirectIdioms(source, {});
            assert.strictEqual(scan.found.length, 0, 'nothing may be invented from an unknown variable');
            assert.strictEqual(scan.dynamic.length, 1, 'and it must not be dropped either');
            assert.strictEqual(scan.dynamic[0].form, 'root-var');
        });

        it('reads the bash twin-copier idiom', () => {
            const source = [
                '#!/usr/bin/env bash',
                'for f in xchainPrice.js xchainPriceQuery.js; do',
                '    copy_twin xchain-hub "src/$f"',
                'done',
            ].join('\n');
            const hits = refs.scanIndirectIdioms(source, { shell: true }).found.map((h) => h.path).sort();
            assert.deepStrictEqual(hits, ['src/xchainPrice.js', 'src/xchainPriceQuery.js']);
        });
    });
});

describe('bin/sibling-reference-map.js', function () {
    this.timeout(120000);

    describe('the computed requires', () => {
        it('names the gate carriers the rules digest loads without a literal', () => {
            const source = fs.readFileSync(path.resolve(__dirname, '../../src/consensus_rules_digest.js'), 'utf8');
            const sites = refs.computedRequireSites(source, 'src');
            assert.strictEqual(sites.length, 1, 'one site builds the whole gate list');
            assert.ok(sites[0].listCandidates.length >= 15,
                `expected the resolved carrier list, got ${sites[0].listCandidates.length}`);
            assert.ok(sites[0].listCandidates.includes('src/rollcall_activation.js'));
        });

        it('sees a require of path.join over __dirname, resolved through the calls of its function', () => {
            const source = [
                "const path = require('path');",
                'function loadActivation(moduleName, predicate){',
                "    try { return require(path.join(__dirname, '..', moduleName + '.js'))[predicate]; } catch (e) { return null; }",
                '}',
                "const gates = { bridge: loadActivation('xchain_bridge_activation', 'isOn'), token: loadActivation('token_bridge_activation', 'isOn') };",
            ].join('\n');
            const sites = refs.computedRequireSites(source, 'src/cross_chain');
            assert.strictEqual(sites.length, 1);
            assert.deepStrictEqual(sites[0].listCandidates, ['src/xchain_bridge_activation.js', 'src/token_bridge_activation.js']);
        });

        it('follows a name bound to path.join into the require that loads it, through the loop that calls its function', () => {
            const source = [
                "const GATES = [['rollcall_activation', ['A']], ['xcall_activation', ['B']]];",
                'function loadGateModule(mod){',
                "    const file = path.join(__dirname, mod + '.js');",
                '    return require(file);',
                '}',
                'function loadAll(){ for (const [mod, names] of GATES) { loadGateModule(mod); } }',
            ].join('\n');
            const sites = refs.computedRequireSites(source, 'src');
            assert.strictEqual(sites.length, 1);
            assert.deepStrictEqual(sites[0].listCandidates, ['src/rollcall_activation.js', 'src/xcall_activation.js']);
        });

        it('still sees the concatenated form inside its loop', () => {
            const source = "for (const mod of ['a_activation', 'b_activation']) { m = require('./' + mod + '.js'); }";
            const sites = refs.computedRequireSites(source, 'src');
            assert.strictEqual(sites.length, 1);
            assert.deepStrictEqual(sites[0].listCandidates, ['src/a_activation.js', 'src/b_activation.js']);
        });

        it('reports a require of an unbound name as a site with no candidates, and a literal binding as none', () => {
            const sites = refs.computedRequireSites('function load(modulePath){ return require(modulePath); }', 'src/lib');
            assert.strictEqual(sites.length, 1);
            assert.deepStrictEqual(sites[0].listCandidates, []);
            const literal = "const file = path.join(__dirname, 'x.js');\nconst other = './y.js';\nrequire(file); require(other); require('./z.js');";
            assert.strictEqual(refs.computedRequireSites(literal, 'src').length, 0);
        });

        it('finds the bridge gates and the provider loader in this tree, each in its current spelling', () => {
            const src = path.resolve(__dirname, '../../src');
            const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8');
            const bridge = refs.computedRequireSites(read('cross_chain/bridge_engine.js'), 'src/cross_chain');
            assert.strictEqual(bridge.length, 1, 'one site loads every bridge gate');
            assert.deepStrictEqual(bridge[0].listCandidates.slice().sort(),
                ['src/token_bridge_activation.js', 'src/token_policy_activation.js', 'src/xchain_bridge_activation.js']);
            assert.strictEqual(refs.computedRequireSites(read('validators/provider_registry.js'), 'src/validators').length, 1,
                'the provider loader builds its path from an id read at run time');
        });
    });

    describe('what the sweep must not count', () => {
        let root;

        before(() => {
            // A sibling holding a scratch clone of another repo: xchain-node does
            // exactly this in modules/ and in tmp/, and counting those attributed
            // hundreds of other repos' references to it.
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'srm-sweep-'));
            const sibling = path.join(root, 'xchain-decoder');
            fs.mkdirSync(path.join(sibling, 'src'), { recursive: true });
            fs.writeFileSync(path.join(sibling, 'src', 'own.js'),
                "require('../../xchain-hub/src/peers/manager.js');\n");

            const nested = path.join(sibling, 'modules', 'xchain-indexer', 'src');
            fs.mkdirSync(nested, { recursive: true });
            fs.writeFileSync(path.join(sibling, 'modules', 'xchain-indexer', '.git'), 'gitdir: elsewhere\n');
            fs.writeFileSync(path.join(nested, 'cloned.js'),
                "require('../../xchain-hub/src/OracleConsensus.js');\n");

            const scratch = path.join(sibling, 'tmp', 'work', 'src');
            fs.mkdirSync(scratch, { recursive: true });
            fs.writeFileSync(path.join(scratch, 'scratch.js'),
                "require('../../xchain-hub/src/RewardTracker.js');\n");
        });

        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('counts the sibling\'s own file and neither the nested checkout nor the tmp tree', () => {
            const map = refs.buildReferenceMap(root);
            const seen = Object.keys(map.paths).sort();
            assert.deepStrictEqual(seen, ['src/peers/manager.js'],
                'a reference inside a scratch clone belongs to the cloned repo, and nobody repoints a clone');
            assert.strictEqual(map.referenceCount, 1);
        });
    });
});

describe('bin/sibling-reference-map.js', function () {
    this.timeout(120000);

    describe('the census', () => {
        it('separates a site that breaks a build from one that only misleads a reader', () => {
            const map = {
                siblingRepos: ['xchain-indexer', 'xchain-documentation'],
                distinctPathCount: 2,
                existingPathCount: 2,
                referenceCount: 3,
                dynamicReferenceCount: 0,
                dynamicReferences: [],
                paths: {
                    'src/a.js': { referrers: [
                        { repo: 'xchain-indexer', file: 'xchain-indexer/test/a.test.js', line: 1, kind: 'require' },
                        { repo: 'xchain-indexer', file: 'xchain-indexer/README.md', line: 9, kind: 'text' },
                    ] },
                    'src/b.js': { referrers: [
                        { repo: 'xchain-documentation', file: 'xchain-documentation/guide.md', line: 4, kind: 'text' },
                    ] },
                },
            };
            const census = refs.referenceCensus(map);
            assert.strictEqual(census.totals.executableSites, 1);
            assert.strictEqual(census.totals.mentionSites, 2);
            assert.strictEqual(census.byRepo['xchain-indexer'].gatesAPush, true,
                'one require is enough to make the sibling half of a move land as a pair');
            assert.strictEqual(census.byRepo['xchain-documentation'].gatesAPush, false,
                'a guide going stale gates nothing');
        });
    });

    describe('--root', () => {
        it('measures the checkout it is given, not the one it lives in', () => {
            const before = refs.repoRoot();
            const other = fs.realpathSync(path.resolve(__dirname, '../..'));
            try {
                assert.strictEqual(refs.setRepoRoot(other), other);
                assert.strictEqual(refs.repoRoot(), other);
            } finally {
                refs.setRepoRoot(before);
            }
            assert.strictEqual(refs.repoRoot(), before, 'the root must be restorable');
        });
    });
});
