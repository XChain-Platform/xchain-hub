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
//
// OraclePublisher landing guards: the confirmed-UTXO reserve that refuses to build
// a wire nothing can mine, and the watchdog that tracks a broadcast to a block.
// Real fs against a temp directory, like the batch-rail suite: the durable queue is
// what proves a deferral kept the round and burned no attempt.

const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');

const OraclePublisher = require('../../src/oracle/publisher.js');
const { waitUntil }   = require('../helpers/waitUntil');

const ME   = 'aa'.repeat(32);
const ADDR = 'DPubLisherAddr1111111111111111111';

let tmpDirs   = [];
let instances = [];

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

// One get_utxos entry in the tracker's shape: satoshi `value` string, a 64-hex
// txid, and the confirmations field the reserve and the watchdog both read.
// 50 DOGE apiece, so a set of any size clears the default 10 DOGE balance floor
// and the reserve is the only thing that can stop a pass.
function utxo(txid, confirmations, opts) {
    opts = opts || {};
    let out = { txid: txid, vout: opts.vout || 0, value: opts.value || '5000000000' };
    if (confirmations !== null) out.confirmations = confirmations;
    return out;
}

function makeEncoder(utxos) {
    let enc = {
        sets:        [utxos || []],
        getUtxosCalls: 0,
        createTx:    sinon.stub().rejects(new Error('the watchdog must never build a transaction')),
        broadcastTx: sinon.stub().rejects(new Error('the watchdog must never broadcast'))
    };
    enc.getUtxos = sinon.stub().callsFake(async () => {
        enc.getUtxosCalls++;
        return enc.sets[0];
    });
    enc.serve = (next) => { enc.sets[0] = next; };
    return enc;
}

function queueEntry(round, attempts) {
    return { round: round, btcBlockTime: 1800000000 + round * 600,
             prices: [{ coinPair: 'BTC/USD', price: '60000.12' }],
             sigs:   [{ pubkey: ME, sig: 'cc'.repeat(64) }],
             attempts: attempts || 0 };
}

function makePublisher(opts) {
    opts = opts || {};
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-pub-confirm-'));
    tmpDirs.push(dir);

    let hub = {
        p2pConfig: Object.assign({ PUBLISHER_QUEUE_PATH: path.join(dir, 'publisher-queue.jsonl') },
                                 opts.cfg || {}),
        network:            'regtest',
        db:                 opts.db || null,
        getIdentity:        () => ({ getPubkeyHex: () => ME, sign: () => 'dd'.repeat(64) }),
        capabilitySnapshot: null,
        oracleConsensus:    null,
        oracleBatchSigner:  null
    };

    let p = new OraclePublisher(hub);
    p.dogeAddress = ADDR;
    p.encoder     = opts.encoder === null ? null : (opts.encoder || makeEncoder(opts.utxos));

    let broadcasts = [];
    p.setBroadcastHook(async (payload) => {
        broadcasts.push(payload);
        return { txid: opts.txids ? opts.txids[broadcasts.length - 1] : ('tx' + broadcasts.length) };
    });

    instances.push(p);
    return { p, hub, dir, broadcasts, encoder: p.encoder,
             queuePath: path.join(dir, 'publisher-queue.jsonl'),
             deadPath:  path.join(dir, 'publisher-queue.deadletter.jsonl') };
}

function seedQueue(h, entries) {
    fs.writeFileSync(h.queuePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function readJsonl(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ────────────────────────────────────────────────────────────────────────────

function cleanupPublisherConfirmation() {
    sinon.restore();
    for (let publisher of instances) {
        try { publisher.stop(); } catch (error) {}
    }
    instances = [];
    for (let dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) {}
    }
    tmpDirs = [];
}

module.exports = {
    fs,
    os,
    path,
    sinon,
    expect,
    OraclePublisher,
    waitUntil,
    ME,
    ADDR,
    utxo,
    makeEncoder,
    queueEntry,
    makePublisher,
    seedQueue,
    readJsonl,
    cleanupPublisherConfirmation
};
