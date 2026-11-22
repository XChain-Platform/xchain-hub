'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { XANC_SIGN } = require('../../../../../src/anchor/publisher/constants.js');
const { buildMesh, registerMeshHooks } = require('../../../../helpers/anchor_mesh.js');

const SLOT = 'EQUIV|XCHECKPOINT|BTC|regtest|100|7|5|0||';
const FIRST = SLOT + 'first';
const SECOND = SLOT + 'second';

function node(){
    return buildMesh(1, { btcBlock: 200, stakeWeighted: true }).nodes[0];
}

describe('StateAnchorPublisher archive wrapper slot latch', function () {
    registerMeshHooks();

    it('allows identical content and refuses different content in one slot', async function () {
        const current = node();
        expect(await current.pub.claimArchiveWrapperSlot(FIRST)).to.equal(true);
        expect(await current.pub.claimArchiveWrapperSlot(FIRST)).to.equal(true);
        expect(await current.pub.claimArchiveWrapperSlot(SECOND)).to.equal(false);
        expect(current.pub._archiveWrapperSlotRefusals).to.equal(1);
    });

    it('keeps the refusal durable across process memory loss', async function () {
        const current = node();
        expect(await current.pub.claimArchiveWrapperSlot(FIRST)).to.equal(true);
        current.pub._archiveWrapperSlots = new Map();
        expect(await current.pub.claimArchiveWrapperSlot(SECOND)).to.equal(false);
    });

    it('fails closed while the durable slot record cannot be written', async function () {
        const current = node();
        const insert = current.db.createConsensusStateIfAbsent;
        current.db.createConsensusStateIfAbsent = async () => { throw new Error('db down'); };
        expect(await current.pub.claimArchiveWrapperSlot(FIRST)).to.equal(false);
        current.db.createConsensusStateIfAbsent = insert;
        expect(await current.pub.claimArchiveWrapperSlot(FIRST)).to.equal(true);
    });

    it('leaves pre-header canonicals unchanged', async function () {
        const current = node();
        expect(await current.pub.claimArchiveWrapperSlot('XCHECKPOINT|legacy')).to.equal(true);
        expect(await current.pub.claimArchiveWrapperSlot('XCHECKPOINT|other')).to.equal(true);
    });

    it('routes follower archive signatures through the latch', async function () {
        const current = node();
        const sent = [];
        current.pub.recordObservedArchiveContent = () => {};
        current.pub.peerManager.broadcast = (type, data) => sent.push({ type, data });
        await current.pub.coSignArchive({ batch_seq: 5 }, 'leader', {}, FIRST, current.pubkey);
        await current.pub.coSignArchive({ batch_seq: 5 }, 'leader', {}, SECOND, current.pubkey);
        expect(sent.filter(item => item.type === XANC_SIGN)).to.have.length(1);
    });

    it('requires a claimed fold leader payload before re-signing it', async function () {
        const current = node();
        const round = { canonical: FIRST, cp: {}, wrapperSectionIndex: 0, batchSeq: 5,
            count: 1, crc: 'abcd', chunks: [Buffer.from('x')], b64: 'eA' };
        expect(current.pub.foldArchiveRequest(round)).to.equal(null);
        expect(await current.pub.claimArchiveWrapperSlot(FIRST)).to.equal(true);
        expect(current.pub.foldArchiveRequest(round)).to.be.an('object');
        round.canonical = SECOND;
        expect(current.pub.foldArchiveRequest(round)).to.equal(null);
    });
});
