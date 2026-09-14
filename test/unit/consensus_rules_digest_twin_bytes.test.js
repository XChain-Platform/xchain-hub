/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/consensus_rules_digest_twin_bytes.test.js
 *
 * src/consensus_rules_digest.js DECLARES itself a byte-twin of the indexer copy
 * and nothing on the hub side enforced the bytes, so the two could drift
 * indefinitely with every gate green: the indexer half of this guard
 * (xchain-indexer/test/unit/consensus_rules_digest_twin_bytes.test.js) only
 * runs in indexer CI, so a hub-side edit passes every hub gate and the drift
 * is caught, if at all, the next time indexer CI happens to carry a hub
 * sibling checkout. The existing value-twin case in consensus_rules_digest
 * .test.js compares gate VALUES, which is a weaker claim than the file
 * makes: two copies whose helpers have diverged still digest alike, because
 * the digest preimage never runs the helpers.
 *
 * This is the hub-side half of that guard, on the same pattern.
 *
 * BYTES: the copies must be identical after normalising ONE declared line,
 * the self-referential header in which each copy names the OTHER repo. That
 * asymmetry is deliberate and no strict byte assertion can satisfy it, so it
 * is normalised by exact literal rather than by pattern: each side's header
 * is pinned to its full text, the substitution must hit exactly one line, and
 * everything else is compared byte for byte. A looser normaliser, one that
 * rewrote whatever a regex happened to reach, would pass a genuinely drifted
 * copy and be worse than no guard at all.
 *
 * ENTRY POINTS: activeGatesAt() and knownGateKeys() are driven ON THE INDEXER
 * COPY and compared to this repo's answers. The digest comparison alone reads
 * green against an indexer copy that throws from either one, because neither
 * is on the digest path: loadGateValues() and canonical() are, and the
 * activation helpers are not.
 *
 * SIBLING RESOLUTION: XCHAIN_INDEXER_DIR, then the conventional sibling
 * directory, matching the order test/unit/sibling_coverage.test.js and the
 * ATTEST batch wire twin (attest_batch_wire_parity.test.js) already read for
 * this repo's indexer guards. From a lane worktree the conventional path
 * resolves to nothing (a skip) or to a peer's live working tree (not
 * evidence either way), so a run that means to PROVE this points
 * XCHAIN_INDEXER_DIR at a detached checkout and sets
 * XCHAIN_REQUIRE_SIBLINGS=1, which turns a missing sibling into a failure
 * instead of a silent pass.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crd    = require('../../src/consensus_rules_digest.js');

// Sibling checkout, resolved the way every other twin test in this repo
// resolves it: an explicit env path for CI, falling back to the dev sibling
// layout.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const INDEXER_COPY = path.join(INDEXER_DIR, 'src', 'consensus_rules_digest.js');
const MY_COPY      = path.join(__dirname, '..', '..', 'src', 'consensus_rules_digest.js');
const STRICT       = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// The ONLY line that may differ, enumerated as the full text of both sides
// rather than as a pattern. Each copy names the other repo here; a copy that
// names ITSELF, or names a third repo, or spells the line any other way, fails
// the enumeration below instead of being quietly normalised away.
const TWIN_HEADER_IN_MINE    = ' * BYTE-TWIN of xchain-indexer/src/consensus_rules_digest.js. The two copies';
const TWIN_HEADER_IN_INDEXER = ' * BYTE-TWIN of xchain-hub/src/consensus_rules_digest.js. The two copies';

// What both declared headers collapse to for the comparison. It is not a legal
// line of either file, so a copy cannot smuggle it in to widen the window.
const HEADER_SENTINEL = ' * BYTE-TWIN of <twin>/src/consensus_rules_digest.js. The two copies';

// The prefix that makes a line a twin declaration at all. Counting these is how
// the guard proves its normalisation window is exactly one line wide: a second
// declaration, anywhere, would be a line the comparison silently stopped
// covering.
const TWIN_HEADER_PREFIX = ' * BYTE-TWIN of ';

