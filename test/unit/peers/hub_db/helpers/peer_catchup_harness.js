'use strict';
// Shared fixtures for the hub DB peer catch-up suites (peer_catchup*.test.js).
const EventEmitter = require('events');
const sinon = require('sinon');
const HubDbPeerCatchup = require('../../../../../src/peers/hub_db/peer_catchup.js');
const PEER = 'ws://validator02.example:10002';
const VALIDATOR_ADDR = 'rValidator02';
const SIGNING_PUBKEY = 'aa'.repeat(32);
function peerManager(connected) {
    const pm = new EventEmitter();
    pm.peers = new Map();
    pm.validatorPubkeys = new Map([[VALIDATOR_ADDR, SIGNING_PUBKEY]]);
    pm.effectiveSignerSet = new Set([SIGNING_PUBKEY]);
    pm.registryHasPubkey = pubkey => [...pm.validatorPubkeys.values()]
        .some(value => value && String(value).toLowerCase() === pubkey);
    if (connected) pm.peers.set(PEER, {
        state: 'open', inbound: false, feedUrl: PEER, validatorAddr: VALIDATOR_ADDR
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
        pageSize: opts.pageSize || 2,
        warnIntervalMs: 60000,
        retryIntervalMs: opts.retryIntervalMs,
        maxRetryIntervalMs: opts.maxRetryIntervalMs,
        indexerReadIntervalMs: opts.indexerReadIntervalMs,
        logger: opts.logger || { warn: sinon.stub(), error: sinon.stub() }
    });
}
module.exports = { PEER, VALIDATOR_ADDR, SIGNING_PUBKEY, peerManager, priceDb, makeCatchup };
