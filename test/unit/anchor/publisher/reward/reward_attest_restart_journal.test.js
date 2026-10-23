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

// A deferred reward attestation survives a hub restart.
//
// The queue holding a reward attestation until its DOGE anchor is buried is journaled
// to consensus_state, and start() restores it. These cases run two real
// StateAnchorPublisher instances over one stored consensus_state, the second being the
// restarted hub, and show the restored entry still passes the confirm-then-write proof:
// written once buried, never written when the proof fails.

const { expect }           = require('chai');
const sinon                = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const arMod                = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const { DB_METHODS }       = require('../../../../helpers/mockHub.js');

const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 494, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 7, snapshot_block: 100, validator_signatures: '[]', anchor_txid: 'feedbeef',
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};
const TXID      = 'ab'.repeat(32);
const PUBLISHER = 'ab'.repeat(32);
const ATTEST    = [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }];
const JOURNAL   = 'xancreward_pending:';

// The hub database both instances share: consensus_state rows persist across the
// restart, and every anchor_reward_attestations INSERT is recorded.
function makeStore() {
    return { state: new Map(), inserts: [] };
}

function journalRows(store) {
    return [...store.state.keys()].filter(k => k.startsWith(JOURNAL));
}

function makeDb(store) {
    return { ...DB_METHODS,
        async doQuery(sql, params) {
            if (sql.startsWith('INSERT INTO consensus_state')) {
                store.state.set(params[0], params[1]);
                return { affectedRows: 1 };
            }
            if (sql.startsWith('SELECT key_name, value FROM consensus_state WHERE key_name LIKE')) {
                const prefix = params[0].replace(/%$/, '').replace(/\\(.)/g, '$1');
                return [...store.state].filter(([k]) => k.startsWith(prefix))
                    .map(([k, v]) => ({ key_name: k, value: v }));
            }
            if (sql.startsWith('DELETE FROM consensus_state')) {
                store.state.delete(params[0]);
                return { affectedRows: 1 };
            }
            if (sql.startsWith('SELECT * FROM state_checkpoints')) return [Object.assign({}, CP_ROW)];
            if (sql.startsWith('INSERT IGNORE INTO anchor_reward_attestations')) {
                store.inserts.push(params);
                return { affectedRows: 1 };
            }
            if (sql.includes('FROM anchor_reward_attestations')) return [{ id: store.inserts.length, publisher: params[5] }];
            return [];
        }
    };
}

// One hub process over the shared store. `chain.depth` is the anchor's DOGE depth and
// `chain.verdict` overrides the mined-anchor proof once the anchor is deep enough.
function startHub(store, chain) {
    const pub = new StateAnchorPublisher({ db: makeDb(store), getIdentity: () => null });
    pub.indexers.DOGE = { url: 'http://doge.indexer.invalid', key: '' };
    pub.dogeConfirmations = 60;
    pub.verifyAnchorOnChain = async () =>
        (chain.depth >= pub.dogeConfirmations ? (chain.verdict || 'verified') : 'shallow');
    pub.indexerCall = async () => ({
        exists: true,
        anchors: [{
            version: 0, status: 'valid', checkpoint_network: CP_ROW.network,
            publisher: PUBLISHER, snapshot_block: CP_ROW.snapshot_block,
            action_index: 0, confirmations: chain.depth
        }],
        truncated: false
    });
    const federated = [];
    pub.federateRewardAttestation = (...a) => { federated.push(a); };
    return { pub, federated };
}

function entry() {
    return {
        chain: CP_ROW.chain, network: CP_ROW.network,
        blockIndex: CP_ROW.block_index, checkpointSeq: CP_ROW.checkpoint_seq,
        txid: TXID, anchorVersion: 0,
        rewardType: 'anchor_bundle', roundReference: CP_ROW.snapshot_block,
        snapshotBlock: CP_ROW.snapshot_block,
        publisher: PUBLISHER, attestSigs: ATTEST, federate: true
    };
}

// Queue the attestation on the first hub and let it drain while the anchor is still
// shallow (6 of 60 confirmations).
async function attestBeforeRestart(store, chain) {
    const before = startHub(store, chain).pub;
    before.deferRewardAttestation(entry());
    await Promise.all(before.rewardJournalWrites().values());
    await before.drainDeferredRewardAttest();
    return before;
}

