'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const crypto = require('crypto');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const { ANCHOR_BUNDLE_MAX_BYTES } = require('../../../../../src/anchor/publisher/constants.js');
const { foldArchiveSplitter } = require('../../../../../src/anchor/publisher/fold/archive_head_budget.js');

function hex(length, value = 'a'){
    return value.repeat(length);
}

function signatures(count){
    return Array.from({ length: count }, (_, index) => ({
        pubkey: hex(64, String(index % 10)), sig: hex(128, String(index % 10))
    }));
}

function section(chain, signerCount){
    return {
        chain, network: 'mainnet', block_index: 9625000,
        block_hash: hex(64), ledger_hash: hex(64), actions_hash: hex(64), contract_hash: hex(64),
        checkpoint_seq: 962500, snapshot_block: 962500,
        state_root: hex(64), state_root_version: 1,
        block_merkle_root: hex(64), block_merkle_version: 1,
        validator_signatures: JSON.stringify(signatures(signerCount))
    };
}

function publisher(){
    return new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
}

function keepsLegacyChunksUniform(){
    const pub = publisher();
    const body = 'B'.repeat(pub.chunkMaxBytes * 2 + 17);
    expect(pub.splitChunks(body).map(chunk => chunk.length))
        .to.deep.equal([pub.chunkMaxBytes, pub.chunkMaxBytes, 17]);
    expect(pub.splitFoldChunks(body, 31).map(chunk => chunk.length))
        .to.deep.equal([31, pub.chunkMaxBytes, pub.chunkMaxBytes - 14]);
    expect(() => pub.splitFoldChunks(body, 0)).to.throw(RangeError);
}

function sizesArchiveLessFoldedGroups(){
    const pub = publisher();
    const group = [section('BTC', 5), section('LTC', 5), section('ZEC', 5)];
    const attest = signatures(5);
    const actual = Buffer.byteLength(pub.buildV3Payload(null, group, null, hex(64), attest), 'utf8');
    expect(pub.v7Bytes(group, hex(64), attest.length, true)).to.equal(actual);
    expect(pub.v7Bytes(group, hex(64), attest.length, true) -
           pub.v7Bytes(group, hex(64), attest.length, false)).to.equal(2);
}

function refusesV0BoundarySection(){
    const pub = publisher();
    const candidate = section('BTC', 1);
    const remaining = ANCHOR_BUNDLE_MAX_BYTES - pub.v7Bytes([candidate], hex(64), 0);
    candidate.block_hash += 'b'.repeat(remaining);
    expect(pub.v7Bytes([candidate], hex(64), 0)).to.equal(ANCHOR_BUNDLE_MAX_BYTES);
    expect(pub.splitBundle([candidate], hex(64), 0, false).bundles).to.have.length(1);
    const folded = pub.splitBundle([candidate], hex(64), 0, true);
    expect(folded.bundles).to.deep.equal([]);
    expect(folded.oversize[0].bytes).to.equal(ANCHOR_BUNDLE_MAX_BYTES + 2);
}

async function fitsLargeArchive(){
    const pub = publisher();
    const group = [section('BTC', 4), section('LTC', 4), section('ZEC', 4)];
    const signingSet = signatures(5);
    pub.getActiveOraclePublishPubkeys = async () => signingSet.map(item => item.pubkey);
    const splitter = await foldArchiveSplitter(pub, group, 'mainnet', 42, 0, signingSet, hex(64));
    const b64 = 'C'.repeat(10000);
    const chunks = splitter(b64);
    const archive = {
        wrapperSectionIndex: 0, batchSeq: 42, count: 17, crc: '1a2b3c4d',
        chunks, signatures: signingSet
    };
    const payload = pub.buildV3Payload(null, group, archive, hex(64), signatures(5));
    expect(Buffer.byteLength(payload, 'utf8')).to.be.at.most(ANCHOR_BUNDLE_MAX_BYTES);
    expect(chunks.join('')).to.equal(b64);
    expect(chunks[0].length).to.be.within(1, pub.chunkMaxBytes - 1);
    expect(chunks).to.have.length.above(1);
}

