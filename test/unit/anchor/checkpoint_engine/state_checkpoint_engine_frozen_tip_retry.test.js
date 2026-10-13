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

// A chain checkpoint round that times out below quorum is re-led at the SAME snapshot
// block. The cadence latch advances when a round opens, so on a frozen BTC tip the next
// interval never arrives and, without a retry, the chain is never checkpointed and the
// bridge legs held behind it never release.

const { expect }            = require('chai');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine');
const ValidatorIdentity     = require('../../../../src/validators/identity');
const { DB_METHODS }        = require('../../../helpers/mockHub.js');
const { waitUntil }         = require('../../../helpers/waitUntil.js');

const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

let engines = [];

function memDb() {
    let checkpoints = [];
    return { ...DB_METHODS,
        checkpoints,
        async doQuery(sql, params) {
            if (sql.startsWith('SELECT MAX(checkpoint_seq)')) return [{ max_seq: null }];
            if (sql.startsWith('SELECT MAX(snapshot_block)')) return [{ last_block: null }];
            if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) {
                let [chain, network, block_index, block_hash, , , , checkpoint_seq, snapshot_block] = params;
                if (!checkpoints.some(r => r.chain === chain && r.checkpoint_seq === checkpoint_seq))
                    checkpoints.push({ chain, network, block_index, block_hash, checkpoint_seq, snapshot_block });
                return [];
            }
            if (sql.startsWith('SELECT * FROM state_checkpoints'))
                return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] &&
                                               r.block_index === params[2] && r.checkpoint_seq === params[3]).slice(0, 1);
            return [];
        }
    };
}

// Two-member federation so a round needs the peer's signature. The snapshot block is
// chosen so this hub holds the cadence slot.
function buildEngine() {
    const me    = new ValidatorIdentity('11'.repeat(32));
    const peer  = new ValidatorIdentity('22'.repeat(32));
    const keys  = [me, peer].map(i => i.getPubkeyHex().toLowerCase());
    const rank  = [...keys].sort().indexOf(keys[0]);
    const state = { btcBlock: 100 + rank, tipIndex: TIP.block_index };
    const db    = memDb();
    const sent  = [];
    const hub = {
        db, network: 'regtest',
        p2pConfig: {
            CHECKPOINT_CHAINS: 'BTC', CHECKPOINT_CONFIRMATIONS: '0',
            CHECKPOINT_INTERVAL_BLOCKS: '6', BTC_INDEXER_URL: 'http://stub'
        },
        hubDbBroadcaster: { broadcastRow() {} },
        capabilitySnapshot: {
            async getSnapshot() { return { validators: keys.map(pubkey => ({ pubkey, amount: '1' })) }; },
            async getWeightSnapshot() {
                return { validators: keys.map(pubkey => ({ pubkey, source: 'src:' + pubkey, weight: '1' })) };
            }
        },
        getPeerManager: () => ({ on() {}, removeListener() {}, broadcast(type) { sent.push(type); } }),
        getIdentity: () => me,
        resolveBtcLatestBlock: async () => state.btcBlock
    };
    const engine = new StateCheckpointEngine(hub);
    engine.roundTimeoutMs = 20;
    engine.indexerCall = async () => Object.assign({}, TIP, { block_index: state.tipIndex });
    engines.push(engine);
    return { engine, state, db, peer };
}

function peerSign(engine, peer) {
    const [id, pending] = [...engine.pending][0];
    engine.handleSign({ data: { id, sig_pubkey: peer.getPubkeyHex(), sig: peer.sign(pending.canonical) } });
}

describe('StateCheckpointEngine frozen-tip round retry', function () {
    afterEach(async function () {
        for (let e of engines) await e.stop();
        engines = [];
    });

    it('re-leads a timed-out round at the same snapshot block and finalizes it', async function () {
        const { engine, state, db, peer } = buildEngine();

        await engine.tick();
        expect(engine.pending.size, 'round open awaiting the peer').to.equal(1);
        await waitUntil(() => engine._roundTimeouts === 1, { label: 'round timeout' });
        expect(db.checkpoints.length).to.equal(0);

        // The tip is frozen: same block, latch already advanced, not due.
        await engine.tick();
        expect(engine.pending.size, 'the same round is re-opened').to.equal(1);
        expect([...engine.pending.values()][0].cp.snapshot_block).to.equal(state.btcBlock);

        peerSign(engine, peer);
        await waitUntil(() => db.checkpoints.length === 1, { label: 'checkpoint stored' });
        expect(db.checkpoints[0].snapshot_block).to.equal(state.btcBlock);
    });

    it('stops retrying after the retry cap', async function () {
        const { engine } = buildEngine();
        await engine.tick();
        for (let n = 1; n <= 4; n++) {
            await waitUntil(() => engine._roundTimeouts === n, { label: 'timeout ' + n });
            await engine.tick();
        }
        expect(engine.pending.size, 'no fifth round: 1 original + 3 retries').to.equal(0);
        expect(engine._roundTimeouts).to.equal(4);
    });

    it('does not re-lead when the chain tip moved off the timed-out block', async function () {
        const { engine, state } = buildEngine();
        await engine.tick();
        await waitUntil(() => engine._roundTimeouts === 1, { label: 'round timeout' });
        state.tipIndex = TIP.block_index + 1;

        await engine.tick();

        expect(engine.pending.size, 'a different payload at the sequence is never proposed').to.equal(0);
        expect(engine._seqDoubleSignRefusals).to.equal(0);
    });

    it('does not retry a round that finalized', async function () {
        const { engine, db, peer } = buildEngine();
        await engine.tick();
        peerSign(engine, peer);
        await waitUntil(() => db.checkpoints.length === 1, { label: 'checkpoint stored' });

        await engine.tick();

        expect(engine.pending.size).to.equal(0);
        expect(engine._roundTimeouts).to.equal(0);
    });
});