describe('StateAnchorPublisher: a deferred reward attestation survives a hub restart', () => {

    beforeEach(() => sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true));
    afterEach(() => sinon.restore());

    it('journals the queued attestation and writes nothing while the anchor is shallow', async () => {
        const store = makeStore();
        const before = await attestBeforeRestart(store, { depth: 6 });
        expect(before._deferredRewardAttest.size, 'held in the queue').to.equal(1);
        expect(journalRows(store), 'and in consensus_state').to.have.length(1);
        expect(store.inserts, 'no row before the anchor is buried').to.have.length(0);
    });

    it('restores the attestation on the restarted hub and writes it once the anchor reaches payout depth', async () => {
        const store = makeStore();
        const chain = { depth: 6 };
        const before = await attestBeforeRestart(store, chain);
        const queuedAt = [...before._deferredRewardAttest.values()][0].at;

        const { pub: after, federated } = startHub(store, chain);
        expect(after._deferredRewardAttest.size, 'a fresh process starts empty').to.equal(0);
        expect(await after.restoreDeferredRewardAttest(), 'the boot restore reads the journal').to.equal(true);
        expect(after._deferredRewardAttest.size, 'the interrupted attestation is back').to.equal(1);
        expect([...after._deferredRewardAttest.values()][0].at, 'its TTL still counts from the first queueing')
            .to.equal(queuedAt);

        chain.depth = 60;
        await after.drainDeferredRewardAttest();
        expect(store.inserts, 'the reward is attested exactly once').to.have.length(1);
        const [rowChain, network, rewardType, roundRef, snapshot, publisher, , sigsJson, txid] = store.inserts[0];
        expect([rowChain, network, rewardType, roundRef, snapshot, publisher, txid])
            .to.deep.equal(['DOGE', 'regtest', 'anchor_bundle', 100, 100, PUBLISHER, TXID]);
        expect(JSON.parse(sigsJson), 'with the XANCPUB quorum from before the restart').to.deep.equal(ATTEST);
        expect(federated, 'and fanned out to peers').to.have.length(1);
        expect(after._deferredRewardAttest.size, 'the settled entry leaves the queue').to.equal(0);
        expect(journalRows(store), 'and the journal').to.have.length(0);
    });

});

describe('StateAnchorPublisher: a restored reward attestation still needs its anchor proof', () => {

    beforeEach(() => sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true));
    afterEach(() => sinon.restore());

    it('writes nothing for a restored attestation whose anchor fails re-verification', async () => {
        const store = makeStore();
        const chain = { depth: 6 };
        await attestBeforeRestart(store, chain);

        const { pub: after, federated } = startHub(store, chain);
        await after.restoreDeferredRewardAttest();
        chain.depth = 60;
        chain.verdict = 'rejected:mismatch';
        await after.drainDeferredRewardAttest();
        expect(store.inserts, 'a rejected anchor earns no row').to.have.length(0);
        expect(federated).to.have.length(0);
        expect(after._deferredRewardAttest.size, 'the entry is dropped').to.equal(0);
        expect(journalRows(store), 'and is not restored again').to.have.length(0);
    });

    it('expires a restored attestation past its TTL without writing it', async () => {
        const store = makeStore();
        const chain = { depth: 6 };
        const before = await attestBeforeRestart(store, chain);
        const ttl = before.announceRetryTtlMs;

        const { pub: after } = startHub(store, chain);
        const pastTtl = Date.now() + ttl + 1000;
        sinon.stub(Date, 'now').returns(pastTtl);
        chain.depth = 60;
        await after.drainDeferredRewardAttest();   // restores on its first pass when start() did not
        expect(store.inserts, 'an abandoned anchor earns no row').to.have.length(0);
        expect(after._deferredRewardAttest.size).to.equal(0);
        expect(journalRows(store)).to.have.length(0);
    });

    it('settles an attestation in the same process without leaving a journal row (no restart)', async () => {
        const store = makeStore();
        const chain = { depth: 60 };
        const { pub } = startHub(store, chain);
        pub.deferRewardAttestation(entry());
        await pub.drainDeferredRewardAttest();
        expect(store.inserts).to.have.length(1);
        expect(journalRows(store), 'the delete waits for the journal write').to.have.length(0);
    });
});
