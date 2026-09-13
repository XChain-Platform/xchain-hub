'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Review board #7578: the SINGLETON archive quorum bypass.
//
// Leader ELECTION resolves oracle_publish at the current BTC block, so a replacement
// publisher B can lead a round whose SIGNING set, resolved at the wrapper checkpoint's
// snapshot_block, is the single validator A. Three sites then colluded to publish and
// dequeue anyway:
//
//   _startArchiveRound seeded the leader's own signature whenever `snapCount <= 1`,
//   membership untested; the same `snapCount <= 1` took the immediate-publish fast
//   path with no quorum check at all; and _publishArchive's on-chain-validity gate
//   short-circuited on `round.validators.length === 1` before _quorumVerified ran.
//
// The indexer reaches the opposite verdict on the same bytes: anchor.js filters signers
// by snapshot membership and, with a one-member set, records the v1
// 'invalid: insufficient valid signatures (0/1)', while full-parse recovery throws on
// the wrapper. So the hub dequeued settled cross_chain rows behind an anchor that can
// never be reconstructed.
//
// Membership now gates the seed, the fast path requires the held signatures to satisfy
// quorum, and _quorumVerified is the sole on-chain verdict. The genuine single-node
// federation is unaffected, which is what the control cases here pin.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');

const BLOCK = 100;
const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: BLOCK, snapshot_block: BLOCK, state_root: null, block_merkle_root: null
};
const MATCH_ROW = {
    id: 1, match_id: 'm'.repeat(64), snapshot_block: BLOCK, network: 'regtest',
    a_chain: 'BTC', a_action_index: 1, a_kind: 'swap', a_tick: 'AAA', a_amount: '1',
    a_filled_before: '0', a_ownership: 0, a_payout_addr: 'addrA',
    b_chain: 'DOGE', b_action_index: 2, b_kind: 'swap', b_tick: 'BBB', b_amount: '2',
    b_filled_before: '0', b_ownership: 0, b_payout_addr: 'addrB',
    effective_time: 10, finalizing_view: 0, validator_signatures: '[]', status: 'settled'
};

// The OTHER validator: the sole member of the snapshot_block signing set in the
// replacement-publisher case, never this hub.
const OTHER    = new ValidatorIdentity('44'.repeat(32));
const OTHER_PK = OTHER.getPubkeyHex().toLowerCase();

function buildPub(rows) {
    rows = rows || {};
    let identity = new ValidatorIdentity('11'.repeat(32));
    let hub = {
        db: {
            async doQuery(sql) {
                for (let frag of Object.keys(rows))
                    if (sql.indexOf(frag) !== -1) return rows[frag];
                return [];
            }
        },
        network: 'regtest',
        capabilitySnapshot: null,
        capabilityRegistry: null,
        getIdentity: () => identity,
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {},
        rewardTracker: null,
        _resolveBtcLatestBlock: async () => BLOCK
    };
    return { pub: new StateAnchorPublisher(hub), identity };
}

// One pending match, an election set that always elects THIS hub, and a signing set the
// caller controls. _publishArchive is spied, never run, so a publish attempt is visible
// as an entry in `published` rather than as a DOGE send.
function archiveRound(signingSetFor) {
    let { pub, identity } = buildPub({
        'FROM cross_chain_matches WHERE batch_seq IS NULL': [MATCH_ROW],
        'FROM state_checkpoints':                           [CP_ROW]
    });
    let me = identity.getPubkeyHex().toLowerCase();
    let published = [];
    pub._getActiveOraclePublishPubkeys = async () => [me];
    pub._resolveCapabilitySet          = async () => signingSetFor(me);
    pub._getNextBatchSeq               = async () => 7;
    pub._publishArchive                = async (round) => { published.push(round); };
    return { pub, me, published };
}

