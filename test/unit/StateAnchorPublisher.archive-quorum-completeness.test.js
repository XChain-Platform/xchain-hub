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

// Three archive-path fail-opens on the DOGE anchor rail (review board #4183, #4185,
// and the null-txid half of #4180).
//
//   #4183 _startArchiveRound treated an EMPTY oracle_publish signing set as a
//         single-validator quorum: `snapCount <= 1` self-signed and published a v1
//         the leader is not a member of, then dequeued the settled cross_chain rows,
//         while the indexer + full-parse recovery refuse an empty-set anchor. The
//         two sibling attestation rounds already abstained on snapCount === 0.
//
//   #4185 _verifyArchiveAgainstLocal derived its capability groups solely from the
//         ATTACKER-SUPPLIED archive.capability_snapshots and validated only the
//         groups present. A Byzantine elected leader could drop a whole group; the
//         match/call/reward checks resolve their sets locally so they still pass, the
//         follower co-signs, and recovery (which rebuilds each set FROM the archived
//         rows) then rejects the anchor for good.
//
//   #4180 _handleFinalized back-filled rows as archived with no on-chain check at
//         all, so an elected leader could announce real rows at their true terminal
//         statuses and suppress them from every future archive round. Closed in two
//         halves. NULL txid: an honest publish marks every row '__partial__' when the
//         broadcast returned no txid, so that shape is unproducible honestly and is
//         refused outright. FABRICATED txid: the announced archive HEAD must be on
//         DOGE at depth before the suppressing column is written, and because the
//         announcement rides at 0 confirmations the back-fill splits - the seq stamps
//         now under the '__partial__' sentinel (which keeps the rows eligible) and the
//         announced statuses + txid stamp later, from the same V0_DONE-style
//         defer-and-re-verify queue.

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

function srcOf(pk) { return 'src_' + String(pk).toLowerCase().substring(0, 12); }

// Minimal publisher over a SQL-shape-routed db mock. `rows` maps a distinguishing
// fragment of each SELECT this path issues to the rows it should answer with.
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
        rewardTracker: {
            anchorReward: '10.00000000',
            resolveSourceByPubkey: async (pk) => srcOf(pk)
        },
        _resolveBtcLatestBlock: async () => BLOCK
    };
    return { pub: new StateAnchorPublisher(hub), identity };
}

describe('StateAnchorPublisher #4183 empty signing set is not a quorum of one', () => {

    // The archive round with one pending match, a resolvable election set, and a
    // signing set the caller controls. _publishArchive is spied, never run.
    // `signingSetFor` receives this hub's own pubkey so a caller can build a set
    // that does (or does not) contain it.
    function archiveRound(signingSetFor) {
        let { pub, identity } = buildPub({
            'FROM cross_chain_matches WHERE batch_seq IS NULL': [MATCH_ROW],
            'FROM state_checkpoints':                           [CP_ROW]
        });
        let me = identity.getPubkeyHex().toLowerCase();
        let published = [];
        pub._getActiveOraclePublishPubkeys = async () => [me];    // election set resolves: this hub leads
        pub._resolveCapabilitySet          = async () => signingSetFor(me);
        pub._getNextBatchSeq               = async () => 7;
        pub._publishArchive                = async (round) => { published.push(round); };
        return { pub, me, published };
    }

    it('an EMPTY signing set DEFERS the round instead of self-publishing a v1', async () => {
        let { pub, published } = archiveRound(() => []);
        expect(await pub._startArchiveRound(null, BLOCK), 'round must defer').to.equal('none');
        expect(published.length, 'nothing may be broadcast to DOGE').to.equal(0);
    });

    it('a GENUINE single-member set still self-signs and publishes (liveness preserved)', async () => {
        let { pub, published } = archiveRound((me) => [{ pubkey: me, amount: '1', source: '' }]);
        expect(await pub._startArchiveRound(null, BLOCK)).to.equal('published');
        expect(published.length, 'the sole validator publishes as before').to.equal(1);
        expect(published[0].signatures.size).to.equal(1);
    });
});

