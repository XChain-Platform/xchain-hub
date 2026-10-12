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

// Every built-in create_tx rail hands back the inputs a successful build reserved
// when it abandons that build before broadcast_tx, and never once the send has run.
//
// create_tx reserves the outpoints it selected for the encoder's 5-minute TTL. A rail
// that walks away (two-phase refusal, a failing wallet hook, a bad hex) without
// release_inputs leaves its funded address unusable to every other publisher for
// that window. The oracle and anchor rails are covered beside their own tests; the
// five rails below are the rest of the src callers of createTx.

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');

const AttestationPublisher   = require('../../../../src/attestation/publisher');
const batchBroadcast         = require('../../../../src/attestation/batch_publisher/broadcast.js');
const AttestationRelay       = require('../../../../src/attestation/relay');
const dogeRail               = require('../../../../src/rollcall/round/doge_rail.js');
const FullNodeChallengeRound = require('../../../../src/consensus/full_node_challenge_round');

const TICKET = 'f'.repeat(32);
const ADDR   = 'DAaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';

// A create_tx answer shaped like the real encoder's: `reservation` rides on every build.
function reservingEncoder(answer) {
    return {
        getUtxos:      sinon.stub().resolves([{ txid: 'a'.repeat(64), vout: 0, value: 100000 }]),
        createTx:      sinon.stub().resolves(Object.assign({ psbt: 'deadbeef', reservation: { id: TICKET } }, answer)),
        broadcastTx:   sinon.stub().resolves({ txid: 'broadcast-txid' }),
        releaseInputs: sinon.stub().resolves({ found: true })
    };
}

// One runner per rail: (encoder, walletSign) -> the rail's own send entry point.
const RAILS = {
    AttestationPublisher(encoder, walletSign) {
        const pub = new AttestationPublisher({});
        pub.encoder      = encoder;
        pub.walletSignFn = walletSign;
        pub.btcAddress   = ADDR;
        pub.btcPubkeyHex = '02' + 'ab'.repeat(32);
        return pub.defaultBroadcast('ATTEST|1|...');
    },
    AttestationBatchPublisher(encoder, walletSign) {
        const pub = Object.assign(Object.create(batchBroadcast), {
            encoder, walletSignFn: walletSign, dogeAddress: ADDR, allowUnconfirmedInputs: false
        });
        return pub.defaultBroadcast('ATTEST|batch|...');
    },
    AttestationRelay(encoder, walletSign) {
        const relay = { encoder, walletSignFn: walletSign, btcAddress: ADDR };
        return AttestationRelay.prototype.defaultBroadcast.call(relay, 'RELAY|...');
    },
    RollcallRound(encoder, walletSign) {
        const round = Object.assign(Object.create(dogeRail), {
            hub: null, broadcastFn: null, getBalanceFn: null, encoder, walletSignFn: walletSign, dogeAddress: ADDR
        });
        return round.broadcast('ROLLCALL|...');
    },
    FullNodeChallengeRound(encoder, walletSign) {
        const round = {
            signerChainMismatch: () => null, broadcastFn: null,
            encoder, walletSignFn: walletSign, btcAddress: ADDR
        };
        return FullNodeChallengeRound.prototype.broadcastVerdict.call(round, 'NODEPROOF|...');
    }
};

async function settle(promise) {
    try { return { result: await promise, error: null }; } catch (e) { return { result: null, error: e }; }
}

