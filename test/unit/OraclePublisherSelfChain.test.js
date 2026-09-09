/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * SELF-CHAIN INPUT SELECTION.
 *
 * A catch-up sweep sends four wires inside one second. The first wires spend the
 * address's confirmed outputs; with confirmed-inputs-only in force the wires
 * after them see dust alone, and a dust sweep prices its own fee above the dust
 * it collects, so the encoder answers insufficient funds. The narrow exception
 * is a wire spending the change of a wire THIS pass already broadcast.
 *
 * What must NOT relax with it: a third party's unconfirmed output stays
 * unspendable, the chain is depth-bounded, an unreadable confirmations field
 * disables the filter rather than reading as "all unconfirmed", and nothing
 * survives into a later pass.
 */

'use strict';

const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');

const OraclePublisher = require('../../src/OraclePublisher.js');

const ME   = 'aa'.repeat(32);
const ADDR = 'DPubLisherAddr1111111111111111111';
const BIG  = '15260506722571';   // one funded output, the shape validator01 carries
const DUST = '10428789';         // one dust output

let tmpDirs = [];

function utxo(txid, confirmations, value) {
    let out = { txid: txid, vout: 0, value: value || BIG };
    if (confirmations !== null) out.confirmations = confirmations;
    return out;
}

function makePublisher(opts) {
    opts = opts || {};
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-pub-selfchain-'));
    tmpDirs.push(dir);
    let hub = {
        p2pConfig: Object.assign({ PUBLISHER_QUEUE_PATH: path.join(dir, 'publisher-queue.jsonl') },
                                 opts.cfg || {}),
        network:            'regtest',
        db:                 null,
        getIdentity:        () => ({ getPubkeyHex: () => ME, sign: () => 'dd'.repeat(64) }),
        capabilitySnapshot: null,
        oracleConsensus:    null,
        oracleBatchSigner:  null
    };
    let p = new OraclePublisher(hub);
    p.dogeAddress   = ADDR;
    p.dogePubkeyHex = 'ee'.repeat(33);
    return { p, dir, queuePath: path.join(dir, 'publisher-queue.jsonl') };
}

