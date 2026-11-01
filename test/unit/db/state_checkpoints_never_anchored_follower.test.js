'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins the never-anchored follower path: with no checkpoint ever anchored, the
// oldest-unanchored query still yields a content block (its LEFT JOIN keeps rows
// with no anchor), so the ladder age unlocks rank 1. The follower co-signs the
// rank 1 request and declines the still-locked rank 2 one with a logged reason.

const assert = require('node:assert/strict');
const ValidatorIdentity = require('../../../src/validators/identity.js');
const canonicalForms = require('../../../src/anchor/publisher/canonical_forms.js');
const ladderMethods = require('../../../src/anchor/publisher/ladder/bundle_content_age.js');
const attestMethods = require('../../../src/anchor/publisher/attest_round.js');
// Loaded for its side effect: reward.js wraps handleAttestSignReq in place with the
// fold-archive co-sign hook, as every running hub has it. Loading it here keeps this
// test on that production composition whatever other suites loaded first.
require('../../../src/anchor/publisher/reward.js');
const stateCheckpointMethods = require('../../../src/db/state_checkpoints.js');
const { getLogger } = require('../../../src/observability');

function buildNeverAnchoredFollowerFixture(){
    const network = 'regtest';
    const identities = Array.from({ length: 4 }, () =>
        new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
    const byPubkey = new Map(identities.map(identity => [identity.getPubkeyHex(), identity]));
    const electionSet = identities.map(identity => identity.getPubkeyHex());
    const electionKey = 'never-anchored-follower';
    const order = canonicalForms.hashOrder(electionKey, electionSet);
    const checkpoints = [];
    for(let block = 106, seq = 8; block <= 136; block += 6, seq++)
        checkpoints.push({ chain: 'BTC', network, snapshot_block: block, checkpoint_seq: seq,
                           block_index: 900 + seq, anchor_txid: null });
    const row = checkpoints[checkpoints.length - 1];
    const evidence = { sql: '' };
    const db = {
        async findOldestUnanchoredCheckpointBlocksByNetwork(...args){
            return stateCheckpointMethods.findOldestUnanchoredCheckpointBlocksByNetwork.call({
                doQuery: async sql => {
                    evidence.sql = sql;
                    assert.equal(checkpoints.some(checkpoint => checkpoint.anchor_txid !== null), false);
                    return [{ chain: 'BTC', oldest_block: checkpoints[0].snapshot_block }];
                }
            }, ...args);
        },
        async getStateCheckpointByChain(){ return [row]; }
    };
    const sent = [];
    const follower = Object.assign({}, ladderMethods, attestMethods, {
        db,
        identity: byPubkey.get(order[3]),
        hub: { resolveBtcLatestBlock: async () => 142 },
        checkpointIntervalBlocks: 1,
        anchorEveryNCheckpoints: 1,
        peerManager: { broadcast: type => sent.push(type) },
        bundleElectionKey: () => electionKey,
        rankUnlocked: (rankOrder, sender, age) => rankOrder.indexOf(sender) <= Math.floor(age / 36),
        getActiveOraclePublishPubkeys: async () => electionSet,
        findAnchorEligibleSections: async () => [row],
        coSignFoldArchiveRequest: async () => null,
        buildV7Payload: (rows, publisher) => JSON.stringify([rows[0].checkpoint_seq, publisher]),
        attestationCanonical: (bundle, publisher) => 'XANCPUB|' + bundle.network + '|' + publisher,
        claimAttestSlot: async () => true
    });
    return { network, byPubkey, order, row, evidence, sent, follower };
}

function neverAnchoredFollowerRequest(fixture, publisher){
    const { network, byPubkey, row, follower } = fixture;
    const canonical = follower.attestationCanonical({ network }, publisher);
    return { data: {
        network, snapshot_block: row.snapshot_block,
        sections: [{ chain: row.chain, block_index: row.block_index, checkpoint_seq: row.checkpoint_seq }],
        body: follower.buildV7Payload([row], publisher), publisher, sig_pubkey: publisher,
        sig: byPubkey.get(publisher).sign(canonical)
    } };
}

describe('state checkpoints never-anchored follower', () => {
    it('a never-anchored follower co-signs unlocked rank 1 and explains a locked decline', async () => {
        const fixture = buildNeverAnchoredFollowerFixture();
        const { network, order, row, evidence, sent, follower } = fixture;
        const contentBlock = await follower.bundleContentBlock(network, [row]);
        assert.equal(contentBlock, 106);
        assert.equal(follower.bundleLadderBlock([row], 142, contentBlock) - row.snapshot_block, 36);
        assert.match(evidence.sql, /LEFT JOIN/);
        assert.match(evidence.sql, /a\.anchored_seq IS NULL OR sc\.checkpoint_seq > a\.anchored_seq/);
        // The wrapped handler resolves no verdict, so the co-sign shows as one XANCPUB_SIGN.
        await follower.handleAttestSignReq(neverAnchoredFollowerRequest(fixture, order[1]));
        assert.equal(sent.filter(type => type === 'XANCPUB_SIGN').length, 1);

        const warnings = [];
        const logger = getLogger();
        const warn = logger.warn;
        logger.warn = message => warnings.push(String(message));
        try { await follower.handleAttestSignReq(neverAnchoredFollowerRequest(fixture, order[2])); }
        finally { logger.warn = warn; }
        assert.equal(sent.filter(type => type === 'XANCPUB_SIGN').length, 1);
        assert.ok(warnings.some(message => message.includes('reason=publisher_rank_locked') &&
                                           message.includes('publisher=' + order[2])));
    });
});