describe('StateAnchorPublisher #4185 archive must carry every expected snapshot group', () => {

    const PK_A = 'aa'.repeat(32);
    const PK_B = 'bb'.repeat(32);
    const SET  = [{ pubkey: PK_A, amount: '1', source: '' }, { pubkey: PK_B, amount: '1', source: '' }];

    const REWARD = {
        validator_pubkey: PK_A, source: srcOf(PK_A), round_number: 7,
        reward_type: 'anchor_BTC', amount: '10.00000000', block_index: BLOCK
    };
    // The group an honest _buildArchive emits for that reward's earn block.
    const GROUP = SET.map(v => ({ snapshot_block: BLOCK, capability: 'oracle_publish',
                                  signing_pubkey: v.pubkey, amount: v.amount, source: v.source }));

    function verifier(resolved) {
        let { pub } = buildPub({});                         // no local reward rows: late-joiner path
        pub._resolveCapabilitySet = async () => (resolved === undefined ? SET : resolved);
        return pub;
    }

    it('accepts a COMPLETE archive (control)', async () => {
        let pub = verifier();
        expect(await pub._verifyArchiveAgainstLocal(
            { matches: [], calls: [], rewards: [REWARD], capability_snapshots: GROUP }, BLOCK)).to.equal(true);
    });

    it('REFUSES an archive whose reward group was stripped, though every present group is honest', async () => {
        let pub = verifier();
        expect(await pub._verifyArchiveAgainstLocal(
            { matches: [], calls: [], rewards: [REWARD], capability_snapshots: [] }, BLOCK)).to.equal(false);
    });

    it('REFUSES an archive whose WRAPPER oracle_publish group was stripped', async () => {
        // The reward group is present and honest; only the wrapper checkpoint's own
        // group (at a different block) is missing, so nothing in the per-group loop
        // ever visits it without the completeness derivation.
        let pub = verifier();
        expect(await pub._verifyArchiveAgainstLocal(
            { matches: [], calls: [], rewards: [REWARD], capability_snapshots: GROUP }, BLOCK + 6)).to.equal(false);
    });

    it('does NOT false-reject a group our own resolution also finds empty', async () => {
        // An honest builder emits one row per member, so a legitimately empty set
        // produces no rows at all. Requiring presence outright would stall co-signing
        // on honest rounds; the completeness check compares sizes instead.
        let pub = verifier([]);
        expect(await pub._verifyArchiveAgainstLocal(
            { matches: [], calls: [], rewards: [], capability_snapshots: [] }, BLOCK)).to.equal(true);
    });

    it('REFUSES an archive demanding a group at a non-numeric block', async () => {
        let pub = verifier();
        expect(await pub._verifyArchiveAgainstLocal(
            { matches: [], calls: [],
              rewards: [Object.assign({}, REWARD, { block_index: 'not-a-block' })],
              capability_snapshots: GROUP }, BLOCK)).to.equal(false);
    });
});

