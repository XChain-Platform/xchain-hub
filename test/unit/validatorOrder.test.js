/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * canonical validator-set ordering.
 *
 * The engine-level consequences (leader election agreeing across hubs) are
 * pinned in Consensus.test.js, OracleConsensus.test.js and Governance.test.js.
 * This suite pins the ordering PRIMITIVE itself, which all three share.
 *
 ********************************************************************/

const { expect } = require('chai');
const { canonicalValidatorOrder } = require('../../src/validator_order.js');

const V = (pubkey, addr) => ({ pubkey: pubkey, addr: addr });

describe('validator_order.canonicalValidatorOrder', function () {

    it('sorts by pubkey ascending', function () {
        let out = canonicalValidatorOrder([V('cc', 'ws://3'), V('aa', 'ws://1'), V('bb', 'ws://2')]);
        expect(out.map(v => v.pubkey)).to.deep.equal(['aa', 'bb', 'cc']);
    });

    it('is idempotent', function () {
        let once  = canonicalValidatorOrder([V('cc', 'c'), V('aa', 'a'), V('bb', 'b')]);
        let twice = canonicalValidatorOrder(once);
        expect(twice).to.deep.equal(once);
    });

    // The property that matters: the output depends on the MEMBERSHIP, not on
    // the order the caller's loader happened to produce.
    it('any permutation of the same membership yields the identical order', function () {
        let base = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map((p, i) => V(p, 'ws://' + i));
        let expected = canonicalValidatorOrder(base);
        for (let trial = 0; trial < 25; trial++) {
            let shuffled = base.slice().sort(() => Math.random() - 0.5);
            expect(canonicalValidatorOrder(shuffled)).to.deep.equal(expected);
        }
    });

    it('lowercases the sort key so case drift cannot split one key into two buckets', function () {
        let lower = canonicalValidatorOrder([V('aa', 'x'), V('bb', 'y'), V('cc', 'z')]);
        let upper = canonicalValidatorOrder([V('CC', 'z'), V('BB', 'y'), V('AA', 'x')]);
        expect(upper.map(v => v.addr)).to.deep.equal(lower.map(v => v.addr));
    });

    it('preserves the original pubkey casing on the returned entries', function () {
        let out = canonicalValidatorOrder([V('BB', 'y'), V('AA', 'x')]);
        expect(out.map(v => v.pubkey)).to.deep.equal(['AA', 'BB']);
    });

    it('breaks pubkey ties on addr, so the order is total not merely stable', function () {
        let a = canonicalValidatorOrder([V('aa', 'ws://z'), V('aa', 'ws://a'), V('aa', 'ws://m')]);
        let b = canonicalValidatorOrder([V('aa', 'ws://m'), V('aa', 'ws://z'), V('aa', 'ws://a')]);
        expect(a).to.deep.equal(b);
        expect(a.map(v => v.addr)).to.deep.equal(['ws://a', 'ws://m', 'ws://z']);
    });

    // XChainHub._propagateValidatorSet hands ONE array to five engines; an
    // in-place sort would let the first engine's canonicalization rewrite the
    // input every later engine sees.
    it('returns a new array and never mutates the input', function () {
        let input = [V('cc', 'c'), V('aa', 'a')];
        let snapshot = input.slice();
        let out = canonicalValidatorOrder(input);
        expect(out).to.not.equal(input);
        expect(input).to.deep.equal(snapshot);
    });

    it('carries every other field through untouched', function () {
        let out = canonicalValidatorOrder([
            { pubkey: 'bb', addr: 'b', source: 'srcB', weight: '100' },
            { pubkey: 'aa', addr: 'a', source: 'srcA', weight: '900' }
        ]);
        expect(out[0]).to.deep.equal({ pubkey: 'aa', addr: 'a', source: 'srcA', weight: '900' });
        expect(out[1].weight).to.equal('100');
    });

    it('empty set stays empty', function () {
        expect(canonicalValidatorOrder([])).to.deep.equal([]);
    });

    it('tolerates missing / null pubkeys and addrs without throwing', function () {
        let out = canonicalValidatorOrder([V('bb', 'b'), { addr: 'noKey' }, { pubkey: null, addr: null }, V('aa', 'a')]);
        expect(out).to.have.length(4);
        // Empty sort keys collate first; the two real keys keep ascending order.
        expect(out[2].pubkey).to.equal('aa');
        expect(out[3].pubkey).to.equal('bb');
    });

    // A non-array is passed through so a malformed caller value fails where it
    // always failed, instead of being silently rewritten to an empty set here.
    it('passes a non-array through unchanged', function () {
        expect(canonicalValidatorOrder(null)).to.equal(null);
        expect(canonicalValidatorOrder(undefined)).to.equal(undefined);
        let obj = { not: 'an array' };
        expect(canonicalValidatorOrder(obj)).to.equal(obj);
    });
});
