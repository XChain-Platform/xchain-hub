'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');

const TXID = 'ab'.repeat(32);
const CP = {
    chain: 'BTC', network: 'regtest', block_index: 100, checkpoint_seq: 4
};

function oversizePublisher(){
    const pub = Object.create(StateAnchorPublisher.prototype);
    pub.identity = { getPubkeyHex: () => 'aa' };
    pub._foldArchiveDroppedOversize = 0;
    pub._observedArchiveCheckpoints = new Map([[0, CP]]);
    pub._observedFoldArchiveKeys = new Map();
    pub.recordObservedFoldArchiveKey(0, 'aa', {
        cp: CP, batchCrc32: '1234abcd', matchCount: 2, totalChunks: 3
    });
    pub.bundlePublisherOrder = async () => ['aa'];
    pub.standsDownFromBundle = () => false;
    pub.bundleHeldByIntent = async () => false;
    pub.findExistingBundle = async () => null;
    pub.collectFoldArchive = async () => ({ result: Promise.resolve({
        cp: CP, batchSeq: 0, headChars: 9000
    }) });
    pub.armFoldArchiveRound = () => {};
    pub.collectBundleAttestation = async () => ({ attested: false, attestSigs: [] });
    pub.suppressLegacyArchiveLeg = () => {};
    pub.buildBundleWire = (...args) => args[7] ? null : 'ANCHOR|3|regtest|100|0|0|aa|0';
    pub.sendBundle = async (_signer, _group, _payload, archive) => {
        pub.sentArchive = archive;
        return { txid: TXID };
    };
    pub.bundleResultTxid = result => result.txid;
    pub.stampBundleSections = async () => {};
    pub.completeFoldArchive = async () => {};
    pub.noteBundlePublished = () => {};
    pub.recordBundleReward = async () => null;
    pub.announceBundleDone = () => {};
    return pub;
}

describe('FINALIZED after an oversized folded archive is omitted', function () {
    it('accepts the later v1 head instead of selecting v3 from the stale fold key', async function () {
        const pub = oversizePublisher();
        const group = [{ chain: 'BTC', network: 'regtest', snapshot_block: 100 }];

        await pub.publishBundle({}, 'regtest', group, 100, false, [], { rows: 0 }, { active: true });
        expect(pub._foldArchiveDroppedOversize).to.equal(1);
        expect(pub.sentArchive).to.equal(null);
        expect(pub.observedFoldArchiveKey(0, 'aa')).to.not.equal(null);

        pub.verifyArchiveIdentityOnChain = async (...args) => {
            pub.wrapperChecks = (pub.wrapperChecks || []).concat([args]);
            return args[2].version === 1 ? 'verified' : 'rejected:version';
        };
        pub.indexerCall = async () => { throw new Error('unexpected archive lookup'); };

        expect(await pub.verifyFinalizedArchiveOnChain(
            { batch_seq: 0, txid: TXID }, 'aa')).to.equal('verified');
        expect(pub.wrapperChecks).to.deep.equal([[CP, TXID, { version: 1 }]]);
    });
});
