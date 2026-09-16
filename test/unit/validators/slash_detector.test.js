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

const sinon          = require('sinon');
const { expect }     = require('chai');
const SlashDetector  = require('../../../src/validators/slash_detector');
const { createMockHub }     = require('../../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../../helpers/fixtures');

let hub, pm, sd;

function installSuiteHooks1() {
    beforeEach(function () {
            hub = createMockHub({
                p2pConfig: {
                    SLASH_DEVIATION_THRESHOLD:    '0.05',
                    SLASH_MISSED_ROUNDS_THRESHOLD: '30'
                }
            });
            pm = hub._peerManager;
            // Map addrs → pubkeys so resolveValidatorPubkey works
            pm.validatorPubkeys = new Map([
                [VALIDATORS_3[0].addr, VALIDATORS_3[0].pubkey],
                [VALIDATORS_3[1].addr, VALIDATORS_3[1].pubkey],
                [VALIDATORS_3[2].addr, VALIDATORS_3[2].pubkey]
            ]);
            sd = new SlashDetector(hub);
        });
    afterEach(function () {
            sinon.restore();
        });
}

// Seed a validator's sliding window with `misses` missed rounds
// (newest last), as if checkParticipation had run that many times.
function seedMisses(pubkey, misses) {
            sd.participation.set(pubkey, {
                history: new Array(misses).fill(true),
                missed:  misses
            });
}

// Drive `n` rounds through checkParticipation with the given participants.
async function runRounds(n, participants, startRound) {
            for (let i = 0; i < n; i++) {
                await sd.checkParticipation((startRound || 1) + i, participants, VALIDATORS_3);
            }
}

// -----------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------
describe('SlashDetector', function () {
    installSuiteHooks1();
describe('configuration', function () {
it('parses deviation threshold from config', function () {
            expect(sd.deviationThreshold).to.equal(0.05);
        });
it('parses missed rounds threshold from config', function () {
            expect(sd.missedRoundsThreshold).to.equal(30);
        });
it('uses defaults when config is empty', function () {
            let sd2 = new SlashDetector(createMockHub({ p2pConfig: {} }));
            expect(sd2.deviationThreshold).to.equal(0.05);
            expect(sd2.missedRoundsThreshold).to.equal(30);
        });
it('binds the default slash band to the federation-uniform oracle co-sign band', function () {
            let { ORACLE_DEVIATION_THRESHOLD } = require('../../../src/constants');
            let sd2 = new SlashDetector(createMockHub({ p2pConfig: {} }));
            expect(sd2.deviationThreshold).to.equal(ORACLE_DEVIATION_THRESHOLD);
        });
it('fail-fasts on a slash band tighter than the co-sign band (would slash inside the co-signed band)', function () {
            expect(() => new SlashDetector(createMockHub({ p2pConfig: { SLASH_DEVIATION_THRESHOLD: '0.03' } })))
                .to.throw(/below the federation-uniform ORACLE_DEVIATION_THRESHOLD/);
        });
it('warns (but runs) on a looser slash band', function () {
            let warn = sinon.stub(console, 'warn');
            let sd2 = new SlashDetector(createMockHub({ p2pConfig: { SLASH_DEVIATION_THRESHOLD: '0.0625' } }));
            expect(sd2.deviationThreshold).to.equal(0.0625);
            expect(warn.calledWithMatch(/diverges from the federation-uniform/)).to.equal(true);
        });
});
});

