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

// (flag-day Pkg 8) residual hub-side checkpoint/anchor signing legs:
//   - item 687: the publisher-attestation rounds must ABSTAIN on an unresolved
//     (empty) oracle_publish set instead of self-attesting a 1-of-N quorum the
//     chain rejects while this hub banks the anchor reward.
//   - item 933: the archive wrapper checkpoint must be selected on the CONSENSUS
//     key, never on the per-hub AUTO_INCREMENT `id`, because that row feeds the
//     archive election key which is required to be identical on every hub.
//   - item 931: the follower co-sign gate must resolve membership through the
//     same flag-day-aware snapshot as the leader quorum and the on-chain verifier.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const swq                  = require('../../src/stake_weighted_quorum');

const CP = {
    chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 100, snapshot_block: 100
};

function buildPub(opts) {
    opts = opts || {};
    let identity = opts.identity !== undefined ? opts.identity : new ValidatorIdentity('11'.repeat(32));
    let hub = {
        db: { queries: [], async doQuery(sql, params) {
            this.queries.push({ sql, params });
            return opts.doQuery ? await opts.doQuery(sql, params) : [];
        } },
        network: opts.network !== undefined ? opts.network : 'regtest',
        capabilitySnapshot: opts.capabilitySnapshot || null,
        capabilityRegistry: opts.capabilityRegistry || null,
        getIdentity: () => identity,
        getPeerManager: () => (opts.peerManager !== undefined ? opts.peerManager : { broadcast() {} }),
        p2pConfig: opts.p2pConfig || {},
        _resolveBtcLatestBlock: async () => 100
    };
    let pub = new StateAnchorPublisher(hub);
    return { pub, hub, identity };
}

describe('StateAnchorPublisher publisher-attestation abstains on an unresolved set', () => {

    it('v4/v5 round: an EMPTY oracle_publish set abstains instead of self-attesting', async () => {
        let { pub } = buildPub();
        pub._resolveCapabilitySet = async () => [];               // resolver divergence: unresolved at snapshot_block
        let r = await pub._runPublisherAttestationRound(CP, 'D'.repeat(34));
        expect(r.met, 'must not claim quorum off an unresolved set').to.equal(false);
        expect(r.sigs).to.deep.equal([]);
        expect(r.publisher, 'no publisher is attested').to.equal(undefined);
    });

    it('v4/v5 round: a GENUINE single-member set containing us still self-signs', async () => {
        let { pub, identity } = buildPub();
        let me = identity.getPubkeyHex().toLowerCase();
        pub._resolveCapabilitySet = async () => [{ pubkey: me, amount: '1', source: '' }];
        let r = await pub._runPublisherAttestationRound(CP, 'D'.repeat(34));
        expect(r.met).to.equal(true);
        expect(r.sigs.length).to.equal(1);
        expect(r.sigs[0].pubkey).to.equal(me);
    });

    it('v4/v5 round: a single-member set that is NOT us still abstains', async () => {
        let { pub } = buildPub();
        pub._resolveCapabilitySet = async () => [{ pubkey: 'ab'.repeat(33), amount: '1', source: '' }];
        let r = await pub._runPublisherAttestationRound(CP, 'D'.repeat(34));
        expect(r.met).to.equal(false);
    });

    it('v6 archive round: an EMPTY oracle_publish set abstains instead of self-attesting', async () => {
        let { pub } = buildPub();
        pub._resolveCapabilitySet = async () => [];
        let r = await pub._runArchiveAttestationRound(CP, 7, 'D'.repeat(34));
        expect(r.met).to.equal(false);
        expect(r.sigs).to.deep.equal([]);
    });

    it('v6 archive round: a genuine single-member set containing us still self-signs', async () => {
        let { pub, identity } = buildPub();
        let me = identity.getPubkeyHex().toLowerCase();
        pub._resolveCapabilitySet = async () => [{ pubkey: me, amount: '1', source: '' }];
        let r = await pub._runArchiveAttestationRound(CP, 7, 'D'.repeat(34));
        expect(r.met).to.equal(true);
        expect(r.sigs.length).to.equal(1);
    });
});

