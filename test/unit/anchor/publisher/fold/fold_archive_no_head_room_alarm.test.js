'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const { ANCHOR_BUNDLE_MAX_BYTES } = require('../../../../../src/anchor/publisher/constants.js');
const { foldArchiveSplitter } = require('../../../../../src/anchor/publisher/fold/archive_head_budget.js');
const { getLogger } = require('../../../../../src/observability');

function hex(length, value = 'a'){
    return value.repeat(length);
}

function signatures(count){
    return Array.from({ length: count }, (_, index) => ({
        pubkey: hex(64, String(index % 10)), sig: hex(128, String(index % 10))
    }));
}

function section(chain, network){
    return {
        chain, network, block_index: 9625000,
        block_hash: hex(64), ledger_hash: hex(64), actions_hash: hex(64), contract_hash: hex(64),
        checkpoint_seq: 962500, snapshot_block: 962500,
        state_root: hex(64), state_root_version: 1,
        block_merkle_root: hex(64), block_merkle_version: 1,
        validator_signatures: JSON.stringify(signatures(4))
    };
}

async function setup(network){
    const pub = new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    const signingSet = signatures(5);
    pub.getActiveOraclePublishPubkeys = async () => signingSet.map(item => item.pubkey);
    const group = [section('BTC', network), section('LTC', network), section('ZEC', network)];
    const fits = await foldArchiveSplitter(pub, group, network, 42, 0, signingSet, hex(64));
    const roomy = group.map(item => Object.assign({}, item));
    group[0].block_hash += 'd'.repeat(ANCHOR_BUNDLE_MAX_BYTES - fits.baseBytes + 1);
    pub._foldArchiveNoHeadRoom = 0;
    pub._foldArchiveNoHeadRoomStreak = {};
    const measure = (target, net) => foldArchiveSplitter(pub, target, net, 42, 0, signingSet, hex(64));
    return { pub, group, roomy, measure };
}

async function staysQuietBelowTheAlarmThreshold(){
    const { pub, group, measure } = await setup('mainnet');
    const error = sinon.stub(getLogger(), 'error');
    try {
        expect(await measure(group, 'mainnet')).to.equal(null);
        expect(await measure(group, 'mainnet')).to.equal(null);
        expect(error.called).to.equal(false);
        expect(pub.getAnchorStats().foldArchiveNoHeadRoomStreak).to.deep.equal({ mainnet: 2 });
    } finally { error.restore(); }
}

async function raisesAnErrorOnSustainedMisses(){
    const { pub, group, measure } = await setup('mainnet');
    const error = sinon.stub(getLogger(), 'error');
    try {
        for(let i = 0; i < 3; i++) await measure(group, 'mainnet');
        expect(error.callCount).to.equal(1);
        expect(error.firstCall.args[0]).to.include('mainnet').and.to.include('3 consecutive');
        for(let i = 0; i < 3; i++) await measure(group, 'mainnet');
        expect(error.callCount).to.equal(2);
        expect(pub._foldArchiveNoHeadRoom).to.equal(6);
        expect(pub.getAnchorStats().foldArchiveNoHeadRoom).to.equal(6);
    } finally { error.restore(); }
}

async function clearsTheStreakWhenRoomReturns(){
    const { pub, group, roomy, measure } = await setup('mainnet');
    const error = sinon.stub(getLogger(), 'error');
    try {
        await measure(group, 'mainnet');
        await measure(group, 'mainnet');
        const splitter = await measure(roomy, 'mainnet');
        expect(splitter).to.not.equal(null);
        expect(pub.getAnchorStats().foldArchiveNoHeadRoomStreak).to.deep.equal({ mainnet: 2 });
        expect(splitter('YWJj')).to.deep.equal(['YWJj']);
        expect(pub.getAnchorStats().foldArchiveNoHeadRoomStreak).to.deep.equal({});
        await measure(group, 'mainnet');
        await measure(group, 'mainnet');
        expect(error.called).to.equal(false);
    } finally { error.restore(); }
}

async function countsStreaksPerNetwork(){
    const { pub, group, measure } = await setup('mainnet');
    const other = group.map(item => Object.assign({}, item, { network: 'testnet' }));
    const error = sinon.stub(getLogger(), 'error');
    try {
        await measure(group, 'mainnet');
        await measure(other, 'testnet');
        await measure(group, 'mainnet');
        expect(error.called).to.equal(false);
        expect(pub.getAnchorStats().foldArchiveNoHeadRoomStreak).to.deep.equal({ mainnet: 2, testnet: 1 });
    } finally { error.restore(); }
}

// One byte of head room passes the measurement, then a long archive needs a
// two-digit chunk count and the splitter itself reports the miss.
async function escalatesChunkCountMisses(){
    const { pub, roomy, measure } = await setup('mainnet');
    const fits = await measure(roomy, 'mainnet');
    roomy[0].block_hash += 'd'.repeat(ANCHOR_BUNDLE_MAX_BYTES - fits.baseBytes - 1);
    const long = Buffer.alloc(40000, 7).toString('base64');
    const error = sinon.stub(getLogger(), 'error');
    try {
        for(let i = 0; i < 9; i++){
            const splitter = await measure(roomy, 'mainnet');
            expect(splitter.baseBytes).to.equal(ANCHOR_BUNDLE_MAX_BYTES - 1);
            expect(() => splitter(long)).to.throw(RangeError, 'no head room');
        }
        expect(pub._foldArchiveNoHeadRoom).to.equal(9);
        expect(pub.getAnchorStats().foldArchiveNoHeadRoomStreak).to.deep.equal({ mainnet: 9 });
        expect(error.callCount).to.equal(3);
    } finally { error.restore(); }
}

describe('StateAnchorPublisher folded archive no-head-room alarm', function () {
    it('stays quiet below the consecutive-miss threshold', staysQuietBelowTheAlarmThreshold);
    it('raises an error on sustained misses and repeats every third', raisesAnErrorOnSustainedMisses);
    it('clears the streak when a head measurement succeeds', clearsTheStreakWhenRoomReturns);
    it('counts streaks per network', countsStreaksPerNetwork);
    it('escalates misses the splitter reports after the head measurement', escalatesChunkCountMisses);
});
