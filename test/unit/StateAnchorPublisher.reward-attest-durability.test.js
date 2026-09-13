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

// Review board #7579: a CONFIRMED reward attestation was discarded before its write
// succeeded, and a committed-but-unstreamed row had no repair.
//
// The drain deleted its pending entry BEFORE awaiting _recordRewardAttestation, and that
// method swallowed both the INSERT and the read-back/broadcast in one try/catch and
// returned normally. A transient INSERT error therefore forfeited a confirmed reward
// permanently while the drain logged 'row written', and an INSERT that committed with a
// failing read-back left a row this hub holds that no mirror subscriber ever receives -
// with no dropAllForResync, so the heartbeat watermark certifies completeness past a row
// that mints COLLECT-spendable validator rewards.
//
// The two halves are now separated. DURABILITY fails closed: the INSERT propagates and
// the drain keeps the entry for its existing TTL-bounded retry (idempotent, INSERT IGNORE
// on uq_reward_tuple). DELIVERY is non-fatal and repaired: a throwing or empty read-back
// forces subscriber resync, exactly as StateCheckpointEngine._broadcastRowOrResync and
// CrossChainCallEngine._mirrorCallRow already do for their own committed rows.

const { expect }           = require('chai');
const sinon                = require('sinon');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const arMod                = require('../../src/anchor_reward_activation.js');

const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 494, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 7, snapshot_block: 100, validator_signatures: '[]', anchor_txid: 'feedbeef',
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};
const TXID   = 'ab'.repeat(32);
const ATTEST = [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }];

// A publisher whose anchor is already proven mined, so every case below turns purely on
// what the DB does. `plan` decides the fate of each attestation INSERT and read-back.
function makePub(plan) {
    plan = plan || {};
    const inserts = [], broadcast = [], resyncs = [];
    let insertAttempt = 0, selectAttempt = 0;
    const db = {
        async doQuery(sql, params) {
            if (sql.indexOf('SELECT * FROM state_checkpoints') === 0) return [Object.assign({}, CP_ROW)];
            if (sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0) {
                insertAttempt++;
                if (plan.insertFailsUntil && insertAttempt < plan.insertFailsUntil)
                    throw new Error('deadlock found when trying to get lock');
                inserts.push(params);
                return { affectedRows: 1 };
            }
            if (sql.indexOf('FROM anchor_reward_attestations') !== -1) {
                selectAttempt++;
                if (plan.readBackThrows) throw new Error('connection lost during read-back');
                if (plan.readBackEmpty)  return [];
                return [{ id: 1, publisher: params[5] }];
            }
            return { affectedRows: 1 };
        }
    };
    const broadcaster = {
        broadcastRow: (ev) => broadcast.push(ev),
        dropAllForResync: (reason) => resyncs.push(reason)
    };
    if (plan.subscribers !== undefined) broadcaster.subscribers = plan.subscribers;
    const pub = new StateAnchorPublisher({ db, getIdentity: () => null, hubDbBroadcaster: broadcaster });
    pub.indexers.DOGE = { url: 'http://doge.indexer.invalid', key: '' };
    pub.dogeConfirmations = 60;
    pub._verifyAnchorOnChain = async () => 'verified';
    const federated = [];
    pub._federateRewardAttestation = (...a) => { federated.push(a); };
    return { pub, inserts, broadcast, resyncs, federated, selects: () => selectAttempt };
}

function entry(extra) {
    return Object.assign({
        chain: CP_ROW.chain, network: CP_ROW.network,
        blockIndex: CP_ROW.block_index, checkpointSeq: CP_ROW.checkpoint_seq,
        txid: TXID, anchorVersion: 0,
        rewardType: 'anchor_bundle', roundReference: CP_ROW.snapshot_block,
        snapshotBlock: CP_ROW.snapshot_block,
        publisher: 'ab'.repeat(32), attestSigs: ATTEST, federate: true
    }, extra || {});
}

describe('StateAnchorPublisher #7579 a confirmed reward survives a transient write failure', () => {

    beforeEach(() => sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true));
    afterEach(() => sinon.restore());

    it('RETAINS the pending entry when the attestation INSERT fails, and retries it next pass', async () => {
        const { pub, inserts, broadcast, federated } = makePub({ insertFailsUntil: 2 });
        pub._deferRewardAttestation(entry());
        expect(pub._deferredRewardAttest.size, 'entry queued').to.equal(1);

        await pub._drainDeferredRewardAttest();                        // DB is sick
        expect(inserts.length, 'nothing was persisted').to.equal(0);
        expect(pub._deferredRewardAttest.size, 'the confirmed reward must not be discarded').to.equal(1);
        expect(federated.length, 'peers must not hear about a row we failed to hold').to.equal(0);
        expect(broadcast.length).to.equal(0);

        await pub._drainDeferredRewardAttest();                        // DB is healthy
        expect(inserts.length, 'the retry writes the row exactly once').to.equal(1);
        expect(broadcast.length, 'and streams it').to.equal(1);
        expect(federated.length, 'and federates it').to.equal(1);
        expect(pub._deferredRewardAttest.size, 'only a successful write clears the entry').to.equal(0);
    });

    it('clears the entry and federates on a clean write (control)', async () => {
        const { pub, inserts, broadcast, federated } = makePub();
        pub._deferRewardAttestation(entry());
        await pub._drainDeferredRewardAttest();
        expect(inserts.length).to.equal(1);
        expect(broadcast.length).to.equal(1);
        expect(federated.length).to.equal(1);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });
});

describe('StateAnchorPublisher #7579 an undeliverable COMMITTED attestation row forces resync', () => {

    beforeEach(() => sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true));
    afterEach(() => sinon.restore());

    it('repairs a read-back that THROWS after the row committed', async () => {
        const { pub, inserts, broadcast, resyncs, federated } = makePub({ readBackThrows: true });
        pub._deferRewardAttestation(entry());
        await pub._drainDeferredRewardAttest();
        expect(inserts.length, 'the row is durable').to.equal(1);
        expect(broadcast.length, 'nothing could be streamed').to.equal(0);
        expect(resyncs.length, 'the mirror gap must be repaired, not left to a reconnect').to.equal(1);
        expect(resyncs[0]).to.contain('anchor_reward_attestations');
        expect(pub._deferredRewardAttest.size, 'a delivery failure does NOT retry the write').to.equal(0);
        expect(federated.length, 'the durable row still federates').to.equal(1);
    });

    it('repairs a read-back that comes back EMPTY after the row committed', async () => {
        const { pub, broadcast, resyncs } = makePub({ readBackEmpty: true });
        pub._deferRewardAttestation(entry());
        await pub._drainDeferredRewardAttest();
        expect(broadcast.length).to.equal(0);
        expect(resyncs.length, 'an empty read-back is the same undeliverable-row event').to.equal(1);
    });

    it('does NOT churn mirrors when there are no subscribers to gap', async () => {
        const { pub, inserts, resyncs, selects } = makePub({ readBackThrows: true, subscribers: new Set() });
        pub._deferRewardAttestation(entry());
        await pub._drainDeferredRewardAttest();
        expect(inserts.length, 'the write still happens').to.equal(1);
        expect(selects(), 'and no read-back is even attempted').to.equal(0);
        expect(resyncs.length, 'dropAllForResync would disconnect nobody').to.equal(0);
    });
});
