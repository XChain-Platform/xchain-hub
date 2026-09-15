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
const proxyquire     = require('proxyquire');
const path           = require('path');
const os             = require('os');
const { DB_METHODS } = require('../helpers/mockHub');

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

// Stub out fs and EncoderClient so no real files are written
let fsMock;
let OraclePublisher;

function loadModule() {
    fsMock = {
        mkdirSync:     sinon.stub(),
        existsSync:    sinon.stub().returns(true),
        writeFileSync: sinon.stub(),
        openSync:      sinon.stub().returns(99),
        writeSync:     sinon.stub(),
        fsyncSync:     sinon.stub(),
        closeSync:     sinon.stub(),
        readFileSync:  sinon.stub().returns('')
    };
    OraclePublisher = proxyquire('../../src/oracle/publisher', {
        fs: fsMock,
        '../peers/encoder_client': function () { return null; }  // encoder=null by default
    });
}

function makeIdentity(pubkey) {
    return {
        getPubkeyHex: sinon.stub().returns(pubkey || 'aa'.repeat(32)),
        sign:         sinon.stub().returns('bb'.repeat(64))
    };
}

function makeHub(overrides) {
    return {
        p2pConfig:          overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        getIdentity:        sinon.stub().returns(makeIdentity()),
        capabilityRegistry: overrides && overrides.capabilityRegistry !== undefined
            ? overrides.capabilityRegistry : null,
        capabilitySnapshot: overrides && overrides.capabilitySnapshot !== undefined
            ? overrides.capabilitySnapshot : null,
        oracleConsensus:    overrides && overrides.oracleConsensus !== undefined
            ? overrides.oracleConsensus : null,
        ...(overrides || {})
    };
}

// A minimal in-memory stand-in for hub.db (the MariaDB wrapper's doQuery). Models
// the oracle_published_rounds table so the durable at-most-once path can be driven
// without a real database. Pre-seed `markers` to simulate rows surviving a restart.
function makeDb(seed) {
    let markers = Object.assign({}, seed || {});   // round -> { round, txid, sent_at }
    let db = {
        // Spread first: OraclePublisher now calls db.deleteOraclePublishedRound() and its
        // sibling named methods instead of issuing SQL inline, and each routes back
        // through this.doQuery, so the SQL-text dispatch below still drives every case.
        ...DB_METHODS,
        markers,
        doQuery: sinon.stub().callsFake(async function (q, args) {
            if (/^\s*SELECT/i.test(q)) {
                if (/WHERE\s+round/i.test(q)) {
                    let r = Number(args[0]);
                    return markers[r] ? [markers[r]] : [];
                }
                return Object.keys(markers).map(k => markers[k]);   // full-table hydrate scan
            }
            if (/^\s*INSERT/i.test(q)) {
                let r = Number(args[0]);
                if (!markers[r]) markers[r] = { round: r, txid: null, sent_at: null };
                return { affectedRows: 1 };
            }
            if (/^\s*UPDATE/i.test(q)) {
                let txid = args[0];
                let r    = Number(args[args.length - 1]);
                if (!markers[r]) markers[r] = { round: r, txid: null, sent_at: null };
                markers[r].txid    = txid;
                markers[r].sent_at = '2026-01-01 00:00:00';
                return { affectedRows: 1 };
            }
            // Retention DELETE. Applies exactly the predicates present in the SQL text
            // rather than the ones the caller meant to write, so a production query that
            // drops `sent_at IS NOT NULL` really does erase the quarantine rows here and
            // the retention tests fail instead of passing on a stub's good manners.
            if (/^\s*DELETE/i.test(q)) {
                let cutoff       = Number(args[0]);
                let confirmedOnly = /sent_at\s+IS\s+NOT\s+NULL/i.test(q);
                let deleted = 0;
                for (let k of Object.keys(markers)) {
                    let row = markers[k];
                    if (!(Number(row.round) < cutoff)) continue;
                    if (confirmedOnly && (row.sent_at === null || row.sent_at === undefined)) continue;
                    delete markers[k];
                    deleted++;
                }
                return { affectedRows: deleted };
            }
            return [];
        })
    };
    return db;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

function oraclePublisherTests(title, registerTests) {
    describe('OraclePublisher', function () {
        beforeEach(function () {
            loadModule();
        });

        afterEach(function () {
            sinon.restore();
        });

        describe(title, registerTests);
    });
}


// ── Constructor ─────────────────────────────────────────────────────────

oraclePublisherTests('constructor', function () {
    it('reads DOGE_ADDRESS from p2pConfig', function () {
        let hub = makeHub({ p2pConfig: { DOGE_ADDRESS: 'D123abc' } });
        let pub = new OraclePublisher(hub);
        expect(pub.dogeAddress).to.equal('D123abc');
    });

    it('uses defaults for numeric fields', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        expect(pub.maxAttempts).to.equal(5);
        expect(pub.lowBalanceThreshold).to.equal(10);
    });

    it('reads PUBLISHER_MAX_ATTEMPTS from config', function () {
        let hub = makeHub({ p2pConfig: { PUBLISHER_MAX_ATTEMPTS: '3' } });
        let pub = new OraclePublisher(hub);
        expect(pub.maxAttempts).to.equal(3);
    });

});

