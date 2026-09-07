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
const constants  = require('../../src/constants');

// #1299: PRICE_MAX and ORACLE_DEVIATION_THRESHOLD are federation-uniform oracle
// band constants that must have a single source of truth (constants.js). This is
// the hub-local conformance guard against the "re-introduced literal" drift vector:
// a future consumer (or a refactor) that hardcodes 0.05 or 1e10 instead of importing
// the constant would drift undetected. The cross-repo half is the second describe
// below (#3886): both literals are hand-mirrored into six other repos, and this file
// owning the canonical value is what lets one guard diff all of them.
describe('oracle band constants conformance (#1299)', () => {

    it('PRICE_MAX has its pinned value', () => {
        expect(constants.PRICE_MAX).to.equal(10_000_000_000);
    });

    it('ORACLE_DEVIATION_THRESHOLD has its pinned value', () => {
        expect(constants.ORACLE_DEVIATION_THRESHOLD).to.equal(0.05);
    });

    // api.js sources the SLASH_DEVIATION_THRESHOLD default from
    // ORACLE_DEVIATION_THRESHOLD rather than re-declaring the 0.05 literal, so the
    // default string must equal the constant's string form. Guards against the two
    // drifting apart if either is edited in isolation.
    it('api.js default binds to the constant (String(ORACLE_DEVIATION_THRESHOLD) === "0.05")', () => {
        expect(String(constants.ORACLE_DEVIATION_THRESHOLD)).to.equal('0.05');
    });

    // #2490: ORACLE_MAX_CHANGE_PER_ROUND is a frozen 0.25 literal whose comment
    // (constants.js) documents the invariant that it is kept at 5x
    // ORACLE_DEVIATION_THRESHOLD so a clamped aggregate always passes the follower
    // propose-gate's historical band (OracleConsensus derives that band live as
    // 5 x ORACLE_DEVIATION_THRESHOLD). OracleConsensus.test.js already asserts the
    // one-sided `<= 5x` bound (the liveness-breaking direction). Pin strict equality
    // here so raise-direction drift of either constant, coordinated across tests and
    // docs, cannot silently strand the clamp above (or below) the band multiplier.
    it('ORACLE_MAX_CHANGE_PER_ROUND equals 5x ORACLE_DEVIATION_THRESHOLD (documented coupling)', () => {
        expect(constants.ORACLE_MAX_CHANGE_PER_ROUND).to.equal(5 * constants.ORACLE_DEVIATION_THRESHOLD);
    });
});