describe('StateAnchorPublisher #4180 a FINALIZED may not stamp terminal rows unverified', () => {

    const TXID = 'd'.repeat(64);

    // An authenticated FINALIZED from an observed elected leader. Everything the
    // guard is NOT about (membership, signature, observed-leader, content re-check)
    // is satisfied, so only the txid/status combination and the on-chain verdict
    // decide the outcome. `onChain` is what the archive-head check answers with.
    function finalized(txid, status, onChain) {
        let { pub } = buildPub({});
        let leader  = new ValidatorIdentity('22'.repeat(32));
        let sender  = leader.getPubkeyHex().toLowerCase();
        let matches = [{ match_id: MATCH_ROW.match_id, status: status }];
        let stamped = [];
        let asked   = [];

        pub._getActiveOraclePublishPubkeys = async () => [sender];
        pub._isObservedArchiveLeader       = () => true;
        pub._verifyFinalizedAgainstLocal   = async () => true;   // statuses genuinely match our rows
        pub._backfillBatch                 = async (...a) => { stamped.push(a); };
        pub._recordReward                  = async () => {};     // reward rail is #4180-adjacent, not the subject
        pub._verifyArchiveCheckpointOnChain = async (seq, tx, expect) => {
            asked.push({ seq: seq, txid: tx, expect: expect });
            return onChain === undefined ? 'verified' : onChain;
        };

        let d = { batch_seq: 7, txid: txid, matches: matches, calls: [], rewards: [],
                  snapshot_block: BLOCK, sig_pubkey: sender };
        d.sig = leader.sign(pub._finalizedCanonical(7, txid, matches.length));
        return { pub, envelope: { data: d }, stamped, asked, sender };
    }

    it('REFUSES a null-txid FINALIZED announcing terminal statuses (permanent suppression)', async () => {
        let { pub, envelope, stamped } = finalized(null, 'settled');
        await pub._handleFinalized(envelope);
        expect(stamped.length, 'rows must stay pending and re-archive under a fresh seq').to.equal(0);
    });

    it('still back-fills the HONEST null-txid shape, where every row is __partial__', async () => {
        let { pub, envelope, stamped } = finalized(null, '__partial__');
        await pub._handleFinalized(envelope);
        expect(stamped.length, 'the failed-broadcast announcement must keep working').to.equal(1);
        expect(stamped[0][2], 'no txid is stamped').to.equal(null);
    });

    it('back-fills terminal statuses once the archive head is CONFIRMED on DOGE', async () => {
        let { pub, envelope, stamped, asked } = finalized(TXID, 'settled', 'verified');
        await pub._handleFinalized(envelope);
        expect(stamped.length).to.equal(1);
        expect(stamped[0][1][0].status, 'the announced terminal status lands').to.equal('settled');
        expect(stamped[0][2], 'the confirmed txid is stamped').to.equal(TXID);
        expect(asked[0].expect.rejectVersions, 'the head is checked against the SET {1,6}, not exact v1')
            .to.deep.equal([0, 2, 3, 4, 5]);
    });

    it('stamps ONLY the sentinel seq while the head is unconfirmed, and queues the rest', async () => {
        // The fabricated-txid attack and an honest 0-conf announcement are the same
        // bytes on the wire, so neither may write archived_status = status here.
        let { pub, envelope, stamped } = finalized(TXID, 'settled', 'absent');
        await pub._handleFinalized(envelope);
        expect(stamped.length, 'the seq still advances fleet-wide').to.equal(1);
        expect(stamped[0][1][0].status, 'the suppressing status is NOT written').to.equal('__partial__');
        expect(stamped[0][2], 'no txid is stamped from an unconfirmed head').to.equal(null);
        expect(stamped[0][4], 'reward rows are never staged (their only pending test is batch_seq IS NULL)')
            .to.deep.equal([]);
        expect(pub._deferredFinalized.size, 'queued for re-verification').to.equal(1);
    });

    it('stamps NOTHING and queues nothing when the head is positively rejected on-chain', async () => {
        let { pub, envelope, stamped } = finalized(TXID, 'settled', 'rejected:txid');
        await pub._handleFinalized(envelope);
        expect(stamped.length).to.equal(0);
        expect(pub._deferredFinalized.size).to.equal(0);
    });

    it('the drain stamps the queued announcement once the head buries', async () => {
        let { pub, envelope, stamped } = finalized(TXID, 'settled', 'absent');
        await pub._handleFinalized(envelope);
        expect(stamped.length).to.equal(1);                       // sentinel only

        let onChain = 'verified';
        pub._verifyArchiveCheckpointOnChain = async () => onChain;
        await pub._drainDeferredFinalized();
        expect(stamped.length, 'the confirmed stamp lands from the drain').to.equal(2);
        expect(stamped[1][1][0].status).to.equal('settled');
        expect(stamped[1][2]).to.equal(TXID);
        expect(pub._deferredFinalized.size, 'entry is consumed').to.equal(0);
    });

    it('the drain drops a queued announcement the chain later REJECTS', async () => {
        let { pub, envelope, stamped } = finalized(TXID, 'settled', 'absent');
        await pub._handleFinalized(envelope);
        pub._verifyArchiveCheckpointOnChain = async () => 'rejected:txid';
        await pub._drainDeferredFinalized();
        expect(stamped.length, 'no terminal stamp ever lands').to.equal(1);
        expect(pub._deferredFinalized.size).to.equal(0);
    });
});