describe('StateAnchorPublisher archive wrapper is picked on the consensus key', () => {

    // Two checkpoints whose hub-local insertion order (id) DISAGREES with the
    // consensus order (checkpoint_seq): the later-inserted row is the OLDER
    // round, exactly what happens on a hub that back-fills a missed FINALIZED.
    const ROWS = [
        { id: 1, chain: 'BTC', network: 'regtest', block_index: 520, block_hash: 'c0'.repeat(32),
          ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
          checkpoint_seq: 106, snapshot_block: 106 },
        { id: 2, chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c1'.repeat(32),
          ledger_hash: 'a2'.repeat(32), actions_hash: 'b3'.repeat(32), contract_hash: 'c4'.repeat(32),
          checkpoint_seq: 100, snapshot_block: 100 }
    ];

    // Order the fixture rows the way the SQL asks, so the assertion tests the
    // ORDER BY the code actually emits rather than a hard-coded string.
    function orderRows(sql) {
        let clause = sql.split('ORDER BY')[1] || '';
        let terms = clause.replace(/LIMIT.*$/i, '').split(',').map(s => s.trim()).filter(Boolean);
        let rows = ROWS.slice();
        rows.sort((a, b) => {
            for (let t of terms) {
                let desc = /DESC\s*$/i.test(t);
                let key  = t.replace(/\s+(ASC|DESC)\s*$/i, '').trim();
                let va, vb;
                if (key === "(chain = 'BTC')") { va = a.chain === 'BTC' ? 1 : 0; vb = b.chain === 'BTC' ? 1 : 0; }
                else if (key === 'id' || key in a) { va = a[key]; vb = b[key]; }
                else continue;
                if (va !== vb) return desc ? (vb - va) : (va - vb);
            }
            return 0;
        });
        return rows;
    }

    it('selects the highest checkpoint_seq, not the highest AUTO_INCREMENT id', async () => {
        let identity = new ValidatorIdentity('11'.repeat(32));
        let me = identity.getPubkeyHex().toLowerCase();
        let { pub } = buildPub({
            identity,
            async doQuery(sql) {
                if (sql.startsWith('SELECT * FROM cross_chain_matches')) return [];
                if (sql.startsWith('SELECT * FROM cross_chain_calls'))   return [];
                if (sql.startsWith('SELECT * FROM validator_rewards'))
                    return [{ reward_type: 'anchor_BTC', round_number: 1, validator_pubkey: me,
                              block_index: 100, batch_seq: null, amount: '1' }];
                if (sql.startsWith('SELECT * FROM state_checkpoints')) return orderRows(sql).slice(0, 1);
                return [];
            }
        });
        pub._getActiveOraclePublishPubkeys = async () => [me];
        pub._getNextBatchSeq = async () => 3;

        let captured = null;
        pub._archiveElectionKey = (cp, batchSeq) => { captured = cp; return 'k|' + batchSeq; };
        pub._rankUnlocked = () => false;                 // bail right after the wrapper pick

        let r = await pub._startArchiveRound({}, 100);
        expect(r).to.equal('none');
        expect(captured, 'wrapper checkpoint was selected').to.not.equal(null);
        expect(captured.checkpoint_seq, 'consensus-newest row, though it has the LOWER id').to.equal(106);
        expect(captured.block_index).to.equal(520);
    });

    it('never orders the wrapper pick on the hub-local id cursor', async () => {
        let identity = new ValidatorIdentity('11'.repeat(32));
        let me = identity.getPubkeyHex().toLowerCase();
        let seen = [];
        let { pub } = buildPub({
            identity,
            async doQuery(sql) {
                if (sql.startsWith('SELECT * FROM state_checkpoints')) { seen.push(sql); return orderRows(sql).slice(0, 1); }
                if (sql.startsWith('SELECT * FROM validator_rewards'))
                    return [{ reward_type: 'anchor_BTC', round_number: 1, validator_pubkey: me,
                              block_index: 100, batch_seq: null, amount: '1' }];
                return [];
            }
        });
        pub._getActiveOraclePublishPubkeys = async () => [me];
        pub._getNextBatchSeq = async () => 3;
        pub._rankUnlocked = () => false;

        await pub._startArchiveRound({}, 100);
        expect(seen.length).to.be.at.least(1);
        for (let sql of seen) {
            expect(sql, 'wrapper pick must not key on the per-hub insertion cursor').to.not.match(/ORDER BY[^;]*\bid\s+DESC/i);
            expect(sql).to.match(/checkpoint_seq DESC/);
        }
    });
});