async function reservesFinalChunkCountWidth(){
    const pub = publisher();
    pub.chunkMaxBytes = 64;
    const group = [section('BTC', 1)];
    const signingSet = signatures(1);
    pub.getActiveOraclePublishPubkeys = async () => [];
    let splitter = await foldArchiveSplitter(pub, group, 'mainnet', 42, 0, signingSet, hex(64));
    group[0].block_hash += 'd'.repeat(splitter.baseBytes > 8125 ? 0 : 8125 - splitter.baseBytes);
    splitter = await foldArchiveSplitter(pub, group, 'mainnet', 42, 0, signingSet, hex(64));
    const matches = [{ id: 1, payload: crypto.randomBytes(8000).toString('hex') }];
    const rows = pub.archiveRows(matches, [], []);
    pub.buildArchive = async () => ({ json: JSON.stringify({ matches }), count: 1000 });
    const archive = await pub.buildSizedArchive('mainnet', 42, rows, 1, [], splitter);
    const wire = pub.archiveWire(archive.json, splitter);
    const archiveSection = {
        wrapperSectionIndex: 0, batchSeq: 42, count: archive.count, crc: wire.crc,
        chunks: wire.chunks, signatures: signingSet
    };
    const payload = pub.buildV3Payload(null, group, archiveSection, hex(64), []);
    const nominalDigits = String(pub.maxArchiveChunks()).length;
    const nominalHeadChars = ANCHOR_BUNDLE_MAX_BYTES - splitter.baseBytes - nominalDigits + 1;
    const nominalSection = Object.assign({}, archiveSection, {
        chunks: pub.splitFoldChunks(wire.b64, nominalHeadChars)
    });
    const nominalPayload = pub.buildV3Payload(null, group, nominalSection, hex(64), []);
    expect(wire.chunks).to.have.length.above(99);
    expect(nominalSection.chunks).to.have.length.above(99);
    expect(wire.chunks[0]).to.have.length(splitter.headChars);
    expect(Buffer.byteLength(nominalPayload, 'utf8')).to.be.above(ANCHOR_BUNDLE_MAX_BYTES);
    expect(Buffer.byteLength(payload, 'utf8')).to.be.at.most(ANCHOR_BUNDLE_MAX_BYTES);
    expect(rows.matches).to.deep.equal(matches);
}

async function skipsSigningWithoutHeadRoom(){
    const pub = publisher();
    const group = [section('BTC', 4), section('LTC', 4), section('ZEC', 4)];
    const signingSet = signatures(5);
    pub.getActiveOraclePublishPubkeys = async () => signingSet.map(item => item.pubkey);
    const first = await foldArchiveSplitter(pub, group, 'mainnet', 42, 0, signingSet, hex(64));
    group[0].block_hash += 'd'.repeat(ANCHOR_BUNDLE_MAX_BYTES - first.baseBytes + 1);
    expect(pub.v7Bytes(group, hex(64), signingSet.length, true)).to.be.at.most(ANCHOR_BUNDLE_MAX_BYTES);
    pub._foldArchiveNoHeadRoom = 0;
    expect(await foldArchiveSplitter(pub, group, 'mainnet', 42, 0, signingSet, hex(64))).to.equal(null);
    expect(pub._foldArchiveNoHeadRoom).to.equal(1);
}

async function passesResolvedFoldState(){
    const pub = publisher();
    const candidate = Object.assign(section('BTC', 1), { network: 'testnet' });
    let foldActive = null;
    pub.identity = { getPubkeyHex: () => hex(64) };
    pub.getActiveOraclePublishPubkeys = async () => [hex(64)];
    pub.hub = { resolveDogeLatestBlock: async () => 68000000 };
    pub.splitBundle = (rows, key, count, active) => {
        foldActive = active;
        return { bundles: [], oversize: [] };
    };
    pub.suppressLegacyArchiveLeg = () => {};
    await pub.publishNetworkBundles({}, 'testnet', [candidate], 68000000, false, [], { rows: 0 });
    expect(foldActive).to.equal(true);
}

describe('StateAnchorPublisher folded archive byte sizing', function () {
    it('keeps legacy chunks uniform while using a shorter folded head chunk', keepsLegacyChunksUniform);
    it('sizes archive-less folded groups with the v3 wire shape', sizesArchiveLessFoldedGroups);
    it('refuses a v0 boundary section from the folded split', refusesV0BoundarySection);
    it('fits a large archive by reserving the real worst-case v3 head', fitsLargeArchive);
    it('reserves the final chunk-count width for an untrimmed legacy archive', reservesFinalChunkCountWidth);
    it('skips archive signing when its fixed v3 fields leave no head room', skipsSigningWithoutHeadRoom);
    it('passes the resolved fold state into bundle splitting', passesResolvedFoldState);
});
