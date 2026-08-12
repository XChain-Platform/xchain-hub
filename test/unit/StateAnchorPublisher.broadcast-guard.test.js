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

// _broadcastWithRetry double-broadcast guard. A lost ACK on a
// mempool-accepted DOGE anchor must never lead to a rebuilt-PSBT re-broadcast
// (a double-spend: fresh UTXOs mean both txs can confirm). Covers the
// pre-broadcast existence check, the ambiguous-send error classification in
// _defaultBroadcast, the bounded post-ambiguous existence poll, and the
// defer-over-risk rule; also pins that safe pre-send failures keep the
// original fresh-PSBT retry behavior (the live multi-chain conflict fix).

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');

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

describe('StateAnchorPublisher: _broadcastWithRetry guard', function () {

    it('keeps the legacy behavior with no existsCheck: retries pre-send failures with a fresh call, then succeeds', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => {
            calls++;
            if (calls < 3) throw new Error('no UTXOs available for Dpub1');
            return { txid: 'tx-ok' };
        };
        const res = await pub._broadcastWithRetry(broadcaster, 'P', 5);
        expect(res.txid).to.equal('tx-ok');
        expect(calls).to.equal(3);
    });

    it('adopts an already-mined anchor on attempt 0 without broadcasting (lost ACK from a previous flush)', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => { calls++; return { txid: 'fresh' }; };
        const res = await pub._broadcastWithRetry(broadcaster, 'P', 5,
            async () => ({ exists: true, txid: 'landed-earlier' }));
        expect(res.txid).to.equal('landed-earlier');
        expect(res.exists).to.equal(true);
        expect(calls).to.equal(0);
    });

    it('checks existence again before every retry and adopts once the anchor appears', async function () {
        const pub = mkPub();
        let calls = 0, checks = 0;
        const broadcaster = async () => { calls++; throw new Error('definitive reject'); };
        const res = await pub._broadcastWithRetry(broadcaster, 'P', 5, async () => {
            checks++;
            return checks >= 2 ? { exists: true, txid: 'peer-anchor' } : null;
        });
        expect(res.txid).to.equal('peer-anchor');
        expect(calls).to.equal(1);   // one safe failure, then adopted before the retry
    });

    it('ambiguous send error: polls existence and adopts when the anchor turns up mined', async function () {
        const pub = mkPub();
        let calls = 0, checks = 0;
        const broadcaster = async () => { calls++; throw ambiguousErr(); };
        const res = await pub._broadcastWithRetry(broadcaster, 'P', 5, async () => {
            checks++;
            return checks >= 2 ? { exists: true, txid: 'mined-late' } : null;
        });
        expect(res.txid).to.equal('mined-late');
        expect(calls).to.equal(1);   // NEVER re-broadcast after the ambiguous send
    });

    it('ambiguous send error + still absent after the poll window: defers (throws) instead of re-broadcasting', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => { calls++; throw ambiguousErr('socket hang up'); };
        let err = null;
        try { await pub._broadcastWithRetry(broadcaster, 'P', 5, async () => null); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.equal('socket hang up');
        expect(calls).to.equal(1);
    });

    it('ambiguous send error + existence undetermined (check throws): defers without re-broadcasting', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => { calls++; throw ambiguousErr(); };
        let err = null;
        try {
            await pub._broadcastWithRetry(broadcaster, 'P', 5,
                async () => { throw new Error('indexer unreachable'); });
        } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.anchorAmbiguousSend).to.equal(true);
        expect(calls).to.equal(1);
    });

    it('ambiguous send error with NO existsCheck (archive/chunk path): defers immediately, no re-broadcast', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => { calls++; throw ambiguousErr(); };
        let err = null;
        try { await pub._broadcastWithRetry(broadcaster, 'P', 5); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(calls).to.equal(1);
    });

    it('definitive rejections keep retrying with a fresh PSBT even when the check says absent', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => {
            calls++;
            if (calls < 4) throw new Error('Encoder RPC error: txn-mempool-conflict');
            return { txid: 'retried-ok' };
        };
        const res = await pub._broadcastWithRetry(broadcaster, 'P', 5, async () => null);
        expect(res.txid).to.equal('retried-ok');
        expect(calls).to.equal(4);
    });
});

