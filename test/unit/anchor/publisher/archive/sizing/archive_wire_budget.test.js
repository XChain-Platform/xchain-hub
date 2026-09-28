'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { ARCHIVE_MAX_WIRE_B64_BYTES } =
    require('../../../../../../src/anchor/publisher/constants.js');

function buildPub(){
    const identity = new ValidatorIdentity('11'.repeat(32));
    return new StateAnchorPublisher({
        db: {}, network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ broadcast() {} })
    });
}

function checkpointRows(count){
    return Array.from({ length: count }, (_, i) => ({
        chain: 'BTC', network: 'regtest', checkpoint_seq: i + 1,
        payload: crypto.randomBytes(800).toString('hex')
    }));
}

function stubCheckpointArchive(pub){
    let calls = 0;
    pub.buildArchive = async (network, batchSeq, matches, wrapper, callRows, rewards, rows) => {
        calls++;
        return { json: JSON.stringify({ state_checkpoints: rows.checkpoints }), count: 0 };
    };
    return () => calls;
}

async function sizeCheckpoints(count, setup){
    const pub = buildPub();
    const input = checkpointRows(count);
    const rows = pub.archiveRows([], [], [], { checkpoints: input });
    const callCount = stubCheckpointArchive(pub);
    if(setup) setup(pub);
    const archive = await pub.buildSizedArchive('regtest', 1, rows, 1, []);
    return { pub, input, rows, archive, callCount };
}

describe('archive wire sizing', function () {
    this.timeout(30000);

    it('trims checkpoints to the default transaction-chain budget', async function () {
        const result = await sizeCheckpoints(200);
        const wire = result.pub.archiveWire(result.archive.json);
        expect(result.pub.maxArchiveChunks()).to.equal(12);
        expect(wire.chunks.length).to.be.at.most(12);
        expect(result.rows.cappedOrTrimmed).to.equal(true);
        expect(result.rows.checkpoints).to.deep.equal(result.input.slice(0, result.rows.checkpoints.length));
    });

    it('trims checkpoints to the encoded sign-request budget', async function () {
        const result = await sizeCheckpoints(700, pub => { pub.maxArchiveChunks = () => 1000; });
        const wire = result.pub.archiveWire(result.archive.json);
        expect(wire.b64.length).to.be.at.most(ARCHIVE_MAX_WIRE_B64_BYTES);
        expect(result.rows.cappedOrTrimmed).to.equal(true);
        expect(result.rows.checkpoints).to.deep.equal(result.input.slice(0, result.rows.checkpoints.length));
    });

    it('converges a thousand-checkpoint backlog within thirty builds', async function () {
        const result = await sizeCheckpoints(1000);
        expect(result.callCount()).to.be.at.most(30);
        expect(result.pub.archiveWire(result.archive.json).chunks.length).to.be.at.most(12);
    });

    it('returns an oversized legacy-only archive without trimming or throwing', async function () {
        const pub = buildPub();
        const matches = [{ id: 1, payload: crypto.randomBytes(60000).toString('hex') }];
        const rows = pub.archiveRows(matches, [], []);
        let calls = 0;
        pub.buildArchive = async () => { calls++; return { json: JSON.stringify({ matches }), count: 1 }; };
        const archive = await pub.buildSizedArchive('regtest', 1, rows, 1, []);
        expect(pub.archiveWire(archive.json).chunks.length).to.be.above(pub.maxArchiveChunks());
        expect(rows.matches).to.deep.equal(matches);
        expect(rows.cappedOrTrimmed).to.equal(false);
        expect(calls).to.equal(1);
    });
});