describe('StateAnchorPublisher #7578 a singleton signing set still requires membership', () => {

    it('a NON-MEMBER leader of a one-member set defers instead of self-publishing', async () => {
        let { pub, published } = archiveRound(() => [{ pubkey: OTHER_PK, amount: '1', source: '' }]);
        expect(await pub._startArchiveRound(null, BLOCK), 'the round must defer').to.equal('none');
        expect(published.length, 'nothing may be broadcast to DOGE').to.equal(0);
    });

    it('does not seed a non-member leader signature into the round', async () => {
        // The seeding site is what the old `snapCount <= 1` disjunct bypassed. Reach it
        // with a TWO-member set that excludes this hub, so the round survives the
        // singleton fast path and its signature map is observable on _archiveRound.
        let { pub, me, published } = archiveRound(() => [
            { pubkey: OTHER_PK,          amount: '1', source: 'srcA' },
            { pubkey: 'bb'.repeat(32),   amount: '1', source: 'srcB' }
        ]);
        expect(await pub._startArchiveRound(null, BLOCK)).to.equal('round_started');
        expect(published.length, 'a multi-member round co-signs before it publishes').to.equal(0);
        expect(pub._archiveRound.signatures.has(me),
               'a leader outside the signing set must not inflate its own quorum').to.equal(false);
        expect(pub._archiveRound.signatures.size).to.equal(0);
        clearTimeout(pub._archiveRound.timer);
    });

    it('a GENUINE single-member set still self-signs and publishes (liveness control)', async () => {
        let { pub, me, published } = archiveRound((meIs) => [{ pubkey: meIs, amount: '1', source: '' }]);
        expect(await pub._startArchiveRound(null, BLOCK)).to.equal('published');
        expect(published.length, 'the sole validator publishes as before').to.equal(1);
        expect(published[0].signatures.get(me), 'its own signature is the quorum').to.be.a('string');
    });
});

describe('StateAnchorPublisher #7578 the on-chain-validity gate has no singleton bypass', () => {

    // _publishArchive far enough along to reach the validity gate and the back-fill,
    // with every send captured. `backfills` is the observable: '__partial__' statuses
    // mean the rows stayed pending, real statuses mean they were dequeued.
    function publishPub() {
        const sent = [], backfills = [];
        const pub = new StateAnchorPublisher({ db: { async doQuery(){ return []; } },
                                               p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
        pub.chunkRetryDelayMs = 1;
        pub.identity    = null;       // skips the publisher-attestation round
        pub.peerManager = null;       // skips the XANC_FINALIZED announce
        pub.dogeAddress = 'Dpub1';
        pub.spendGuard  = { isPaused: () => false, reserve: () => ({ id: 1 }), commit(){}, release(){},
                            noteBlocked: () => '' };
        pub._getLiveArchiveIntent  = async () => null;
        pub._recordArchiveIntent   = async () => {};
        pub._markArchiveSent       = async () => {};
        pub._withdrawArchiveIntent = async () => {};
        pub._settleArchiveIntent   = async () => {};
        pub._findExistingArchiveAnchor = async () => null;
        pub._findExistingArchiveChunk  = async () => null;
        pub._backfillBatch = async (seq, matches, txid) => { backfills.push({ seq, matches, txid }); };
        pub._recordReward  = () => {};
        return { pub, sent, backfills };
    }

    function round(sent, validators, signatures) {
        return {
            cp: CP_ROW, batchSeq: 7, count: 1, crc: 'deadbeef', chunks: ['chunk0'],
            canonical: 'canonical', quorum: 1, weighted: false,
            validators: validators, signatures: signatures,
            matchIds: [{ match_id: MATCH_ROW.match_id, status: 'settled' }], callIds: [], rewardIds: [],
            signer: { broadcastFn: async (p) => { sent.push(p); return { txid: 'e'.repeat(64) }; } }
        };
    }

    it('REFUSES to dequeue on a one-member set signed by a NON-member', async () => {
        const { pub, sent, backfills } = publishPub();
        // The old bypass read validators.length === 1 and never looked at who signed.
        await pub._publishArchive(round(sent,
            [{ pubkey: OTHER_PK, amount: '1', source: '' }],
            new Map([['cc'.repeat(32), 'not-a-member-signature']])));
        expect(backfills.length, 'the back-fill still runs, under the sentinel').to.equal(1);
        expect(backfills[0].matches[0].status,
               'rows must stay pending and re-archive under a fresh seq').to.equal('__partial__');
    });

    it('DEQUEUES a one-member set signed by that member (control)', async () => {
        const { pub, sent, backfills } = publishPub();
        await pub._publishArchive(round(sent,
            [{ pubkey: OTHER_PK, amount: '1', source: '' }],
            new Map([[OTHER_PK, OTHER.sign('canonical')]])));
        expect(backfills.length).to.equal(1);
        expect(backfills[0].matches[0].status,
               'a genuine single-node archive still dequeues').to.equal('settled');
    });
});
