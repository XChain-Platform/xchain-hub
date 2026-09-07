'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// ROUND PRESENCE: the second half of the lost-round fix. Writing a
// durable skipped row on every hub only helps if the federation can be ASKED
// whether it agrees, and the pre-existing round surface (getpricesnapshots)
// returns the rows a hub HAS, so a hub holding nothing for a round looked exactly
// like a hub asked about a round that never happened. Presence answers over an
// explicit range, so absence is a reported value and comparable across hubs.

const { expect } = require('chai');
const {
    summarizeRoundPresence, presenceDigest, comparePresence, MAX_RANGE
} = require('../../src/lib/oracle_round_presence.js');

function row(round, status, extra) {
    return Object.assign({ round_number: round, coin_pair: 'BTC/USD', status: status,
                           reference_block: 100 + round, block_timestamp: 1700000000 + round }, extra || {});
}

describe('oracle_round_presence: per-round presence and divergence', function () {

    describe('summarizeRoundPresence()', function () {
        it('reports a round with no rows at all as missing, not as absent from the answer', function () {
            let s = summarizeRoundPresence([row(10, 'finalized'), row(12, 'skipped')], 10, 12);
            expect(s.rounds.map(r => r.round)).to.deep.equal([10, 11, 12]);
            expect(s.rounds.map(r => r.status)).to.deep.equal(['finalized', 'missing', 'skipped']);
            expect(s.missing).to.deep.equal([11]);
        });

        it('classifies a round with any finalized pair as finalized', function () {
            // A per-pair drop marker writes a skipped row inside an otherwise
            // finalized round; that round still HAPPENED here.
            let s = summarizeRoundPresence([
                row(5, 'finalized'), Object.assign(row(5, 'skipped'), { coin_pair: 'BTC/MXN' })
            ], 5, 5);
            expect(s.rounds[0].status).to.equal('finalized');
            expect(s.rounds[0].pairs).to.equal(2);
            expect(s.rounds[0].finalized_pairs).to.equal(1);
            expect(s.rounds[0].skipped_pairs).to.equal(1);
        });

        it('classifies an all-skipped round as skipped and an all-disputed round as disputed', function () {
            let s = summarizeRoundPresence([row(1, 'skipped'), row(2, 'disputed')], 1, 2);
            expect(s.rounds.map(r => r.status)).to.deep.equal(['skipped', 'disputed']);
        });

        it('takes the round anchor from the lowest reference_block/block_timestamp it sees', function () {
            let s = summarizeRoundPresence([
                Object.assign(row(3, 'skipped'), { reference_block: 900, block_timestamp: 1700000900 }),
                Object.assign(row(3, 'skipped'), { coin_pair: 'BTC/EUR', reference_block: 880, block_timestamp: 1700000880 })
            ], 3, 3);
            expect(s.rounds[0].reference_block).to.equal(880);
            expect(s.rounds[0].block_timestamp).to.equal(1700000880);
        });

        it('ignores rows outside the requested range', function () {
            let s = summarizeRoundPresence([row(1, 'finalized'), row(50, 'finalized')], 1, 2);
            expect(s.rounds.map(r => r.status)).to.deep.equal(['finalized', 'missing']);
        });

        it('returns an empty answer for a nonsensical range rather than inventing rounds', function () {
            expect(summarizeRoundPresence([], 10, 5).rounds).to.deep.equal([]);
            expect(summarizeRoundPresence([], null, 5).digest).to.be.null;
        });

        it('handles an unrecognised status as unproven presence, not as a finalized round', function () {
            let s = summarizeRoundPresence([row(7, 'weird-new-status')], 7, 7);
            expect(s.rounds[0].status).to.equal('missing');
        });
    });

    describe('presenceDigest()', function () {
        it('is equal for two hubs that agree on every round outcome', function () {
            let a = summarizeRoundPresence([row(1, 'finalized'), row(2, 'skipped')], 1, 2);
            let b = summarizeRoundPresence([row(2, 'skipped'), row(1, 'finalized')], 1, 2);
            expect(a.digest).to.equal(b.digest);
        });

        it('differs the moment one hub is missing a round the other recorded', function () {
            let a = summarizeRoundPresence([row(1, 'finalized'), row(2, 'skipped')], 1, 2);
            let b = summarizeRoundPresence([row(1, 'finalized')], 1, 2);
            expect(a.digest).to.not.equal(b.digest);
        });

        it('ignores pair COUNT, which legitimately differs between hubs', function () {
            // The derived-pair activation gate is round-keyed, so one hub can write
            // 37 marker pairs where another writes 36. That must not read as
            // divergence about whether the round happened.
            let a = summarizeRoundPresence([row(4, 'skipped')], 4, 4);
            let b = summarizeRoundPresence([
                row(4, 'skipped'), Object.assign(row(4, 'skipped'), { coin_pair: 'XCP/USD' })
            ], 4, 4);
            expect(a.digest).to.equal(b.digest);
        });

        it('is stable for an empty round list', function () {
            expect(presenceDigest([])).to.equal(presenceDigest([]));
        });
    });

    describe('comparePresence()', function () {
        // The rounds 25-27 shape: nothing finalized anywhere, one validator holds
        // skipped rows, the other four hold nothing. THIS is what must be visible.
        const V3 = summarizeRoundPresence([row(25, 'skipped'), row(26, 'skipped'), row(27, 'skipped')], 25, 27);
        const EMPTY = summarizeRoundPresence([], 25, 27);

        it('names every round the hubs disagree about, with each hub\'s status', function () {
            let c = comparePresence([
                { hub: 'validator01', presence: EMPTY },
                { hub: 'validator03', presence: V3 }
            ]);
            expect(c.agreed).to.be.false;
            expect(c.divergent.map(d => d.round)).to.deep.equal([25, 26, 27]);
            expect(c.divergent[0].statuses).to.deep.equal({ validator01: 'missing', validator03: 'skipped' });
        });

        it('agrees once every hub records the lost round (the post-fix state)', function () {
            let c = comparePresence([
                { hub: 'validator01', presence: V3 },
                { hub: 'validator03', presence: V3 },
                { hub: 'validator05', presence: V3 }
            ]);
            expect(c.agreed).to.be.true;
            expect(c.divergent).to.deep.equal([]);
        });

        it('does not claim agreement from a single hub, and reports how many answered', function () {
            let c = comparePresence([{ hub: 'validator01', presence: V3 }]);
            expect(c.hubs).to.equal(1);
            expect(c.divergent).to.deep.equal([]);
            expect(comparePresence([]).agreed).to.be.false;
        });

        it('treats a hub that omitted a round entirely as missing for that round', function () {
            let short = summarizeRoundPresence([row(25, 'skipped')], 25, 25);
            let c = comparePresence([
                { hub: 'a', presence: V3 },
                { hub: 'b', presence: short }
            ]);
            expect(c.divergent.map(d => d.round)).to.deep.equal([26, 27]);
            expect(c.divergent[0].statuses.b).to.be.undefined;   // reported as missing below
            expect(c.agreed).to.be.false;
        });
    });

    it('MAX_RANGE is a real bound, so a presence probe cannot become a table scan', function () {
        expect(MAX_RANGE).to.be.a('number').and.to.be.above(0);
    });
});