describe('StateAnchorPublisher follower co-sign gate follows the flag-day', () => {

    function snapshotHub(calls) {
        return {
            async getSnapshot(cap, block) { calls.push(['count', cap, block]); return { validators: [{ pubkey: 'aa'.repeat(33) }] }; },
            async getWeightSnapshot(cap, block) {
                calls.push(['weight', cap, block]);
                // Weighted snapshots carry one row per (source, pubkey): the same key
                // delegated by two sources must collapse to one member.
                return { validators: [{ pubkey: 'bb'.repeat(33), source: 's1', weight: '1' },
                                      { pubkey: 'bb'.repeat(33), source: 's2', weight: '2' },
                                      { pubkey: 'cc'.repeat(33), source: 's3', weight: '3' }] };
            }
        };
    }

    it('above STAKE_WEIGHTED_QUORUM it reads the WEIGHT snapshot (the set the indexer verifies against)', async () => {
        let calls = [];
        let { pub } = buildPub({ network: 'regtest', capabilitySnapshot: snapshotHub(calls) });
        expect(swq.isStakeWeightedQuorumActive(100, 'regtest'), 'regtest activates at 0').to.equal(true);

        let set = await pub._getActiveOraclePublishPubkeys(100);
        expect(calls.map(c => c[0])).to.deep.equal(['weight']);
        expect(set, 'deduped to distinct pubkeys, sorted').to.deep.equal(['bb'.repeat(33), 'cc'.repeat(33)]);
    });

    it('below the flag-day it still reads the COUNT snapshot (legacy path unchanged)', async () => {
        let calls = [];
        let { pub } = buildPub({ network: 'mainnet', capabilitySnapshot: snapshotHub(calls) });
        expect(swq.isStakeWeightedQuorumActive(100, 'mainnet'), 'mainnet is unarmed at block 100').to.equal(false);

        let set = await pub._getActiveOraclePublishPubkeys(100);
        expect(calls.map(c => c[0])).to.deep.equal(['count']);
        expect(set).to.deep.equal(['aa'.repeat(33)]);
    });

    it('an unknown deployment network resolves the gate OFF, keeping the pre-fix count path', async () => {
        let calls = [];
        let { pub } = buildPub({ network: '', capabilitySnapshot: snapshotHub(calls) });
        let set = await pub._getActiveOraclePublishPubkeys(100);
        expect(calls.map(c => c[0])).to.deep.equal(['count']);
        expect(set).to.deep.equal(['aa'.repeat(33)]);
    });

    it('still fails closed to an empty set when the pinned snapshot throws', async () => {
        let { pub } = buildPub({
            network: 'regtest',
            capabilitySnapshot: { async getSnapshot() { throw new Error('indexer down'); },
                                  async getWeightSnapshot() { throw new Error('indexer down'); } }
        });
        expect(await pub._getActiveOraclePublishPubkeys(100)).to.deep.equal([]);
    });

    it('the UNPINNED (blockIndex null) membership pre-filter is untouched by the flag-day', async () => {
        let calls = [];
        let { pub } = buildPub({
            network: 'regtest',
            capabilitySnapshot: snapshotHub(calls),
            capabilityRegistry: { async getActiveValidators() { return ['DD'.repeat(33)]; } }
        });
        let set = await pub._getActiveOraclePublishPubkeys(null);
        expect(calls, 'no pinned snapshot read at all').to.deep.equal([]);
        expect(set).to.deep.equal(['dd'.repeat(33)]);
    });
});

