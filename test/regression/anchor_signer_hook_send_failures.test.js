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

// Regression guards for a signer hook's send failures on the DOGE publishing rails.
//
// Anchors reach DOGE through the operator signer hook (resolveSigner().broadcastFn),
// a two-phase pipeline that funds a P2SH output and then reveals the payload. Its
// failures come in three shapes: neverSent (nothing broadcast, safe to rebuild),
// untagged (the hub classifies the error itself), and fundsCommitted plus phase1Txid,
// revealTxid and revealTxHex (the funding is on chain, the reveal did not go out).
// broadcastWithRetry calls the hook again on every retry, and each call runs a fresh
// createTx and funds the same anchor again, so an ambiguous or funds-committed
// failure must never be retried, the publish intent must stay armed, and the reveal
// fields must reach the anchor dead-letter record an operator works from.
//
// Every case drives the real publisher code with a fake hook. No network, no DB.

const { expect } = require('chai');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const StateAnchorPublisher = require('../../src/anchor/publisher');

const PHASE1 = 'f'.repeat(64);
const REVEAL = 'e'.repeat(64);

const shapes = {
    revealRefused: () => Object.assign(new Error('Encoder RPC error: min relay fee not met'),
        { fundsCommitted: true, phase1Txid: PHASE1, revealTxid: REVEAL, revealTxHex: 'reveal-hex' }),
    reveal429: () => Object.assign(new Error('Request failed with status code 429'),
        { response: { status: 429, headers: {} }, fundsCommitted: true, phase1Txid: PHASE1,
          revealTxid: REVEAL, revealTxHex: 'reveal-hex' }),
    commitTimeout: () => Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }),
    neverSent: () => Object.assign(new Error('Encoder RPC error: reveal leg below dust'), { neverSent: true })
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-anchor-dl-'));
let dlSeq = 0;

function mkPub() {
    const pub = new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    pub.chunkRetryDelayMs = 0;
    pub.rateLimitMaxWaitMs = 0;
    pub.ambiguousPollAttempts = 1;
    pub.ambiguousPollDelayMs = 0;
    pub.anchorDeadLetterPath = path.join(scratch, 'anchor-' + (++dlSeq) + '.deadletter.jsonl');
    return pub;
}