describe('create_tx rails release an abandoned build reservation', function () {
    afterEach(function () { sinon.restore(); });

    for (const [rail, run] of Object.entries(RAILS)) {
        describe(rail, function () {
            it('releases the ticket when the two-phase guard refuses the build', async function () {
                const encoder = reservingEncoder({ encoding: 'P2SH', carrierScripts: ['00ff'] });
                const sign = sinon.stub().resolves('00'.repeat(32));
                const out = await settle(run(encoder, sign));
                expect(out.error, 'the refusal surfaces').to.be.an('error');
                expect(out.error.message).to.contain('two-transaction');
                expect(sign.called, 'refused before the wallet hook').to.equal(false);
                expect(encoder.releaseInputs.calledOnceWithExactly(TICKET)).to.equal(true);
                expect(encoder.broadcastTx.called).to.equal(false);
            });

            it('releases the ticket when the wallet hook rejects', async function () {
                const encoder = reservingEncoder({ encoding: 'OP_RETURN' });
                const out = await settle(run(encoder, sinon.stub().rejects(new Error('signer offline'))));
                expect(out.error.message).to.contain('signer offline');
                expect(encoder.releaseInputs.calledOnceWithExactly(TICKET)).to.equal(true);
                expect(encoder.broadcastTx.called).to.equal(false);
            });

            it('releases the ticket when the wallet hook returns no hex', async function () {
                const encoder = reservingEncoder({ encoding: 'OP_RETURN' });
                const out = await settle(run(encoder, sinon.stub().resolves(null)));
                expect(out.error.message).to.contain('invalid tx hex');
                expect(encoder.releaseInputs.calledOnceWithExactly(TICKET)).to.equal(true);
            });

            it('keeps the ticket once the transaction has been broadcast', async function () {
                const encoder = reservingEncoder({ encoding: 'OP_RETURN' });
                const out = await settle(run(encoder, sinon.stub().resolves('00'.repeat(32))));
                expect(out.error).to.equal(null);
                expect(encoder.broadcastTx.calledOnce).to.equal(true);
                expect(encoder.releaseInputs.called).to.equal(false);
            });

            it('keeps the ticket when the send itself fails', async function () {
                const encoder = reservingEncoder({ encoding: 'OP_RETURN' });
                encoder.broadcastTx = sinon.stub().rejects(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
                const out = await settle(run(encoder, sinon.stub().resolves('00'.repeat(32))));
                expect(out.error, 'the send failure surfaces').to.be.an('error');
                expect(encoder.releaseInputs.called, 'a send that may have landed keeps its inputs').to.equal(false);
            });

            it('calls nothing when the build minted no reservation', async function () {
                const encoder = reservingEncoder({ encoding: 'P2SH', carrierScripts: ['00ff'], reservation: undefined });
                const out = await settle(run(encoder, sinon.stub().resolves('00'.repeat(32))));
                expect(out.error.message).to.contain('two-transaction');
                expect(encoder.releaseInputs.called).to.equal(false);
            });
        });
    }

    it('AttestationRelay releases through the origin-chain encoder it was handed', async function () {
        const home   = reservingEncoder({ encoding: 'OP_RETURN' });
        const origin = reservingEncoder({ encoding: 'P2SH', carrierScripts: ['00ff'] });
        const relay  = { encoder: home, walletSignFn: sinon.stub().resolves('00'.repeat(32)), btcAddress: ADDR };
        const out = await settle(AttestationRelay.prototype.defaultBroadcast.call(
            relay, 'RELAY|...', origin, ADDR, relay.walletSignFn, 'LTC'));
        expect(out.error.message).to.contain('two-transaction');
        expect(out.error._relayPreSend).to.equal(true);
        expect(origin.releaseInputs.calledOnceWithExactly(TICKET)).to.equal(true);
        expect(home.releaseInputs.called).to.equal(false);
    });

    it('every src caller of createTx releases through abandonBuild', function () {
        const root = path.resolve(__dirname, '../../../../src');
        const callers = [];
        (function walk(dir) {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) walk(full);
                else if (ent.name.endsWith('.js') && /\.createTx\(/.test(fs.readFileSync(full, 'utf8'))) callers.push(full);
            }
        })(root);
        const rails = callers.filter((f) => !f.endsWith(path.join('peers', 'encoder_client.js')));
        expect(rails.length, 'the scan must find the publish rails').to.be.at.least(7);
        for (const f of rails) {
            expect(fs.readFileSync(f, 'utf8'), path.relative(root, f) + ' never calls abandonBuild')
                .to.match(/await abandonBuild\(/);
        }
    });
});