// The publisher broadcasts XANC_V0_DONE the instant the DOGE
// broadcast returns a txid (0 confirmations), while the receiver only stamps at
// dogeConfirmations depth (60 on DOGE, ~1h). Because the announcement is one-shot,
// every peer used to answer 'absent' and drop it, so anchor_txid stayed NULL forever
// and the duplicate-anchor suppression that the `anchor_txid IS NULL` selector exists
// for could never engage: each hub re-anchored (real DOGE) as its rank unlocked.
describe('StateAnchorPublisher defers a not-yet-buried V0_DONE instead of dropping it', () => {

    // A receiver whose on-chain verdict is scripted, with the DB reduced to the two
    // statements the V0_DONE path touches.
    function buildReceiver(opts) {
        opts = opts || {};
        let identity = new ValidatorIdentity('11'.repeat(32));
        let me = identity.getPubkeyHex().toLowerCase();
        let row = { chain: 'BTC', network: 'regtest', block_index: 494, checkpoint_seq: 7,
                    snapshot_block: 100, anchor_txid: null,
                    block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
                    actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32) };
        let updates = [];
        let { pub } = buildPub({
            identity,
            async doQuery(sql, params) {
                if (sql.startsWith('SELECT * FROM state_checkpoints')) return [Object.assign({}, row)];
                if (sql.startsWith('UPDATE state_checkpoints SET anchor_txid')) {
                    updates.push(params);
                    if (row.anchor_txid == null) row.anchor_txid = params[0];
                    return [];
                }
                return [];
            }
        });
        pub._getActiveOraclePublishPubkeys = async () => [me];    // sole member => rank 0, unlocked
        pub._recordReward = () => {};                             // isolate the stamp assertion
        pub.verdict = opts.verdict || 'absent';
        pub._verifyAnchorOnChain = async () => pub.verdict;

        let d = { chain: 'BTC', network: 'regtest', block_index: 494, checkpoint_seq: 7, txid: 'aa'.repeat(32) };
        d.sig_pubkey = me;
        d.sig = identity.sign(pub._v0DoneCanonical(d, d.txid));
        return { pub, d, me, row, updates, envelope: { type: 'XANC_V0_DONE', sender: me, data: d } };
    }

    it('queues a mempool-age announcement, then stamps it once the anchor confirms', async () => {
        let r = buildReceiver({ verdict: 'absent' });

        await r.pub._handleV0Done(r.envelope);
        expect(r.updates.length, 'nothing stamped off an unconfirmed anchor').to.equal(0);
        expect(r.pub._deferredV0Done.size, 'announcement retained for re-verification').to.equal(1);

        // Still not buried: the drain leaves it queued and stamps nothing.
        r.pub.verdict = 'shallow';
        await r.pub._drainDeferredV0Done();
        expect(r.updates.length).to.equal(0);
        expect(r.pub._deferredV0Done.size).to.equal(1);

        // 60 confirmations later.
        r.pub.verdict = 'verified';
        await r.pub._drainDeferredV0Done();
        expect(r.updates.length, 'stamped once buried').to.equal(1);
        expect(r.updates[0][0]).to.equal(r.d.txid);
        expect(r.updates[0][4], 'keyed on checkpoint_seq').to.equal(7);
        expect(r.pub._deferredV0Done.size, 'queue drained').to.equal(0);
    });

    it('an already-buried announcement still stamps immediately, without queuing', async () => {
        let r = buildReceiver({ verdict: 'verified' });
        await r.pub._handleV0Done(r.envelope);
        expect(r.updates.length).to.equal(1);
        expect(r.pub._deferredV0Done.size).to.equal(0);
    });

    it('a positively-detected forge is dropped, never queued', async () => {
        for (let verdict of ['rejected:mismatch', 'rejected:txid', 'rejected:version', 'rejected:status']) {
            let r = buildReceiver({ verdict });
            await r.pub._handleV0Done(r.envelope);
            expect(r.updates.length, verdict).to.equal(0);
            expect(r.pub._deferredV0Done.size, verdict + ' must not be retried').to.equal(0);
        }
    });

    it('a queued announcement that never confirms expires, so the failover ladder can re-anchor', async () => {
        let r = buildReceiver({ verdict: 'absent' });
        r.pub.announceRetryTtlMs = -1;                      // already past its TTL on the next drain
        await r.pub._handleV0Done(r.envelope);
        expect(r.pub._deferredV0Done.size).to.equal(1);

        r.pub.verdict = 'verified';                          // even a late confirm cannot resurrect it
        await r.pub._drainDeferredV0Done();
        expect(r.pub._deferredV0Done.size, 'expired entry dropped').to.equal(0);
        expect(r.updates.length, 'nothing stamped from an expired entry').to.equal(0);
    });

    it('drops the queued entry (without a second stamp) once the row is already anchored', async () => {
        let r = buildReceiver({ verdict: 'absent' });
        await r.pub._handleV0Done(r.envelope);
        r.row.anchor_txid = 'bb'.repeat(32);                 // our own publish stamped it meanwhile
        r.pub.verdict = 'verified';
        await r.pub._drainDeferredV0Done();
        expect(r.updates.length, 'no redundant UPDATE').to.equal(0);
        expect(r.pub._deferredV0Done.size).to.equal(0);
    });

    it('the queue is bounded: a flood evicts the oldest entry, never grows without limit', async () => {
        let r = buildReceiver({ verdict: 'absent' });
        r.pub.announceQueueMax = 3;
        for (let seq = 1; seq <= 10; seq++)
            r.pub._deferV0Done({ chain: 'BTC', network: 'regtest', block_index: 400 + seq, checkpoint_seq: seq, txid: 'cc'.repeat(32) }, r.me, 'absent');
        expect(r.pub._deferredV0Done.size).to.equal(3);
        expect([...r.pub._deferredV0Done.keys()].some(k => k.includes('|8|')), 'newest kept').to.equal(true);
        expect([...r.pub._deferredV0Done.keys()].some(k => k.includes('|1|')), 'oldest evicted').to.equal(false);
    });

    it('a duplicate announcement for the same txid does not double-queue', async () => {
        let r = buildReceiver({ verdict: 'absent' });
        await r.pub._handleV0Done(r.envelope);
        await r.pub._handleV0Done(r.envelope);
        expect(r.pub._deferredV0Done.size).to.equal(1);
    });

    it('flush drains the queue before the failover-rank re-anchor decision', async () => {
        let r = buildReceiver({ verdict: 'verified' });
        r.pub._deferV0Done(r.d, r.me, 'absent');
        r.pub._publishPendingCheckpoints = async () => [];   // isolate flush from the publish pipeline
        r.pub._startArchiveRound        = async () => 'none';
        await r.pub.flush();
        expect(r.updates.length, 'queued announcement applied during flush').to.equal(1);
        expect(r.pub._deferredV0Done.size).to.equal(0);
    });
});
