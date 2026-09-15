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

// broadcastWithRetry double-broadcast guard. A lost ACK on a
// mempool-accepted DOGE anchor must never lead to a rebuilt-PSBT re-broadcast
// (a double-spend: fresh UTXOs mean both txs can confirm). Covers the
// pre-broadcast existence check, the ambiguous-send error classification in
// defaultBroadcast, the bounded post-ambiguous existence poll, and the
// defer-over-risk rule; also pins that safe pre-send failures keep the
// original fresh-PSBT retry behavior (the live multi-chain conflict fix).

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/anchor/publisher');

function mkPub(){
    const pub = new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    pub.chunkRetryDelayMs    = 1;
    pub.ambiguousPollDelayMs = 1;
    pub.ambiguousPollAttempts = 2;
    return pub;
}

function ambiguousErr(msg){
    const e = new Error(msg || 'timeout');
    e.anchorAmbiguousSend = true;
    return e;
}

describe('StateAnchorPublisher: isAmbiguousSendError classification', function () {
    const pub = mkPub();

    it('encoder RPC rejections are NOT ambiguous (the node answered, tx refused)', function () {
        expect(pub.isAmbiguousSendError(new Error('Encoder RPC error: bad-txns'))).to.equal(false);
    });

    it('HTTP 4xx refusals are NOT ambiguous', function () {
        const e = new Error('Request failed with status code 401');
        e.response = { status: 401 };
        expect(pub.isAmbiguousSendError(e)).to.equal(false);
    });

    it('never-connected transport errors are NOT ambiguous', function () {
        for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
            const e = new Error(code);
            e.code = code;
            expect(pub.isAmbiguousSendError(e), code).to.equal(false);
        }
    });

    it('timeouts, resets, and 5xx after the request went out ARE ambiguous', function () {
        const t = new Error('timeout of 30000ms exceeded'); t.code = 'ECONNABORTED';
        expect(pub.isAmbiguousSendError(t)).to.equal(true);
        const r = new Error('socket hang up'); r.code = 'ECONNRESET';
        expect(pub.isAmbiguousSendError(r)).to.equal(true);
        const s = new Error('Request failed with status code 502'); s.response = { status: 502 };
        expect(pub.isAmbiguousSendError(s)).to.equal(true);
        expect(pub.isAmbiguousSendError(new Error('mystery'))).to.equal(true);
    });
});

describe('StateAnchorPublisher: defaultBroadcast tagging', function () {

    function mkSigner(overrides){
        return Object.assign({
            encoder: {
                getUtxos:    async () => [{ txid: 'u1', vout: 0 }],
                createTx:    async () => ({ psbt: 'psbt-hex' }),
                broadcastTx: async () => ({ txid: 'tx1' })
            },
            walletSignFn: async () => 'signed-hex'
        }, overrides || {});
    }

    it('tags a transport failure from broadcastTx as anchorAmbiguousSend', async function () {
        const pub = mkPub();
        const signer = mkSigner();
        signer.encoder.broadcastTx = async () => {
            const e = new Error('timeout'); e.code = 'ECONNABORTED'; throw e;
        };
        let err = null;
        try { await pub.defaultBroadcast('P', signer); } catch (e) { err = e; }
        expect(err.anchorAmbiguousSend).to.equal(true);
    });

    it('does NOT tag a definitive encoder rejection from broadcastTx', async function () {
        const pub = mkPub();
        const signer = mkSigner();
        signer.encoder.broadcastTx = async () => { throw new Error('Encoder RPC error: bad-txns'); };
        let err = null;
        try { await pub.defaultBroadcast('P', signer); } catch (e) { err = e; }
        expect(err.anchorAmbiguousSend).to.be.undefined;
    });

    it('does NOT tag pre-send failures (createTx / getUtxos / signing)', async function () {
        const pub = mkPub();
        const signer = mkSigner();
        signer.encoder.createTx = async () => {
            const e = new Error('timeout'); e.code = 'ECONNABORTED'; throw e;
        };
        let err = null;
        try { await pub.defaultBroadcast('P', signer); } catch (e) { err = e; }
        expect(err.anchorAmbiguousSend).to.be.undefined;

        const signer2 = mkSigner();
        signer2.encoder.getUtxos = async () => [];
        err = null;
        try { await pub.defaultBroadcast('P', signer2); } catch (e) { err = e; }
        expect(err.anchorAmbiguousSend).to.be.undefined;
    });

    it('still returns the broadcast result on success', async function () {
        const pub = mkPub();
        const res = await pub.defaultBroadcast('P', mkSigner());
        expect(res.txid).to.equal('tx1');
    });
});