function deadLetters(pub) {
    if (!fs.existsSync(pub.anchorDeadLetterPath)) return [];
    return fs.readFileSync(pub.anchorDeadLetterPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

function countingHook(makeErr) {
    const hook = async () => { hook.calls++; throw makeErr(); };
    hook.calls = 0;
    return hook;
}

async function runRetry(pub, hook, existsCheck) {
    try { await pub.broadcastWithRetry(hook, 'ANCHOR|0|payload', undefined, existsCheck); }
    catch (e) { return e; }
    return null;
}

const absent = async () => null;   // the indexer: definitively not on chain

function registerRetryCases() {
    describe('REG-ANCHOR-HOOK-001: broadcastWithRetry never re-enters a signer hook that may have spent', function () {
        it('a fundsCommitted reveal rejection calls the hook once, keeps the spend and dead-letters the reveal @regression-p0', async function () {
            const pub = mkPub();
            const hook = countingHook(shapes.revealRefused);
            const err = await runRetry(pub, hook, absent);
            expect(hook.calls, 'hook calls').to.equal(1);
            expect(err && err.anchorAmbiguousSend).to.equal(true);
            expect(pub.spendGuard.spentInWindow()).to.equal(pub.spendGuard.estSpendUsdCents);
            const recs = deadLetters(pub);
            expect(recs).to.have.length(1);
            expect(recs[0]).to.include({ payload: 'ANCHOR|0|payload', phase1Txid: PHASE1,
                                         revealTxid: REVEAL, revealTxHex: 'reveal-hex' });
        });

        it('a 429 on a funded reveal is not a free rate-limit retry @regression-p0', async function () {
            const pub = mkPub();
            const hook = countingHook(shapes.reveal429);
            const err = await runRetry(pub, hook, absent);
            expect(hook.calls, 'hook calls').to.equal(1);
            expect(err && err.anchorAmbiguousSend).to.equal(true);
            expect(pub.spendGuard.spentInWindow()).to.equal(pub.spendGuard.estSpendUsdCents);
            expect(deadLetters(pub)).to.have.length(1);
        });

        it('an untagged commit timeout from the hook is ambiguous: one call, spend kept @regression-p0', async function () {
            const pub = mkPub();
            const hook = countingHook(shapes.commitTimeout);
            const err = await runRetry(pub, hook, absent);
            expect(hook.calls, 'hook calls').to.equal(1);
            expect(err && err.anchorAmbiguousSend).to.equal(true);
            expect(pub.spendGuard.spentInWindow()).to.equal(pub.spendGuard.estSpendUsdCents);
            expect(deadLetters(pub), 'no reveal fields, nothing to dead-letter').to.have.length(0);
        });

        it('a hook that throws a non-error value is ambiguous too @regression-p0', async function () {
            const pub = mkPub();
            let calls = 0;
            const hook = async () => { calls++; throw 'socket closed'; };
            const err = await runRetry(pub, hook, absent);
            expect(calls, 'hook calls').to.equal(1);
            expect(err).to.be.an('error');
            expect(err.anchorAmbiguousSend).to.equal(true);
        });

    });
}

function registerControlCases() {
    describe('REG-ANCHOR-HOOK-001b: what broadcastWithRetry still adopts and retries', function () {
        it('an ambiguous hook failure the poll then finds on chain is adopted, not dead-lettered @regression-p0', async function () {
            const pub = mkPub();
            const hook = countingHook(shapes.revealRefused);
            let checks = 0;
            const res = await pub.broadcastWithRetry(hook, 'ANCHOR|0|payload', undefined, async () => {
                checks++;
                return checks >= 2 ? { exists: true, txid: REVEAL } : null;
            });
            expect(hook.calls).to.equal(1);
            expect(res).to.deep.equal({ exists: true, txid: REVEAL });
            expect(deadLetters(pub)).to.have.length(0);
        });

        it('a neverSent hook failure is still retried and its budget released @regression-p0', async function () {
            const pub = mkPub();
            const hook = countingHook(shapes.neverSent);
            const err = await runRetry(pub, hook, absent);
            expect(hook.calls, 'hook calls').to.equal(5);
            expect(err && err.neverSent).to.equal(true);
            expect(err.anchorAmbiguousSend).to.not.equal(true);
            expect(pub.spendGuard.spentInWindow()).to.equal(0);
        });

        it('the built-in pipeline still retries a pre-send failure (getUtxos timeout) @regression-p0', async function () {
            const pub = mkPub();
            let utxoCalls = 0;
            const signer = {
                walletSignFn: async () => 'signed-hex',
                encoder: {
                    getUtxos: async () => {
                        utxoCalls++;
                        if (utxoCalls < 3) throw Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
                        return [{ txid: 'a'.repeat(64), vout: 0, value: 1e8, confirmations: 6 }];
                    },
                    createTx: async () => ({ psbt: 'psbt-1', encoding: 'OP_RETURN' }),
                    broadcastTx: async () => ({ txid: 'tx-ok' })
                }
            };
            const res = await pub.broadcastWithRetry((p) => pub.defaultBroadcast(p, signer), 'ANCHOR|0|payload');
            expect(utxoCalls).to.equal(3);
            expect(res).to.deep.equal({ txid: 'tx-ok' });
        });
    });
}

function registerIntentCases() {
    describe('REG-ANCHOR-HOOK-002: the publish intent stays armed when the hook may have spent', function () {
        function intentPub() {
            const pub = mkPub();
            pub.log = [];
            pub.recordAnchorIntent    = async (s) => { pub.log.push('record:' + s.chain); };
            pub.withdrawAnchorIntent  = async (s) => { pub.log.push('withdraw:' + s.chain); };
            pub.recordArchiveIntent   = async (n, seq) => { pub.log.push('recordArchive:' + seq); };
            pub.withdrawArchiveIntent = async (n, seq) => { pub.log.push('withdrawArchive:' + seq); };
            pub.findExistingBundle = async () => null;
            pub.findExistingArchiveAnchor = async () => null;
            return pub;
        }
        const group = [{ chain: 'BTC', network: 'regtest', block_index: 100, checkpoint_seq: 7 }];

        for (const name of ['revealRefused', 'reveal429', 'commitTimeout']) {
            it('sendBundle keeps its anchor intents on a ' + name + ' hook failure @regression-p0', async function () {
                const pub = intentPub();
                const hook = countingHook(shapes[name]);
                let err = null;
                try { await pub.sendBundle({ broadcastFn: hook }, group, 'ANCHOR|0|bundle', null); }
                catch (e) { err = e; }
                expect(err).to.be.an('error');
                expect(hook.calls).to.equal(1);
                expect(pub.log).to.deep.equal(['record:BTC']);
                const reveals = deadLetters(pub).map(r => [r.payload, r.revealTxHex]);
                expect(reveals).to.deep.equal(name === 'commitTimeout' ? [] : [['ANCHOR|0|bundle', 'reveal-hex']]);
            });

            it('sendArchiveHead keeps its archive intent on a ' + name + ' hook failure @regression-p0', async function () {
                const pub = intentPub();
                const hook = countingHook(shapes[name]);
                let err = null;
                try { await pub.sendArchiveHead('regtest', { batchSeq: 9 }, hook, 'ANCHOR|1|head', {}); }
                catch (e) { err = e; }
                expect(err).to.be.an('error');
                expect(hook.calls).to.equal(1);
                expect(pub.log).to.deep.equal(['recordArchive:9']);
            });
        }

        it('sendBundle still withdraws its intents on a neverSent hook failure @regression-p0', async function () {
            const pub = intentPub();
            const hook = countingHook(shapes.neverSent);
            try { await pub.sendBundle({ broadcastFn: hook }, group, 'ANCHOR|0|bundle', null); } catch (e) { /* expected */ }
            expect(hook.calls).to.equal(5);
            expect(pub.log).to.deep.equal(['record:BTC', 'withdraw:BTC']);
        });
    });
}

registerRetryCases();
registerControlCases();
registerIntentCases();