describe('OraclePublisher: spending its own change inside one pass', function () {

    afterEach(function () {
        sinon.restore();
        for (let d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* temp dir */ } }
        tmpDirs = [];
    });

    describe('_selectInputs', function () {

        it('refuses every unconfirmed input while this pass has broadcast nothing', function () {
            const { p } = makePublisher();
            const set = [utxo('c1'.repeat(32), 6), utxo('u1'.repeat(32), 0)];
            const sel = p._selectInputs(set);
            expect(sel.unconfirmed, 'the confirmed-inputs-only rule still holds').to.equal(false);
            expect(sel.utxos).to.equal(set);   // forwarded untouched
        });

        it('adds this pass\'s own change and allows spending it', function () {
            const { p } = makePublisher();
            const mine = 'ab'.repeat(32);
            p._passSelfChange.add(mine);
            p._passChainDepth = 1;
            const sel = p._selectInputs([utxo('c1'.repeat(32), 6, DUST), utxo(mine, 0)]);
            expect(sel.unconfirmed).to.equal(true);
            expect(sel.utxos.map(u => u.txid)).to.deep.equal(['c1'.repeat(32), mine]);
        });

        it('excludes a third party\'s unconfirmed output from the set it hands over', function () {
            const { p } = makePublisher();
            const mine   = 'ab'.repeat(32);
            const theirs = 'ff'.repeat(32);
            p._passSelfChange.add(mine);
            p._passChainDepth = 1;
            const sel = p._selectInputs([utxo('c1'.repeat(32), 6, DUST), utxo(mine, 0), utxo(theirs, 0)]);
            expect(sel.unconfirmed).to.equal(true);
            // The forwarded array IS the encoder's candidate set, so an omitted
            // output cannot be selected however the encoder ranks inputs.
            expect(sel.utxos.map(u => u.txid)).to.not.include(theirs);
            expect(sel.utxos).to.have.length(2);
        });

        it('stops chaining at the depth bound', function () {
            const { p } = makePublisher();
            const mine = 'ab'.repeat(32);
            p._passSelfChange.add(mine);
            p._passChainDepth = p.selfChainMaxDepth;
            const sel = p._selectInputs([utxo('c1'.repeat(32), 6), utxo(mine, 0)]);
            expect(sel.unconfirmed).to.equal(false);
        });

        it('takes the depth bound from config', function () {
            const { p } = makePublisher({ cfg: { ORACLE_PUBLISH_SELF_CHAIN_MAX_DEPTH: '1' } });
            expect(p.selfChainMaxDepth).to.equal(1);
            const mine = 'ab'.repeat(32);
            p._passSelfChange.add(mine);
            p._passChainDepth = 1;
            expect(p._selectInputs([utxo(mine, 0)]).unconfirmed).to.equal(false);
        });

        it('disables the filter when any output arrives without a readable depth', function () {
            const { p } = makePublisher();
            const mine = 'ab'.repeat(32);
            p._passSelfChange.add(mine);
            p._passChainDepth = 1;
            const set = [utxo('c1'.repeat(32), null), utxo(mine, 0)];
            const sel = p._selectInputs(set);
            expect(sel.unconfirmed, 'unknown depth must not read as unconfirmed').to.equal(false);
            expect(sel.utxos).to.equal(set);
        });

        it('leaves the regtest escape hatch exactly as it was', function () {
            const { p } = makePublisher({ cfg: { ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS: 'true' } });
            expect(p.allowUnconfirmedInputs).to.equal(true);
            const set = [utxo('c1'.repeat(32), 0)];
            const sel = p._selectInputs(set);
            expect(sel.unconfirmed).to.equal(true);
            expect(sel.utxos).to.equal(set);
        });

        it('does not claim to bound a set the encoder will re-fetch past the cap', function () {
            const { p } = makePublisher();
            const mine = 'ab'.repeat(32);
            p._passSelfChange.add(mine);
            p._passChainDepth = 1;
            let big = [];
            for (let i = 0; i < 501; i++) big.push(utxo(String(i).padStart(64, '0'), 6, DUST));
            big.push(utxo(mine, 0));
            const sel = p._selectInputs(big);
            // Past the cap the caller's forwardableUtxos drops the param and the
            // encoder selects from its own fetch, which this filter cannot bound,
            // so the exception must not be claimed there.
            expect(sel.utxos).to.equal(big);
            expect(sel.unconfirmed, 'unconfirmed stays refused past the cap').to.equal(false);
        });
    });

    describe('through a publish pass', function () {

        // An encoder that models the real failure: it may spend only what it is
        // handed, unconfirmed entries only when the flag allows, and it refuses a
        // build whose selectable value cannot cover a dust-sweep fee.
        function dustAwareEncoder(state) {
            const FEE = 5000000000;   // a sweep of dust costs more than the dust is worth
            return {
                getUtxos: sinon.stub().callsFake(async () => state.utxos),
                createTx: sinon.stub().callsFake(async ({ utxos, unconfirmed }) => {
                    let set = Array.isArray(utxos) ? utxos : state.utxos;
                    let spendable = set.filter(u => unconfirmed || Number(u.confirmations) >= 1);
                    let total = spendable.reduce((a, u) => a + Number(u.value), 0);
                    state.builds.push({ inputs: spendable.map(u => u.txid), unconfirmed: !!unconfirmed });
                    if (total < FEE) {
                        let e = new Error('insufficient funds: selected inputs total ' + total +
                                          ' but ' + FEE + ' is required');
                        e.code = 'ENCODER_RPC_ERROR';
                        throw e;
                    }
                    // MULTISIGN, not the P2SH the live pipeline asks for: P2SH is the
                    // two-phase encoding assertSingleTxEncoding refuses, and this test
                    // is about input selection, not about that guard.
                    return { psbt: 'psbt-' + state.builds.length, encoding: 'MULTISIGN' };
                }),
                broadcastTx: sinon.stub().callsFake(async () => {
                    let txid = 'ch'.repeat(31) + String(state.builds.length).padStart(2, '0');
                    // The wire spends the funded output and leaves its change unconfirmed,
                    // which is exactly the state the next wire in the pass meets.
                    state.utxos = state.utxos.filter(u => Number(u.confirmations) < 1 || u.value === DUST)
                                             .concat([utxo(txid, 0, BIG)]);
                    return { txid };
                })
            };
        }

        function seed(h, rounds) {
            fs.writeFileSync(h.queuePath, rounds.map(r => JSON.stringify({
                round: r, btcBlockTime: 1800000000 + r * 600, btcBlockHeight: 900000 + r,
                prices: [{ coinPair: 'BTC/USD', price: '60000.12' }],
                sigs: [{ pubkey: ME, sig: 'cc'.repeat(64) }], attempts: 0
            })).join('\n') + '\n');
        }

        it('publishes every wire of a sweep instead of stalling once the confirmed outputs run out', async function () {
            sinon.stub(console, 'log');
            sinon.stub(console, 'warn');
            sinon.stub(console, 'error');
            const { p, queuePath } = makePublisher();
            // One funded output and two dust ones: wire 1 spends the funded output,
            // and before this fix wires 2 and 3 saw dust alone and both failed.
            const state = { utxos: [utxo('f1'.repeat(32), 6, BIG), utxo('d1'.repeat(32), 6, DUST),
                                    utxo('d2'.repeat(32), 6, DUST)], builds: [] };
            p.encoder = dustAwareEncoder(state);
            p.setWalletSignHook(async () => 'ff'.repeat(120));
            seed({ queuePath }, [101, 102, 103]);

            await p._processQueue();

            expect(state.builds, 'three wires attempted').to.have.length(3);
            expect(p.publishedCount, 'all three published').to.equal(3);
            expect(state.builds[0].unconfirmed, 'the first wire needs no exception').to.equal(false);
            expect(state.builds[1].unconfirmed, 'the second spends the first wire\'s change').to.equal(true);
            expect(state.builds[2].unconfirmed).to.equal(true);
            expect(fs.existsSync(queuePath) && fs.readFileSync(queuePath, 'utf8').trim(),
                   'the queue drains').to.equal('');
        });

        it('carries no txid from one pass into the next', async function () {
            sinon.stub(console, 'log');
            sinon.stub(console, 'warn');
            sinon.stub(console, 'error');
            const { p, queuePath } = makePublisher();
            const state = { utxos: [utxo('f1'.repeat(32), 6, BIG)], builds: [] };
            p.encoder = dustAwareEncoder(state);
            p.setWalletSignHook(async () => 'ff'.repeat(120));

            seed({ queuePath }, [201]);
            await p._processQueue();
            expect(p._passSelfChange.size, 'the pass tracked its own send').to.equal(1);
            expect(p._passChainDepth).to.equal(1);

            // The change confirms between passes, which is the normal case.
            state.utxos = [utxo('f2'.repeat(32), 6, BIG)];
            seed({ queuePath }, [202]);
            await p._processQueue();

            expect(p._passChainDepth, 'depth restarted with the pass').to.equal(1);
            expect(state.builds[1].unconfirmed, 'a fresh pass claims no exception').to.equal(false);
        });
    });
});