// The tightest band an operator can express is exactly the one a falsy-zero
// `||` default eats, so 0 is the case that proves the override is read at all
// rather than merely parsed. Both spellings: api.js forwards the env as the
// string '0', while a programmatic caller (XChainHub, an e2e helper) can hand
// over the number.
describe('SlashDetector', function () {
    installSuiteHooks1();
describe('configuration', function () {
it('fail-fasts on an explicit string 0 slash band instead of silently defaulting', function () {
            expect(() => new SlashDetector(createMockHub({ p2pConfig: { SLASH_DEVIATION_THRESHOLD: '0' } })))
                .to.throw(/below the federation-uniform ORACLE_DEVIATION_THRESHOLD/);
        });
it('fail-fasts on an explicit numeric 0 slash band', function () {
            expect(() => new SlashDetector(createMockHub({ p2pConfig: { SLASH_DEVIATION_THRESHOLD: 0 } })))
                .to.throw(/below the federation-uniform ORACLE_DEVIATION_THRESHOLD/);
        });
// A non-numeric override must not survive as NaN. checkDeviations does not
// compare the band with a JS `>`; it hands it to deviation_band.exceedsBand,
// which returns TRUE against a NaN band for any deviation at all. So a NaN band
// does not disable slashing, it slashes every honest submitter, breaching the
// never-slash-inside-the-co-signed-band invariant the constructor documents.
it('fail-fasts on a non-numeric slash band rather than carrying NaN into the band', function () {
            expect(() => new SlashDetector(createMockHub({ p2pConfig: { SLASH_DEVIATION_THRESHOLD: 'abc' } })))
                .to.throw(/is not a valid number/);
        });
it('treats an empty-string override as absent (default band, no warning)', function () {
            let warn = sinon.stub(console, 'warn');
            let sd2 = new SlashDetector(createMockHub({ p2pConfig: { SLASH_DEVIATION_THRESHOLD: '' } }));
            expect(sd2.deviationThreshold).to.equal(0.05);
            expect(warn.calledWithMatch(/diverges from the federation-uniform/)).to.equal(false);
        });
it('treats an absent override as absent (default band, no warning)', function () {
            let warn = sinon.stub(console, 'warn');
            let sd2 = new SlashDetector(createMockHub({ p2pConfig: {} }));
            expect(sd2.deviationThreshold).to.equal(0.05);
            expect(warn.calledWithMatch(/diverges from the federation-uniform/)).to.equal(false);
        });
});
});

// -----------------------------------------------------------------
// Price deviation detection
// -----------------------------------------------------------------
describe('SlashDetector', function () {
    installSuiteHooks1();
describe('price deviation', function () {
it('4% deviation does NOT trigger slash', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '104000' }] // 4% deviation
            }]);

            await sd.checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('6% deviation DOES trigger slash', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '106000' }] // 6% deviation
            }]);

            await sd.checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include('slash_proposals');
            expect(args[1][1]).to.equal('price_deviation');
        });
it('exactly 5% deviation does NOT trigger slash (threshold is strictly greater)', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '105000' }] // exactly 5%
            }]);

            await sd.checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('negative deviation (lower price) is detected', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '93000' }] // -7% deviation
            }]);

            await sd.checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.true;
        });
it('skips validators without resolved pubkey', async function () {
            pm.validatorPubkeys = new Map(); // Empty: no pubkeys can resolve
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: 'unknown-addr',
                prices: [{ coinPair: 'BTC/USD', price: '200000' }]
            }]);

            await sd.checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.false;
        });
});
});

describe('SlashDetector', function () {
    installSuiteHooks1();
describe('price deviation', function () {
it('handles null/empty submissions gracefully', async function () {
            await sd.checkDeviations(1, null, [{ coinPair: 'BTC/USD', price: '100000' }]);
            await sd.checkDeviations(1, new Map(), null);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('skips submissions with no prices array, unknown coin pairs, and non-numeric prices', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = new Map([
                [VALIDATORS_3[0].addr, { prices: null }],                                  // no prices array
                [VALIDATORS_3[1].addr, { prices: [{ coinPair: 'ETH/USD', price: '5000' }] }], // coin pair not finalized
                [VALIDATORS_3[2].addr, { prices: [{ coinPair: 'BTC/USD', price: 'abc' }] }]   // non-numeric price
            ]);
            await sd.checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('aggregates multiple deviating pairs into ONE proposal per validator per round (F12)', async function () {
            let finalizedPrices = [
                { coinPair: 'BTC/USD',    price: '100000' },
                { coinPair: 'LTC/USD',    price: '100' },
                { coinPair: 'DOGE/USD',   price: '0.2' }
            ];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [
                    { coinPair: 'BTC/USD',  price: '110000' }, // 10%
                    { coinPair: 'LTC/USD',  price: '110' },    // 10%
                    { coinPair: 'DOGE/USD', price: '0.22' }    // 10%
                ]
            }]);

            await sd.checkDeviations(7, subs, finalizedPrices);

            // Exactly one slash_proposals INSERT for the round
            expect(hub.db.doQuery.callCount).to.equal(1);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][1]).to.equal('price_deviation');
            expect(args[1][2]).to.equal(7);
            let evidence = JSON.parse(args[1][3]);
            expect(evidence.pairCount).to.equal(3);
            expect(evidence.pairs.map(p => p.coinPair)).to.deep.equal(['BTC/USD', 'LTC/USD', 'DOGE/USD']);
        });
});
});

