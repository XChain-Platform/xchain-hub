'use strict';
// Shared fixtures for the hub DB peer catch-up suites (peer_catchup*.test.js).
const EventEmitter = require('events');
const sinon = require('sinon');
const HubDbPeerCatchup = require('../../../../../src/peers/hub_db/peer_catchup.js');
const PEER = 'ws://validator02.example:10002';
const VALIDATOR_ADDR = 'rValidator02';
const SIGNING_PUBKEY = 'aa'.repeat(32);
const PEER_B = 'ws://validator03.example:10002';
const VALIDATOR_ADDR_B = 'rValidator03';
const SIGNING_PUBKEY_B = 'bb'.repeat(32);
function peerManager(connected, options) {
    const second = !!options && options.peers === 2;
    const pm = new EventEmitter();
    pm.peers = new Map();
    pm.validatorPubkeys = new Map([[VALIDATOR_ADDR, SIGNING_PUBKEY]]);
    pm.effectiveSignerSet = new Set([SIGNING_PUBKEY]);
    if (second) {
        pm.validatorPubkeys.set(VALIDATOR_ADDR_B, SIGNING_PUBKEY_B);
        pm.effectiveSignerSet.add(SIGNING_PUBKEY_B);
    }
    pm.registryHasPubkey = pubkey => [...pm.validatorPubkeys.values()]
        .some(value => value && String(value).toLowerCase() === pubkey);
    if (connected) pm.peers.set(PEER, {
        state: 'open', inbound: false, feedUrl: PEER, validatorAddr: VALIDATOR_ADDR
    });
    if (connected && second) pm.peers.set(PEER_B, {
        state: 'open', inbound: false, feedUrl: PEER_B, validatorAddr: VALIDATOR_ADDR_B
    });
    return pm;
}
function priceDb() {
    return {
        findPriceSnapshotsForRound: sinon.stub().resolves([]),
        setFinalizedPriceSnapshotRound: sinon.stub().resolves({ affectedRows: 1 })
    };
}
function makeCatchup(overrides) {
    const opts = overrides || {};
    return new HubDbPeerCatchup({
        db: opts.db || priceDb(),
        peerManager: opts.peerManager || peerManager(true),
        tables: opts.tables || ['price_snapshots'],
        getVerifier: opts.getVerifier || (() => async () => true),
        fetchPage: opts.fetchPage,
        hasRow: opts.hasRow,
        storeRow: opts.storeRow,
        pageSize: 'pageSize' in opts ? opts.pageSize : 2,
        warnIntervalMs: 60000,
        retryIntervalMs: opts.retryIntervalMs,
        maxRetryIntervalMs: opts.maxRetryIntervalMs,
        indexerReadIntervalMs: opts.indexerReadIntervalMs,
        logger: opts.logger || { warn: sinon.stub(), error: sinon.stub() }
    });
}
function delayedPage(ms) {
    return sinon.stub().callsFake(() => new Promise(resolve => setTimeout(
        () => resolve({ table: 'price_snapshots', rows: [] }), ms)));
}
module.exports = {
    delayedPage, PEER, VALIDATOR_ADDR, SIGNING_PUBKEY, PEER_B, VALIDATOR_ADDR_B, SIGNING_PUBKEY_B, peerManager, priceDb, makeCatchup };