// Replace the one declared header with the sentinel, asserting on the way that
// it appears exactly once and reads exactly as expected. Everything the
// comparison then sees is untouched source.
function normalise(text, expectedHeader, label) {
    const lines = text.split('\n');
    const declared = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].startsWith(TWIN_HEADER_PREFIX)) declared.push(i);
    }
    assert.strictEqual(declared.length, 1,
        label + ' must carry exactly one BYTE-TWIN declaration, found ' + declared.length
        + '; the normalisation window is one line wide and this copy moved it');
    assert.strictEqual(lines[declared[0]], expectedHeader,
        label + ' twin header line ' + (declared[0] + 1) + ' is not the declared text.\n'
        + '  expected: ' + expectedHeader + '\n'
        + '  actual:   ' + lines[declared[0]]);
    assert.ok(!text.includes(HEADER_SENTINEL),
        label + ' already contains the comparison sentinel, which would hide a real difference');
    lines[declared[0]] = HEADER_SENTINEL;
    return lines.join('\n');
}

// Shared by both describes below: skip when the sibling checkout is not
// present, unless XCHAIN_REQUIRE_SIBLINGS=1 turns a missing sibling into a
// failure instead of a silent pass.
function skipIfNoIndexer() {
    if (!fs.existsSync(INDEXER_COPY)) {
        if (STRICT) {
            assert.fail('xchain-indexer sibling checkout missing: ' + INDEXER_COPY
                + ' (set XCHAIN_INDEXER_DIR at a checkout to prove this guard ran)');
        }
        this.skip();
    }
}

describe('consensus_rules_digest: indexer twin bytes', function () {

    before(skipIfNoIndexer);

    // The claim the file's own header makes, finally enforced on the hub side.
    // Gate-value equality, which consensus_rules_digest.test.js already asserts,
    // does not imply this: the helpers below the digest path can diverge
    // without moving a digest.
    it('is byte-identical to the indexer copy but for the one declared header line', function () {
        const mine    = fs.readFileSync(MY_COPY, 'utf8');
        const indexer = fs.readFileSync(INDEXER_COPY, 'utf8');
        const a = normalise(mine,    TWIN_HEADER_IN_MINE,    'the hub copy');
        const b = normalise(indexer, TWIN_HEADER_IN_INDEXER, 'the indexer copy (' + INDEXER_COPY + ')');

        // Line counts first: a whole-file inequality message on a large file
        // is unreadable, and a length delta is the one thing worth naming plainly.
        const aLines = a.split('\n');
        const bLines = b.split('\n');
        assert.strictEqual(bLines.length, aLines.length,
            'the two copies differ in length: hub ' + aLines.length
            + ' lines, indexer ' + bLines.length + ' lines');

        const differing = [];
        for (let i = 0; i < aLines.length; i += 1) {
            if (aLines[i] !== bLines[i]) differing.push(i + 1);
        }
        assert.deepStrictEqual(differing, [],
            'the byte-twin copies differ outside the declared header, at line(s) '
            + differing.join(', ') + '.\n'
            + differing.slice(0, 5).map(n =>
                '  ' + n + ' hub:     ' + aLines[n - 1] + '\n'
                + '  ' + n + ' indexer: ' + bLines[n - 1]).join('\n'));

        // The line walk above is the readable report; this is the actual claim,
        // and it also covers a trailing-byte difference no line index names.
        assert.strictEqual(b, a, 'the byte-twin copies are not byte-identical after normalising the header');
    });

    // Proves the enumeration itself, independently of whether the bytes happen
    // to match today: exactly one declared exception per side, each the pinned
    // text naming the other repo. If this ever needs a second entry, that is a
    // deliberate widening of the guard and it must be argued, not discovered.
    it('declares exactly one normalised exception per copy, each naming the other repo', function () {
        const mine    = fs.readFileSync(MY_COPY, 'utf8').split('\n');
        const indexer = fs.readFileSync(INDEXER_COPY, 'utf8').split('\n');
        const declaredIn = ls => ls.filter(l => l.startsWith(TWIN_HEADER_PREFIX));

        assert.deepStrictEqual(declaredIn(mine),    [TWIN_HEADER_IN_MINE]);
        assert.deepStrictEqual(declaredIn(indexer), [TWIN_HEADER_IN_INDEXER]);
        assert.notStrictEqual(TWIN_HEADER_IN_MINE, TWIN_HEADER_IN_INDEXER,
            'the exception exists because the two headers differ; if they stop differing, delete it');
    });
});

