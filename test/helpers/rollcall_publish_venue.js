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

// A RollcallRound publish venue for the delivery-memory suites: a scripted
// broadcaster that records which pubkeys each payload carried, an engine whose DOGE
// read answers from a Set of landed pubkeys (and that Set's `tip`), and the round a
// restart rebuilds. A restart is a second engine over the same spend log.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const RollcallRound     = require('../../src/rollcall/round.js');
const ValidatorIdentity = require('../../src/validators/identity.js');

const LEDGER_HASH = '4a7f1e93c25b8d0617ae42f9308c5b7de1409263a8f5c07be3d4192c6f8ab5e1';
const EPOCH = 30;
const IDENTITY = new ValidatorIdentity('11'.repeat(32));
const MY_PK = IDENTITY.getPubkeyHex().toLowerCase();

// The broadcaster: each call takes the next scripted outcome ('ok' when the script
// is empty) and records the pubkeys the payload carried.
function makeBroadcaster(script) {
    let calls = [];
    let n = 0;
    let fn = async (payload) => {
        let f = String(payload).split('|');
        let pks = [];
        for (let i = 6; i < f.length; i += 2) pks.push(f[i]);
        calls.push(pks);
        let outcome = script.length ? script.shift() : 'ok';
        if (outcome === 'refuse') {
            throw Object.assign(new Error('Encoder RPC error: mandatory-script-verify-flag-failed'),
                { rpcCode: -32010, rpcData: { reason: 'NODE_REJECTED' } });
        }
        if (outcome === '429') {
            throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } });
        }
        if (outcome === 'fundsCommitted') {
            throw Object.assign(new Error('reveal broadcast failed after funding'), {
                fundsCommitted: true, phase1Txid: 'aa'.repeat(32), revealTxid: 'bb'.repeat(32),
                revealTxHex: '0200deadbeef'
            });
        }
        n++;
        return { txid: crypto.createHash('sha256').update('tx' + n).digest('hex') };
    };
    return { fn, calls };
}

function makeEngine(dir, broadcastFn, landed) {
    let hub = {
        network: 'regtest', peerManager: null, identity: IDENTITY, capabilitySnapshot: null,
        oraclePublisher: { broadcastFn, walletSignFn: null, getBalanceFn: async () => 1000, encoder: null },
        stateAnchorPublisher: null,
        p2pConfig: {
            ROLLCALL_SPEND_LOG_PATH: path.join(dir, 'spend.jsonl'),
            ROLLCALL_SIGN_LOG_PATH: path.join(dir, 'sign.jsonl')
        }
    };
    let eng = new RollcallRound(hub);
    eng.dogeIndexerCall = async (method, params) => {
        let signers = {};
        for (let pk of params.pubkeys) signers[pk] = landed.has(pk) ? { ledger_hash: LEDGER_HASH, sig: 'x' } : null;
        // `landed.tip` is the DOGE tip the answer reports (absent, the field is null), and
        // `landed.perRead` advances it after every read, as a live chain does between reads.
        let tip = landed.tip === undefined ? null : landed.tip;
        if (landed.perRead && tip !== null) landed.tip += landed.perRead;
        return { hcut: 100, tip_block_index: tip, signers, publishers: {} };
    };
    eng.loadSignLog();
    eng.loadSpendLog();
    return eng;
}

// The round as gossip rebuilds it after any restart: the same signatures (fifty by default).
function makeState(pairs) {
    let sigs = new Map();
    sigs.set(MY_PK, 'ab'.repeat(64));
    for (let i = 1; i < (pairs || 50); i++) {
        let pk = '02' + crypto.createHash('sha256').update('pk' + i).digest('hex');
        sigs.set(pk, crypto.createHash('sha512').update('sig' + i).digest('hex'));
    }
    return { epoch: EPOCH, ledgerHash: LEDGER_HASH, gates: null, sigs, signed: true, order: [MY_PK],
             leader: MY_PK, myRank: 0, published: false, selfPublished: false, ownSigOnWire: false,
             sent: new Set(), onChainCount: null, txids: [] };
}

async function tick(eng, state) {
    let since = Math.max(eng.publishDelayBlocks, eng.selfPublishBlocks);
    await eng.maybePublish(state, MY_PK, since);
    await eng.maybeSelfPublish(state, MY_PK, since);
}

function spendLog(dir) {
    return fs.readFileSync(path.join(dir, 'spend.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

// Every pubkey paid for more than once across the calls that went out.
function paidTwice(calls, outcomes) {
    let seen = new Map();
    calls.forEach((pks, i) => {
        if (outcomes && outcomes[i] !== 'ok') return;
        for (let pk of pks) seen.set(pk, (seen.get(pk) || 0) + 1);
    });
    return Array.from(seen).filter(([, n]) => n > 1).map(([pk]) => pk);
}

module.exports = { LEDGER_HASH, EPOCH, MY_PK, makeBroadcaster, makeEngine, makeState, tick, spendLog, paidTwice };