describe('StateAnchorPublisher: _isAmbiguousSendError classification', function () {
    const pub = mkPub();

    it('encoder RPC rejections are NOT ambiguous (the node answered, tx refused)', function () {
        expect(pub._isAmbiguousSendError(new Error('Encoder RPC error: bad-txns'))).to.equal(false);
    });

    it('HTTP 4xx refusals are NOT ambiguous', function () {
        const e = new Error('Request failed with status code 401');
        e.response = { status: 401 };
        expect(pub._isAmbiguousSendError(e)).to.equal(false);
    });

    it('never-connected transport errors are NOT ambiguous', function () {
        for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
            const e = new Error(code);
            e.code = code;
            expect(pub._isAmbiguousSendError(e), code).to.equal(false);
        }
    });

    it('timeouts, resets, and 5xx after the request went out ARE ambiguous', function () {
        const t = new Error('timeout of 30000ms exceeded'); t.code = 'ECONNABORTED';
        expect(pub._isAmbiguousSendError(t)).to.equal(true);
        const r = new Error('socket hang up'); r.code = 'ECONNRESET';
        expect(pub._isAmbiguousSendError(r)).to.equal(true);
        const s = new Error('Request failed with status code 502'); s.response = { status: 502 };
        expect(pub._isAmbiguousSendError(s)).to.equal(true);
        expect(pub._isAmbiguousSendError(new Error('mystery'))).to.equal(true);
    });
});

describe('StateAnchorPublisher: _defaultBroadcast tagging', function () {

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
        try { await pub._defaultBroadcast('P', signer); } catch (e) { err = e; }
        expect(err.anchorAmbiguousSend).to.equal(true);
    });

    it('does NOT tag a definitive encoder rejection from broadcastTx', async function () {
        const pub = mkPub();
        const signer = mkSigner();
        signer.encoder.broadcastTx = async () => { throw new Error('Encoder RPC error: bad-txns'); };
        let err = null;
        try { await pub._defaultBroadcast('P', signer); } catch (e) { err = e; }
        expect(err.anchorAmbiguousSend).to.be.undefined;
    });

    it('does NOT tag pre-send failures (createTx / getUtxos / signing)', async function () {
        const pub = mkPub();
        const signer = mkSigner();
        signer.encoder.createTx = async () => {
            const e = new Error('timeout'); e.code = 'ECONNABORTED'; throw e;
        };
        let err = null;
        try { await pub._defaultBroadcast('P', signer); } catch (e) { err = e; }
        expect(err.anchorAmbiguousSend).to.be.undefined;

        const signer2 = mkSigner();
        signer2.encoder.getUtxos = async () => [];
        err = null;
        try { await pub._defaultBroadcast('P', signer2); } catch (e) { err = e; }
        expect(err.anchorAmbiguousSend).to.be.undefined;
    });

    it('still returns the broadcast result on success', async function () {
        const pub = mkPub();
        const res = await pub._defaultBroadcast('P', mkSigner());
        expect(res.txid).to.equal('tx1');
    });
});

describe('StateAnchorPublisher: _findExistingCheckpointAnchor', function () {

    const ROW = { chain: 'BTC', network: 'regtest', block_index: 494, checkpoint_seq: 7 };

    function mkPubWithIndexer(reply){
        const pub = mkPub();
        pub.indexers = { DOGE: { url: 'http://doge-indexer' } };
        pub._indexerCall = async (coin, method, params) => {
            expect(coin).to.equal('DOGE');
            expect(method).to.equal('getanchoraction');
            expect(params.block_index).to.equal(494);
            expect(params.checkpoint_seq).to.equal(7);
            if (reply instanceof Error) throw reply;
            return reply;
        };
        return pub;
    }

    it('returns { exists, txid } for a mined non-invalid anchor at any depth', async function () {
        const pub = mkPubWithIndexer({ exists: true, txid: 'AB'.repeat(32), status: 'valid', confirmations: 1 });
        const res = await pub._findExistingCheckpointAnchor(ROW);
        expect(res.exists).to.equal(true);
        expect(res.txid).to.equal('AB'.repeat(32));
    });

    it('returns exists with a null txid against a pre-upgrade indexer (adopt-but-do-not-stamp)', async function () {
        const pub = mkPubWithIndexer({ exists: true, status: 'valid' });
        const res = await pub._findExistingCheckpointAnchor(ROW);
        expect(res.exists).to.equal(true);
        expect(res.txid).to.equal(null);
    });

    it('returns null when definitively absent', async function () {
        const pub = mkPubWithIndexer({ exists: false });
        expect(await pub._findExistingCheckpointAnchor(ROW)).to.equal(null);
    });

    it('treats a decoded-invalid row as absent', async function () {
        const pub = mkPubWithIndexer({ exists: true, txid: 'cc', status: 'invalid: bad sig' });
        expect(await pub._findExistingCheckpointAnchor(ROW)).to.equal(null);
    });

    it('throws when no DOGE indexer is wired (undetermined, never a false absent)', async function () {
        const pub = mkPub();
        pub.indexers = {};
        let err = null;
        try { await pub._findExistingCheckpointAnchor(ROW); } catch (e) { err = e; }
        expect(err).to.be.an('error');
    });

    it('throws when the indexer is unreachable or answers with an error', async function () {
        let err = null;
        try { await mkPubWithIndexer(new Error('ETIMEDOUT'))._findExistingCheckpointAnchor(ROW); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');

        err = null;
        try { await mkPubWithIndexer({ error: 'indexer database not ready' })._findExistingCheckpointAnchor(ROW); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
    });
});