// ── setBroadcastHook / setWalletSignHook / setBalanceHook ──────────────

oraclePublisherTests('hooks', function () {
    it('stores broadcastFn via setBroadcastHook', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let fn  = sinon.stub();
        pub.setBroadcastHook(fn);
        expect(pub.broadcastFn).to.equal(fn);
    });

    it('stores walletSignFn via setWalletSignHook', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let fn  = sinon.stub();
        pub.setWalletSignHook(fn);
        expect(pub.walletSignFn).to.equal(fn);
    });

    it('stores getBalanceFn via setBalanceHook', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let fn  = sinon.stub();
        pub.setBalanceHook(fn);
        expect(pub.getBalanceFn).to.equal(fn);
    });

});


// ── buildPriceV0Wire ─────────────────────────────────────────────────────

oraclePublisherTests('buildPriceV0Wire()', function () {
    it('builds a correct pipe-delimited PRICE v0 wire string', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let prices = [
            { coinPair: 'BTC/USD', price: '100000' },
            { coinPair: 'LTC/USD', price: '80' }
        ];
        let sigs = [{ pubkey: 'pk1', sig: 'sig1' }];
        // PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|... (#4232: height on the wire)
        let wire = pub.buildPriceV0Wire(42, 1700000000, prices, sigs, 850010);
        let parts = wire.split('|');
        expect(parts[0]).to.equal('PRICE');
        expect(parts[1]).to.equal('0');
        expect(parts[2]).to.equal('42');
        expect(parts[3]).to.equal('1700000000');
        expect(parts[4]).to.equal('850010');  // BTC block height (round anchor)
        expect(parts[5]).to.equal('2');  // price count
        expect(parts[6]).to.equal('BTC/USD');
        expect(parts[7]).to.equal('100000');
        expect(parts[8]).to.equal('LTC/USD');
        expect(parts[9]).to.equal('80');
        expect(parts[10]).to.equal('1');  // sig count
        expect(parts[11]).to.equal('pk1');
        expect(parts[12]).to.equal('sig1');
    });

    it('handles no signatures gracefully', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let wire = pub.buildPriceV0Wire(1, 0, [{ coinPair: 'BTC/USD', price: '100' }], [], 850010);
        expect(wire).to.match(/^PRICE\|0\|1\|0\|850010\|1\|BTC\/USD\|100\|0$/);
    });

    it('uses `pair` property as fallback when `coinPair` is absent', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let wire = pub.buildPriceV0Wire(1, 0, [{ pair: 'BTC/USD', price: '100' }], [], 850010);
        expect(wire).to.include('BTC/USD');
    });

});


// ── buildSignablePayload ────────────────────────────────────────────────

oraclePublisherTests('buildSignablePayload()', function () {
    it('produces a JSON string with sorted pairs', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let prices = [
            { coinPair: 'LTC/USD', price: '80' },
            { coinPair: 'BTC/USD', price: '100000' }
        ];
        let payload = JSON.parse(pub.buildSignablePayload(42, 1700000000, prices, 850010));
        expect(payload.round).to.equal(42);
        expect(payload.timestamp).to.equal(1700000000);
        expect(payload.btc_block_height).to.equal(850010);  // #4232: round BTC anchor in signed payload
        // Pairs must be sorted alphabetically
        expect(payload.pairs[0].pair).to.equal('BTC/USD');
        expect(payload.pairs[1].pair).to.equal('LTC/USD');
    });

    it('produces deterministic output for same inputs', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let prices = [{ coinPair: 'BTC/USD', price: '50000' }];
        let p1 = pub.buildSignablePayload(1, 100, prices);
        let p2 = pub.buildSignablePayload(1, 100, prices);
        expect(p1).to.equal(p2);
    });

});


// ── buildLocalSigOnly ───────────────────────────────────────────────────

oraclePublisherTests('buildLocalSigOnly()', function () {
    it('returns empty array when no identity', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.identity = null;
        let sigs = pub.buildLocalSigOnly({ round: 1, btcBlockTime: 0, prices: [] });
        expect(sigs).to.deep.equal([]);
    });

    it('builds a single-validator sig with pubkey and sig fields', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let sigs = pub.buildLocalSigOnly({
            round: 1, btcBlockTime: 1700000000,
            prices: [{ coinPair: 'BTC/USD', price: '100000' }]
        });
        expect(sigs).to.have.length(1);
        expect(sigs[0]).to.have.property('pubkey');
        expect(sigs[0]).to.have.property('sig');
    });

    it('returns empty array when buildSignablePayload throws', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        // Make identity.sign throw
        pub.identity.sign = sinon.stub().throws(new Error('sign failed'));
        let sigs = pub.buildLocalSigOnly({ round: 1, btcBlockTime: 0, prices: [] });
        expect(sigs).to.deep.equal([]);
    });

});