// #3886: PRICE_MAX and ORACLE_DEVIATION_THRESHOLD are hand-mirrored into six other
// repos, and unlike XCALL_MAX_HOPS they are NOT in the GOLDEN set of
// xcall-constants-cross-repo.test.js (whose GUARD_PATHS name only vm/indexer/sdk), so
// nothing tied the copies together. Anchored HERE rather than replicated as a seventh
// byte-identical guard: this repo declares the canonical value, so one file can diff
// every mirror against it and name the stale one. No mirror repo's code reads either
// constant - they are re-exports for downstream consumers - so a mirror-side edit has
// no local motive and being caught on the next hub CI run is enough.
//
// xchain-decoder was missing from MIRRORS (and from .ci-siblings) while carrying a
// byte-identical copy of both values, and its own suite pins neither, so that copy was
// the one mirror nothing on either side tied to the canonical value.
describe('oracle band constants agree across the mirror repos (#3886)', function () {
    const fs   = require('fs');
    const path = require('path');

    const GATED = ['PRICE_MAX', 'ORACLE_DEVIATION_THRESHOLD'];

    // Listed rather than globbed, so a repo that quietly drops its copy reddens here.
    const MIRRORS = {
        'xchain-vm':            'src/protocol/constants.js',
        'xchain-indexer':       'src/protocol/constants.js',
        'xchain-sdk':           'src/protocol/constants.js',
        'xchain-explorer':      'src/protocol/constants.js',
        'xchain-decoder':       'src/protocol/constants.js',
        'xchain-documentation': 'protocol/constants.js'
    };

    // Walk up to the nearest package.json rather than counting '..' hops, matching
    // xchain-indexer/test/unit/xcall-constants-cross-repo.test.js.
    const REPO_ROOT = (function () {
        let dir = __dirname;
        while (!fs.existsSync(path.join(dir, 'package.json'))) {
            const up = path.dirname(dir);
            if (up === dir) throw new Error('no package.json above ' + __dirname);
            dir = up;
        }
        return dir;
    })();
    const PLATFORM_ROOT = path.dirname(REPO_ROOT);

    // Same required-sibling policy as the xcall gate: a missing checkout skips by
    // default (standalone clones), and hard-fails wherever XCHAIN_REQUIRE_SIBLINGS=1
    // declares the siblings were provided on purpose, so bin/ci-all.sh can never pass
    // this green-by-skip.
    const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
    function siblingOrSkip(ctx, absPath, what) {
        if (fs.existsSync(absPath)) return true;
        if (REQUIRE_SIBLINGS)
            throw new Error('oracle band constants gate cannot run: ' + what + ' missing at ' +
                absPath + '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
        ctx.skip();
        return false;
    }

    // Fresh read per call: a module cached by an earlier suite would hide an on-disk edit.
    function loadConstants(absPath) {
        const resolved = require.resolve(absPath);
        delete require.cache[resolved];
        return require(resolved);
    }

    it('resolved the hub repo root, so the sibling paths below are real', function () {
        expect(path.basename(REPO_ROOT), 'walk-up landed outside xchain-hub: ' + REPO_ROOT)
            .to.equal('xchain-hub');
    });

    for (const [repo, rel] of Object.entries(MIRRORS)) {
        it('mirror ' + repo + ' declares the canonical values', function () {
            const abs = path.join(PLATFORM_ROOT, repo, rel);
            if (!siblingOrSkip(this, abs, repo + ' ' + rel)) return;
            const theirs = loadConstants(abs);
            for (const name of GATED) {
                expect(theirs[name],
                    repo + '/' + rel + ': ' + name + ' = ' + theirs[name] + ', but the canonical ' +
                    'xchain-hub/src/constants.js says ' + constants[name] + '. These are ' +
                    'federation-uniformity values; propagate the hub-side edit to every mirror')
                    .to.equal(constants[name]);
            }
        });
    }
});

// #2653: the oracle round-interval and submission-window defaults anchor
// federation-wide round numbering (together with ORACLE_EPOCH_START). They used
// to live as bare literals in api.js, OracleRound.js, and XChainHub.js, linked
// only by a prose comment; a hub constructed without a populated p2pConfig fell
// through to whichever local literal was current. All three sites now require
// the shared constants; this guard pins the values and scans the source files
// for re-introduced fallback literals.
describe('oracle round-interval shared constants (#2653)', () => {
    const fs   = require('fs');
    const path = require('path');

    it('DEFAULT_ORACLE_ROUND_INTERVAL_MS is pinned at 600000 (10 min)', () => {
        expect(constants.DEFAULT_ORACLE_ROUND_INTERVAL_MS).to.equal(600000);
    });

    it('DEFAULT_ORACLE_SUBMISSION_WINDOW_MS is pinned at 180000 (3 min)', () => {
        expect(constants.DEFAULT_ORACLE_SUBMISSION_WINDOW_MS).to.equal(180000);
    });

    it('no consumer re-declares the interval/window defaults as bare fallback literals', () => {
        for (const file of ['api.js', 'OracleRound.js', 'XChainHub.js']) {
            const src = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8');
            // The drift vector is a fallback expression like
            // `ORACLE_ROUND_INTERVAL || 600000` on an oracle-cadence line; the
            // constant name is the only allowed way to spell the default. Scoped
            // to ORACLE_* lines so unrelated 600000s (e.g. signer-set max age)
            // stay out of scope.
            const offenders = src.split('\n').filter(line =>
                /ORACLE_(ROUND_INTERVAL|SUBMISSION_WINDOW)/.test(line) &&
                /\|\|\s*(600000|180000)\b/.test(line));
            expect(offenders, file + ' re-declares an oracle cadence fallback literal: ' + offenders.join(' | ')).to.deep.equal([]);
        }
    });

    it('OracleRound built with an empty p2pConfig lands on the shared defaults', () => {
        const proxyquire = require('proxyquire');
        const { createMockHub } = require('../helpers/mockHub');
        const PriceFetcherStub = function () { return {}; };
        PriceFetcherStub.getCoinPairs = () => ['BTC/USD'];
        const OracleRound = proxyquire('../../src/OracleRound', {
            './PriceFetcher.js': PriceFetcherStub
        });
        const or = new OracleRound(createMockHub({ p2pConfig: {} }));
        expect(or.roundInterval).to.equal(constants.DEFAULT_ORACLE_ROUND_INTERVAL_MS);
        expect(or.submissionWindow).to.equal(constants.DEFAULT_ORACLE_SUBMISSION_WINDOW_MS);
    });
});

// #7215: the two PRICE lanes derive their accepted (coin, fiat) universe from two
// INDEPENDENT literals in this one package, and nothing bound them. v1 push ingest
// gates on constants.PRICE_V1_COINS / PRICE_V1_FIATS (PriceAggregator.receiveOraclePrice);
// v0 ingest and PROPOSE co-signing gate on the product PriceFetcher builds from
// coins.ALLOWED_COINS x its own private FIATS literal (OracleRound's canonicalPairs).
// The fiat lists were byte-identical by hand and the coin sides equal only by
// coincidence, so adding a chain to coins/ or a code to either fiat list landed in ONE
// lane silently: the v0 lane picks up a registry coin automatically while v1 ingest
// keeps rejecting it as an invalid coin, or a v1-only fiat is accepted on push while
// no hub ever fetches, whitelists or co-signs the matching pair. The constants.js
// lockstep comment named only the indexer, never PriceFetcher, so the in-repo half of
// the coupling was undocumented as well as unguarded.
describe('PRICE v0 and v1 lanes accept the same coin/fiat universe (#7215)', function () {
    const fs   = require('fs');
    const path = require('path');
    const coins        = require('../../src/coins');
    const PriceFetcher = require('../../src/PriceFetcher');

    // Split the v0 product back into its two axes. Bound through getCoinPairs()
    // (the surface OracleRound actually consumes) rather than a new export, so the
    // gate cannot pass against a list the v0 lane no longer uses.
    const v0Pairs  = PriceFetcher.getCoinPairs();
    const v0Coins  = [...new Set(v0Pairs.map(p => p.split('/')[0]))];
    const v0Fiats  = [...new Set(v0Pairs.map(p => p.split('/')[1]))];

    it('the v1 coin fence equals the v0 lane coin registry', function () {
        expect(constants.PRICE_V1_COINS,
            'PRICE_V1_COINS and the v0 lane disagree; a coin added to only one lane is ' +
            'accepted on that lane and rejected on the other')
            .to.deep.equal(v0Coins);
        expect(v0Coins, 'PriceFetcher no longer builds its pairs from coins.ALLOWED_COINS')
            .to.deep.equal([...coins.ALLOWED_COINS]);
    });

    it('the v1 fiat fence equals the fiat axis of the v0 pair product', function () {
        expect(constants.PRICE_V1_FIATS,
            'PRICE_V1_FIATS and PriceFetcher\'s FIATS literal have drifted; the two lanes ' +
            'would accept different fiats for the same coin')
            .to.deep.equal(v0Fiats);
    });

    it('the full v1 product is exactly the v0 fetched pair set', function () {
        const v1Pairs = [];
        for (const coin of constants.PRICE_V1_COINS)
            for (const fiat of constants.PRICE_V1_FIATS) v1Pairs.push(coin + '/' + fiat);
        expect(v1Pairs.slice().sort()).to.deep.equal(v0Pairs.slice().sort());
    });

    // The one deliberate asymmetry, and the reason this gate compares the FETCHED
    // product rather than OracleRound's canonicalPairs: DERIVED_PAIRS widens what v0
    // ADMITS without widening what any hub produces, and must never join the v1 fence.
    it('keeps DERIVED_PAIRS out of the v1 fence', function () {
        for (const pair of constants.DERIVED_PAIRS) {
            const [coin, fiat] = pair.split('/');
            expect(constants.PRICE_V1_COINS,
                'DERIVED_PAIRS is v0-admission only; ' + coin + ' must not become a v1 coin')
                .to.not.include(coin);
            expect(v0Pairs, 'DERIVED_PAIRS must stay out of the FETCHED product too')
                .to.not.include(pair);
            expect(fiat).to.be.a('string');
        }
    });

    // The indexer is the arbiter for the v1 lane: it rejects these on chain, so a hub
    // fence wider than the indexer's accepts a push the chain will not carry, and a
    // narrower one refuses a push the chain accepted. Same required-sibling policy as
    // the mirror gate above, so bin/ci-all.sh can never pass this green-by-skip.
    it('the indexer config agrees with both lanes', function () {
        const REPO_ROOT = (function () {
            let dir = __dirname;
            while (!fs.existsSync(path.join(dir, 'package.json'))) {
                const up = path.dirname(dir);
                if (up === dir) throw new Error('no package.json above ' + __dirname);
                dir = up;
            }
            return dir;
        })();
        const abs = path.join(path.dirname(REPO_ROOT), 'xchain-indexer', 'src', 'config.js');
        if (!fs.existsSync(abs)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('price-lane parity gate cannot run: xchain-indexer/src/config.js ' +
                    'missing at ' + abs + '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
            this.skip();
            return;
        }
        const resolved = require.resolve(abs);
        delete require.cache[resolved];
        const cfg = require(resolved).getConfig('BTC', 'mainnet');
        expect(cfg.COINS, 'indexer COINS vs hub PRICE_V1_COINS').to.deep.equal(constants.PRICE_V1_COINS);
        expect(Object.keys(cfg.FIATS), 'indexer FIATS vs hub PRICE_V1_FIATS')
            .to.deep.equal(constants.PRICE_V1_FIATS);
    });
});
