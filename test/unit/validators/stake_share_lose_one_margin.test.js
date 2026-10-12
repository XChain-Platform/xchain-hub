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

// Whether the two-thirds gate survives losing the largest staking source,
// judged by the gate's own predicate.

const { expect } = require('chai');

const { quorumAfterLosingLargest } = require('../../../src/validators/stake_share/lose_one.js');
const { makeVenue, makeWatcher } = require('../../helpers/stakeShareVenue.js');

function rows(weights) {
    return weights.map((w, i) => ({ pubkey: 'pk' + i, source: 's' + i, weight: String(w) }));
}

describe('quorumAfterLosingLargest', function () {

    it('survives when the rest hold strictly more than two-thirds', function () {
        const res = quorumAfterLosingLargest(rows([10, 10, 10, 10, 10, 10]));
        expect(res.survives).to.equal(true);
        expect(res.largestStake).to.equal('10');
        expect(res.remainingStake).to.equal('50');
        expect(res.totalStake).to.equal('60');
    });

    it('fails exactly at the boundary, where the rest hold two-thirds and no more', function () {
        const res = quorumAfterLosingLargest(rows([10, 10, 10]));
        expect(res.usable).to.equal(true);
        expect(res.survives).to.equal(false);
    });

    it('fails when one source holds a third or more', function () {
        expect(quorumAfterLosingLargest(rows([40, 20, 20, 20])).survives).to.equal(false);
        expect(quorumAfterLosingLargest(rows([30, 20, 20, 20, 10])).survives).to.equal(true);
    });

    it('treats a source with several keys as one source', function () {
        const v = rows([10, 10, 10, 10, 10, 10]);
        v.push({ pubkey: 'extra', source: 's0', weight: '10' });
        const res = quorumAfterLosingLargest(v);
        expect(res.survives).to.equal(true);
        expect(res.totalStake).to.equal('60');
    });

    it('fails a single-source and an empty set', function () {
        expect(quorumAfterLosingLargest(rows([10])).survives).to.equal(false);
        expect(quorumAfterLosingLargest([]).survives).to.equal(false);
    });

    it('reports a snapshot the predicate fails closed on as unusable and not surviving', function () {
        const truncated = rows([10, 10, 10, 10, 10, 10]);
        truncated.truncated = true;
        const res = quorumAfterLosingLargest(truncated);
        expect(res.usable).to.equal(false);
        expect(res.survives).to.equal(false);
        expect(quorumAfterLosingLargest([{ pubkey: 'a', source: '', weight: '1' }]).usable).to.equal(false);
    });

    it('stays exact on large decimal stakes', function () {
        const res = quorumAfterLosingLargest(rows(['33333333333333333333.0000001', '33333333333333333333', '33333333333333333334']));
        expect(res.survives).to.equal(false);
    });
});

describe('StakeShareWatcher lose-one margin', function () {
    it('warns once when losing the largest source breaks quorum, though the all-up share is fine', async function () {
        const venue = makeVenue({ sources: ['ours1', 'community1', 'community2'] });
        const { watcher, lines } = makeWatcher(venue);
        await watcher.pollOnce();
        await watcher.pollOnce();
        const warned = lines.filter(l => l.includes('STAKE SHARE LOSE-ONE'));
        expect(warned).to.have.length(1);
        expect(warned[0]).to.contain('BTC/price');
        expect(watcher.getStats().lose_one['BTC:price'].survives).to.equal(false);
    });

    it('stays quiet when quorum survives losing the largest source', async function () {
        const { watcher, lines } = makeWatcher(makeVenue());
        await watcher.pollOnce();
        expect(lines.filter(l => l.includes('LOSE-ONE'))).to.have.length(0);
        expect(watcher.getStats().lose_one['BTC:price'].survives).to.equal(true);
    });

    it('says when the margin recovers', async function () {
        const venue = makeVenue({ sources: ['ours1', 'community1', 'community2'] });
        const { watcher, lines } = makeWatcher(venue);
        await watcher.pollOnce();
        venue.sources = ['ours1', 'ours2', 'ours3', 'community1', 'community2', 'community3'];
        await watcher.pollOnce();
        expect(lines.some(l => l.includes('lose-one cleared'))).to.equal(true);
    });
});