describe('SlashDetector', function () {
    installSuiteHooks1();
describe('price deviation', function () {
it('tracks ONE deviation entry per round regardless of deviating pair count (F12)', async function () {
            let finalizedPrices = [
                { coinPair: 'BTC/USD', price: '100000' },
                { coinPair: 'LTC/USD', price: '100' }
            ];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [
                    { coinPair: 'BTC/USD', price: '110000' },
                    { coinPair: 'LTC/USD', price: '110' }
                ]
            }]);

            await sd.checkDeviations(7, subs, finalizedPrices);
            expect(sd.recentDeviations.get(VALIDATORS_3[0].pubkey).length).to.equal(1);
        });
});
});

// -----------------------------------------------------------------
// Non-participation detection
// -----------------------------------------------------------------
describe('SlashDetector', function () {
    installSuiteHooks1();
describe('non-participation (windowed rate)', function () {
it('window defaults to 2x the missed-rounds threshold', function () {
            expect(sd.participationWindowSize).to.equal(60);
        });
it('honors a SLASH_PARTICIPATION_WINDOW override', function () {
            let hub2 = createMockHub({ p2pConfig: { SLASH_PARTICIPATION_WINDOW: '90' } });
            expect(new SlashDetector(hub2).participationWindowSize).to.equal(90);
        });
it('fail-fasts on a window smaller than the missed-rounds threshold', function () {
            let hub2 = createMockHub({ p2pConfig: { SLASH_PARTICIPATION_WINDOW: '10' } });
            expect(() => new SlashDetector(hub2))
                .to.throw(/SLASH_PARTICIPATION_WINDOW/);
        });
it('29 misses in the window does NOT trigger slash', async function () {
            seedMisses(VALIDATORS_3[0].pubkey, 28);

            await sd.checkParticipation(29, [], VALIDATORS_3);
            expect(sd.participation.get(VALIDATORS_3[0].pubkey).missed).to.equal(29);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('30 misses in the window triggers non_participation slash and latches', async function () {
            seedMisses(VALIDATORS_3[0].pubkey, 29);

            await sd.checkParticipation(30, [], VALIDATORS_3);
            expect(sd.participation.get(VALIDATORS_3[0].pubkey).missed).to.equal(30);
            expect(hub.db.doQuery.called).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][1]).to.equal('non_participation');
            let evidence = JSON.parse(args[1][3]);
            expect(evidence.missedRounds).to.equal(30);
            expect(evidence.windowRounds).to.equal(30);
            expect(evidence.participationRate).to.equal('0.0000');
            // Latched after the row persisted, so it won't re-fire next round.
            expect(sd.nonParticipationFired.get(VALIDATORS_3[0].pubkey)).to.be.true;
        });
it('a single participation does NOT reset the window (S-F4: 1-in-30 no longer evades)', async function () {
            // 29 misses, one participation, then more misses. The old consecutive
            // counter reset to 0 on the participation and never fired.
            seedMisses(VALIDATORS_3[0].pubkey, 29);
            await sd.checkParticipation(30, [VALIDATORS_3[0].pubkey], VALIDATORS_3);
            expect(hub.db.doQuery.called).to.be.false;

            // One more miss: 30 misses in the last 31 rounds → fires.
            await sd.checkParticipation(31, [], VALIDATORS_3);
            expect(hub.db.doQuery.called).to.be.true;
            let evidence = JSON.parse(hub.db.doQuery.getCall(0).args[1][3]);
            expect(evidence.missedRounds).to.equal(30);
            expect(evidence.windowRounds).to.equal(31);
        });
});
});
