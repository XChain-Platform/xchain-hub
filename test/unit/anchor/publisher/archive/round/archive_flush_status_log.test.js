'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect }   = require('chai');
const roundMethods = require('../../../../../../src/anchor/publisher/archive/round.js');

function rows(){
    return { rewards: [], cappedOrTrimmed: false };
}

function publisher(){
    return Object.assign({}, roundMethods, {
        _archiveRound: null,
        _archivePublishing: null,
        network: 'regtest',
        identity: { getPubkeyHex: () => 'me', sign: () => 'sig' },
        archiveTipUnresolved: () => false,
        archiveElectionPubkeys: async () => ['me', 'peer'],
        archiveElectionAdmits: () => true,
        gatherUnpublishedArchiveRows: async () => rows(),
        latestArchiveWrapperRows: async () => [{ network: 'regtest' }],
        cpFromRow: () => ({ snapshot_block: 100 }),
        getLiveArchiveIntent: async () => null,
        archiveRoundIntentHeld: () => false,
        getNextBatchSeq: async () => 7,
        leaderBatchSeqAboveOwn: async seq => seq,
        resolveArchiveRewardSources: async () => [],
        archiveEmptyAfterResolution: () => false,
        buildSizedArchive: async () => ({ json: '{}', count: 0 }),
        archiveRankLocked: () => false,
        archiveWire: () => ({ crc: '00000000', b64: '', chunks: ['chunk'] }),
        archiveCanonical: () => 'canonical',
        archiveSigningSet: async () => [{ pubkey: 'me' }, { pubkey: 'peer' }],
        archiveSigningSetUnresolved: () => false,
        openArchiveRound: () => ({ signatures: new Map([['me', 'sig']]), quorum: 1 }),
        singleMemberCannotSelfSign: () => false,
        publishSingleMemberArchive: async () => 'published',
        armArchiveRound: () => {},
        broadcastArchiveSignReq: () => {},
        checkArchiveQuorum: async () => {}
    });
}

async function decision(configure, failoverOnly){
    const pub = publisher();
    configure(pub);
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
        const status = await pub.startArchiveRound(null, 100, failoverOnly);
        const summaries = lines.filter(line => line.includes('archive flush summary:'));
        expect(summaries, 'one summary per completed decision').to.have.length(1);
        return { status, summary: summaries[0] };
    } finally {
        console.log = original;
    }
}

describe('archive flush status logging', function(){
    const cases = [
        ['round pending', 'round_pending', 'round_or_publish_pending', pub => {
            Object.assign(pub, { _archiveRound: {} });
        }],
        ['tip unresolved', 'none', 'tip_unresolved', pub => { pub.archiveTipUnresolved = () => true; }],
        ['election denied', 'none', 'election_not_admitted', pub => { pub.archiveElectionAdmits = () => false; }],
        ['no pending rows', 'none', 'no_pending_rows', pub => { pub.gatherUnpublishedArchiveRows = async () => null; }],
        ['no wrapper checkpoint', 'none', 'no_wrapper_checkpoint', pub => { pub.latestArchiveWrapperRows = async () => []; }],
        ['live intent held', 'intent_held', 'live_intent_held', pub => { pub.archiveRoundIntentHeld = () => true; }],
        ['empty after reward resolution', 'none', 'empty_after_reward_resolution', pub => { pub.archiveEmptyAfterResolution = () => true; }],
        ['signing set unresolved', 'none', 'signing_set_unresolved', pub => { pub.archiveSigningSetUnresolved = () => true; }],
        ['single member cannot self-sign', 'none', 'single_member_cannot_self_sign', pub => {
            pub.archiveSigningSet = async () => [{ pubkey: 'peer' }];
            pub.singleMemberCannotSelfSign = () => true;
        }],
        ['publish intent held', 'intent_held', 'publish_intent_held', pub => {
            pub.archiveSigningSet = async () => [{ pubkey: 'me' }];
            pub.publishSingleMemberArchive = async () => 'intent_held';
        }],
        ['single member published', 'published', 'single_member_published', pub => {
            pub.archiveSigningSet = async () => [{ pubkey: 'me' }];
        }],
        ['signature round started', 'round_started', 'signature_round_started', () => {}]
    ];
    for(const [name, status, reason, configure] of cases){
        it('summarizes ' + name, async function(){
            const out = await decision(configure, false);
            expect(out.status).to.equal(status);
            expect(out.summary).to.equal(
                'StateAnchorPublisher: archive flush summary: status=' + status + ' reason=' + reason);
        });
    }
    it('names a rank-0 leader standing down on a failover wake', async function(){
        const out = await decision(pub => {
            pub.archiveRankLocked = roundMethods.archiveRankLocked;
            pub.archiveElectionDecision = () => ({ order: ['me', 'peer'], unlocked: true });
            pub.isRankZero = order => order[0] === 'me';
        }, true);
        expect(out.status).to.equal('none');
        expect(out.summary).to.equal(
            'StateAnchorPublisher: archive flush summary: status=none reason=rank_zero_on_failover_wake');
    });

    it('names a backup whose failover rank has not unlocked', async function(){
        const out = await decision(pub => {
            pub.archiveRankLocked = roundMethods.archiveRankLocked;
            pub.archiveElectionDecision = () => ({
                order: ['peer', 'me'],
                unlocked: false,
                anchor: { block: 100 }
            });
            pub.isRankZero = order => order[0] === 'me';
            pub.electionToleranceBlocks = 36;
        }, true);
        expect(out.status).to.equal('none');
        expect(out.summary).to.equal(
            'StateAnchorPublisher: archive flush summary: status=none reason=rank_not_unlocked');
    });
});
