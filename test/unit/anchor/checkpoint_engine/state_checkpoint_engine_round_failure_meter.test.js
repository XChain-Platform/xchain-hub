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

// A per-chain checkpoint round that throws after the cadence latch moved must show on
// getcheckpointstats, and a leader's own failed checkpoint write must be retried.

const { expect }            = require('chai');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine');
const ValidatorIdentity     = require('../../../../src/validators/identity');
const { DB_METHODS }        = require('../../../helpers/mockHub.js');

const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

let engines = [];

// In-memory state_checkpoints store; `failInserts` makes the next N checkpoint writes throw.
function memDb() {
    let checkpoints = [];
    let db = { ...DB_METHODS, checkpoints, failInserts: 0,
        async doQuery(sql, params) {
            if (sql.startsWith('SELECT MAX(snapshot_block)')) return [{ last_block: null }];
            if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) {
                if (db.failInserts > 0) { db.failInserts--; throw new Error('ER_LOCK_WAIT_TIMEOUT'); }
                let [chain, network, block_index, block_hash, , , , checkpoint_seq, snapshot_block] = params;
                if (!checkpoints.some(r => r.chain === chain && r.network === network && r.checkpoint_seq === checkpoint_seq))
                    checkpoints.push({ chain, network, block_index, block_hash, checkpoint_seq, snapshot_block });
                return [];
            }
            return [];
        }
    };
    return db;
}

// A single-member federation leading BTC and LTC; `state.down` names chains whose indexer has no tip.
function buildEngine() {
    const identity = new ValidatorIdentity('11'.repeat(32));
    const state = { btcBlock: 100, down: new Set() };
    const validators = [{ pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1' }];
    const db = memDb();
    const hub = {
        db, network: 'regtest',
        p2pConfig: {
            CHECKPOINT_CHAINS: 'BTC,LTC', CHECKPOINT_CONFIRMATIONS: '0', CHECKPOINT_INTERVAL_BLOCKS: '6',
            BTC_INDEXER_URL: 'http://stub', LTC_INDEXER_URL: 'http://stub'
        },
        hubDbBroadcaster: { rows: [], broadcastRow(ev) { this.rows.push(ev); } },
        capabilitySnapshot: {
            async getSnapshot() { return { validators }; },
            async getWeightSnapshot() { return { validators: validators.map(v => ({ pubkey: v.pubkey, source: 'src:' + v.pubkey, weight: v.amount })) }; }
        },
        getPeerManager: () => ({ on() {}, removeListener() {}, broadcast() {} }),
        getIdentity: () => identity,
        resolveBtcLatestBlock: async () => state.btcBlock
    };
    const engine = new StateCheckpointEngine(hub);
    engine.indexerCall = async (chain) => (state.down.has(chain) ? null : Object.assign({}, TIP));
    engines.push(engine);
    return { engine, state, db };
}

describe('StateCheckpointEngine round failure meter', function () {
    afterEach(async function () {
        for (let e of engines) await e.stop();
        engines = [];
    });

    it('names the failing chain and its reason while the latch still advances', async function () {
        const { engine, state, db } = buildEngine();
        state.down.add('LTC');
        await engine.tick();
        const stats = await engine.getStats();
        expect(stats.round_failures).to.equal(1);
        expect(stats.round_failures_by_chain).to.deep.equal({ LTC: 1 });
        expect(stats.last_round_failure_by_chain.LTC.reason).to.match(/no tip block hashes from LTC indexer/);
        expect(stats.last_round_failure_by_chain.LTC.block).to.equal(100);
        expect(stats.last_round_failure_by_chain).to.not.have.property('BTC');
        expect(stats.cadence_stall_reason, 'the cadence-stall meter keeps its meaning').to.equal(null);
        expect(engine._lastCheckpointBtcBlock).to.equal(100);
        expect(db.checkpoints.map(r => r.chain)).to.deep.equal(['BTC']);
    });

    it('keeps the reason through on-schedule ticks and clears it on that chain\'s next good round', async function () {
        const { engine, state } = buildEngine();
        state.down.add('LTC');
        await engine.tick();
        state.btcBlock = 101;
        await engine.tick();
        expect((await engine.getStats()).last_round_failure_by_chain).to.have.property('LTC');
        state.down.delete('LTC');
        state.btcBlock = 106;
        await engine.tick();
        const stats = await engine.getStats();
        expect(stats.last_round_failure_by_chain).to.deep.equal({});
        // The round at 100 and its queued retry on the on-schedule tick at 101 each failed.
        expect(stats.round_failures, 'the count is cumulative').to.equal(2);
        expect(stats.round_failures_by_chain).to.deep.equal({ LTC: 2 });
    });

    it('counts one failure per chain when every chain throws', async function () {
        const { engine, state } = buildEngine();
        state.down.add('BTC');
        state.down.add('LTC');
        await engine.tick();
        expect((await engine.getStats()).round_failures_by_chain).to.deep.equal({ BTC: 1, LTC: 1 });
    });
});

describe('StateCheckpointEngine leader self-accept retry', function () {
    afterEach(async function () {
        for (let e of engines) await e.stop();
        engines = [];
    });

    it('writes a sole-self checkpoint on the next tick after its first write failed', async function () {
        const { engine, state, db } = buildEngine();
        state.down.add('LTC');
        db.failInserts = 1;
        await engine.tick();
        expect(db.checkpoints, 'the first write failed').to.have.lengthOf(0);
        let stats = await engine.getStats();
        expect(stats.self_accept_retries_pending).to.equal(1);
        expect(stats.round_failures_by_chain.BTC, 'the failed round is still metered').to.equal(1);
        state.btcBlock = 101;
        await engine.tick();
        expect(db.checkpoints.map(r => r.snapshot_block), 'the retry wrote the row at its own snapshot block').to.deep.equal([100]);
        stats = await engine.getStats();
        expect(stats.self_accept_retries_pending).to.equal(0);
        expect(stats.self_accept_failures).to.equal(1);
    });

    it('retries a quorum-path accept that failed, instead of only logging it', async function () {
        const { engine } = buildEngine();
        let calls = 0;
        engine.acceptFinalized = async () => { calls++; if (calls === 1) throw new Error('ER_LOCK_WAIT_TIMEOUT'); };
        const cp = { chain: 'BTC', network: 'regtest', block_index: 500, checkpoint_seq: 7, snapshot_block: 100 };
        engine.pending.set(engine.roundId(cp), { id: engine.roundId(cp), cp, quorum: 1, weighted: false,
            signatures: new Map([['aa', 'sig']]), done: false, timer: null, validators: [] });
        engine.checkQuorum(engine.roundId(cp));
        await new Promise(resolve => setImmediate(resolve));
        expect((await engine.getStats()).self_accept_retries_pending).to.equal(1);
        await engine.retryFailedSelfAccepts();
        expect(calls).to.equal(2);
        expect((await engine.getStats()).self_accept_retries_pending).to.equal(0);
    });

    it('gives up after the retry cap and counts the abandoned write', async function () {
        const { engine } = buildEngine();
        engine.acceptFinalized = async () => { throw new Error('ER_LOCK_WAIT_TIMEOUT'); };
        engine.queueSelfAccept({ chain: 'BTC', network: 'regtest', block_index: 500, checkpoint_seq: 7 }, [], 1, new Error('first'));
        for (let i = 0; i < 40; i++) await engine.retryFailedSelfAccepts();
        const stats = await engine.getStats();
        expect(stats.self_accept_retries_pending).to.equal(0);
        expect(stats.self_accepts_abandoned).to.equal(1);
        expect(stats.self_accept_failures).to.equal(31);
    });
});
