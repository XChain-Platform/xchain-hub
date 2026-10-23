'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('node:assert/strict');
const methods = require('../../../../../src/anchor/publisher/archive/sign.js');
const { getLogger } = require('../../../../../src/observability');

const logger = getLogger();
const myPubkey = 'aa'.repeat(32);
const sender = 'bb'.repeat(32);
const cases = [
    'signer_unavailable', 'request_data_missing', 'checkpoint_missing', 'self_request',
    'election_block_invalid', 'election_block_out_of_tolerance',
    'sender_not_elected_or_unlocked', 'sender_signature_invalid', 'batch_seq_stale',
    'signer_not_in_snapshot_set', 'local_checkpoint_mismatch', 'archive_invalid',
    'archive_diverges_from_local'
];

function harness(reason){
    let coSigned = false;
    const d = { checkpoint: { chain: 'doge', network: 'regtest', block_index: 12,
        snapshot_block: 90 }, election_block: 100, batch_seq: 7, sig_pubkey: sender };
    const pub = Object.assign(Object.create(methods), {
        identity: reason === 'signer_unavailable' ? null : { getPubkeyHex: () => myPubkey },
        hub: { resolveBtcLatestBlock: async () => reason === 'election_block_out_of_tolerance' ? 110 : 100 },
        electionToleranceBlocks: 5,
        getActiveOraclePublishPubkeys: async (block) =>
            reason === 'signer_not_in_snapshot_set' && block === 90 ? [sender] : [sender, myPubkey],
        archiveSenderUnlocked: () => reason !== 'sender_not_elected_or_unlocked',
        verifiedArchiveCanonical: () => reason === 'sender_signature_invalid' ? null : 'canonical',
        getNextBatchSeq: async () => reason === 'batch_seq_stale' ? 8 : 1,
        broadcastSeqRefusal: () => {}, bindObservedArchiveLeader: () => {},
        db: { getStateCheckpointByChainAndNetwork: async () => [{}] },
        ownArchiveWrapper: () => reason === 'local_checkpoint_mismatch' ? null : { snapshot_block: 90 },
        decodeArchiveProposal: () => reason === 'archive_invalid' ? null : { matches: [{}] },
        verifyArchiveAgainstLocal: async () => reason !== 'archive_diverges_from_local',
        coSignArchive: () => { coSigned = true; }
    });
    if(reason === 'request_data_missing') return { envelope: {}, pub, coSigned: () => coSigned };
    if(reason === 'checkpoint_missing') delete d.checkpoint;
    if(reason === 'self_request') d.sig_pubkey = myPubkey;
    if(reason === 'election_block_invalid') d.election_block = 'invalid';
    return { envelope: { data: d }, pub, coSigned: () => coSigned };
}

describe('archive sign request refusal diagnostics', function () {
    for(const reason of cases){
        it('rate-limits the ' + reason + ' refusal diagnostic', async function () {
            const { envelope, pub, coSigned } = harness(reason);
            const lines = [];
            const originalWarn = logger.warn;
            logger.warn = (line) => lines.push(line);
            try {
                await pub.handleSignReq(envelope);
                await pub.handleSignReq(envelope);
            } finally {
                logger.warn = originalWarn;
            }
            const seq = reason === 'request_data_missing' ? 'unknown' : 7;
            const claimedSender = reason === 'request_data_missing' ? 'unknown'
                : reason === 'self_request' ? myPubkey : sender;
            const detail = reason === 'election_block_out_of_tolerance'
                ? ' election_block=100 local_tip=110'
                : reason === 'batch_seq_stale' ? ' local_next_seq=8' : '';
            assert.deepEqual(lines, ['StateAnchorPublisher: declining archive SIGN_REQ reason=' +
                reason + ' batch_seq=' + seq + ' sender=' + claimedSender + detail]);
            assert.equal(coSigned(), false);
        });
    }
});