// Body of the activeGatesAt comparison, at file scope so the describe below
// stays within the per-function line budget. Takes the already-required
// indexer module so the it() keeps require() itself, which is the part that
// must run inside the test to red on a throwing copy.
function assertActiveGatesAtAgree(indexer) {
    const networks = ['mainnet', 'testnet', 'regtest'];
    const coins    = [undefined, 'BTC', 'DOGE', 'LTC'];
    const heights  = [0, 1, 151200, 4210000, 1e9, NaN, 'not-a-height'];

    let compared = 0;
    for (const network of networks) {
        for (const coin of coins) {
            for (const height of heights) {
                const mine   = crd.activeGatesAt(height, network, coin);
                const theirs = indexer.activeGatesAt(height, network, coin);
                assert.deepStrictEqual(theirs, mine,
                    'activeGatesAt(' + String(height) + ', ' + network + ', ' + String(coin)
                    + ') disagrees between the copies');
                compared += 1;
            }
        }
    }
    assert.strictEqual(compared, networks.length * coins.length * heights.length);

    // A copy whose activeGatesAt returned [] for everything would agree with
    // nothing and still deep-equal an equally broken peer, so pin the one
    // reading that must not be empty: regtest arms its gates at genesis.
    assert.ok(indexer.activeGatesAt(1e9, 'regtest').length > 0,
        'the indexer copy reports no active gates at all on regtest, which cannot be right');
}

describe('consensus_rules_digest: indexer-side entry points', function () {

    before(skipIfNoIndexer);

    // The second half of the row. require() here is deliberate and load-bearing:
    // an indexer copy that throws on load reds this case, where the digest
    // comparison would have to reach it through a path it never takes.
    it('answers activeGatesAt identically to the indexer copy across heights, networks and coins', function () {
        assertActiveGatesAtAgree(require(INDEXER_COPY));
    });

    // knownGateKeys is the other helper off the digest path: it is the GATES
    // field a ROLLCALL v1 publisher puts on the wire, so an indexer copy broken
    // here mis-states what the indexer build applies while its digest still
    // matches. Compared to this repo's list rather than to a literal, so the
    // pinned count stays pinned in exactly one place.
    it('reports the same gate registry from the indexer copy, with none absent', function () {
        const indexer = require(INDEXER_COPY);

        assert.deepStrictEqual(indexer.knownGateKeys(), crd.knownGateKeys(),
            'the two copies do not know the same shared gates');
        assert.deepStrictEqual(indexer.SHARED_GATES, crd.SHARED_GATES,
            'SHARED_GATES registries differ; order is part of the digest preimage');

        const gates  = indexer.computeConsensusRulesDigest().gates;
        const absent = Object.keys(gates).filter(k => gates[k] === indexer.ABSENT);
        assert.deepStrictEqual(absent, [],
            'the indexer copy cannot resolve: ' + absent.join(', '));

        // Every key the indexer reports active at any height must be a key it knows.
        // A helper that fabricated or mangled keys would pass the comparison
        // above and still put names on the wire no peer can match.
        const known = new Set(indexer.knownGateKeys());
        for (const k of indexer.activeGatesAt(1e9, 'regtest')) {
            assert.ok(known.has(k), 'indexer activeGatesAt returned an unknown gate key: ' + k);
        }
    });
});
