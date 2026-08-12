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

// the checkpoint cadence must never fail silently.
//
// Every pre-leadership bail in `_tick` used to be a bare `return`. A hub whose
// oracle_publish capability had gone unqualified therefore produced zero
// checkpoints, zero log lines, and a getcheckpointstats payload that looked
// perfectly healthy (round_timeouts 0). The live mainnet hub sat in exactly that
// state for 18 days: last checkpoint 2026-07-10 at BTC snapshot_block 957439
// against a tip of 960028, because its capability config still carried a
// placeholder DOGE address and the oracle_publish self-test refused to qualify.
// Nothing surfaced it until someone read the state_checkpoints table by hand.
//
// These tests pin the meter: a cadence round that is DUE but cannot be led
// increments cadence_stalls and names the reason, and a round that is simply not
// due (or is successfully led) leaves the meter clean.

const { expect }            = require('chai');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine');
const ValidatorIdentity     = require('../../src/ValidatorIdentity');

const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

describe('StateCheckpointEngine cadence stall meter', function () {

    let engines = [];

    afterEach(async function () {
        for (let e of engines) await e.stop();
        engines = [];
    });

    // Minimal in-memory state_checkpoints + capability_snapshots store (same shape
    // as the cadence-latch suite; unknown SELECTs fall through to []).
    function memDb() {
        let checkpoints = [], snapshots = [];
        return {
            checkpoints, snapshots,
            async doQuery(sql, params) {
                if (sql.startsWith('SELECT MAX(checkpoint_seq)')) {
                    let max = null;
                    for (let r of checkpoints) if (r.chain === params[0] && r.network === params[1] && (max == null || r.checkpoint_seq > max)) max = r.checkpoint_seq;
                    return [{ max_seq: max }];
                }
                if (sql.startsWith('SELECT MAX(snapshot_block)')) {
                    let max = null;
                    for (let r of checkpoints) if (max == null || r.snapshot_block > max) max = r.snapshot_block;
                    return [{ last_block: max }];
                }
                if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) {
                    let [chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash,
                         checkpoint_seq, snapshot_block] = params;
                    if (!checkpoints.some(r => r.chain === chain && r.network === network && r.checkpoint_seq === checkpoint_seq))
                        checkpoints.push({ chain, network, block_index, block_hash, ledger_hash, actions_hash,
                                           contract_hash, checkpoint_seq, snapshot_block });
                    return [];
                }
                if (sql.startsWith('SELECT * FROM state_checkpoints'))
                    return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] &&
                                                   r.block_index === params[2] && r.checkpoint_seq === params[3]).slice(0, 1);
                if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                    snapshots.push({ snapshot_block: params[0], capability: params[1], signing_pubkey: params[2] });
                    return [];
                }
                return [];
            }
        };
    }

    // One engine, single-member federation by default. `state` is mutable so a test
    // can take the validator set away (or hand it back) between ticks.
    function buildEngine(opts) {
        opts = opts || {};
        const identity = new ValidatorIdentity('11'.repeat(32));
        const state = {
            btcBlock: 100,
            validators: opts.validators !== undefined
                ? opts.validators
                : [{ pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1' }]
        };
        const db = memDb();
        const hub = {
            db,
            network: 'regtest',
            p2pConfig: {
                CHECKPOINT_CHAINS: 'BTC', CHECKPOINT_CONFIRMATIONS: '0',
                CHECKPOINT_INTERVAL_BLOCKS: '6', BTC_INDEXER_URL: 'http://stub'
            },
            hubDbBroadcaster: { rows: [], broadcastRow(ev) { this.rows.push(ev); } },
            // Regtest activates stake-weighted quorum at genesis, so the engine takes the
            // weighted path; serve both shapes from the same mutable set.
            capabilitySnapshot: {
                async getSnapshot() { return { validators: state.validators }; },
                async getWeightSnapshot() {
                    return { validators: state.validators.map(v => ({ pubkey: v.pubkey, source: 'src:' + v.pubkey, weight: v.amount })) };
                }
            },
            getPeerManager: () => ({ on() {}, removeListener() {}, broadcast() {} }),
            getIdentity: () => (opts.noIdentity ? null : identity),
            _resolveBtcLatestBlock: async () => state.btcBlock
        };
        const engine = new StateCheckpointEngine(hub);
        engine._indexerCall = async () => (state.btcBlock == null ? null : Object.assign({}, TIP));
        engines.push(engine);
        return { engine, state, db, identity };
    }

    it('a due cadence with no qualified oracle_publish set is metered and named, not silent', async function () {
        const { engine, db } = buildEngine({ validators: [] });
        expect(engine.getStats).to.be.a('function');

        await engine._tick();

        expect(db.checkpoints.length, 'no checkpoint can be produced').to.equal(0);
        const stats = await engine.getStats();
        expect(stats.cadence_stalls, 'the stalled round is counted').to.equal(1);
        expect(stats.cadence_stall_reason, 'the reason names the capability').to.be.a('string');
        expect(stats.cadence_stall_reason).to.match(/oracle_publish/);
        expect(stats.cadence_stall_block, 'the block the round would have used').to.equal(100);

        // Repeat ticks keep counting: this is the 18-day mainnet shape.
        await engine._tick();
        await engine._tick();
        expect((await engine.getStats()).cadence_stalls).to.equal(3);
    });

    it('logs the stall reason once, then throttles while still counting', async function () {
        const { engine } = buildEngine({ validators: [] });
        const seen = [];
        const orig = console.warn;
        console.warn = (m) => seen.push(String(m));
        try {
            await engine._tick();
            await engine._tick();
            await engine._tick();
        } finally { console.warn = orig; }

        const stallLines = seen.filter(l => /cadence STALLED/.test(l));
        expect(stallLines.length, 'throttled to one line per window').to.equal(1);
        expect(stallLines[0]).to.match(/oracle_publish/);
        expect(engine._cadenceStalls, 'every stalled tick is still counted').to.equal(3);
    });

    it('meters a hub that is absent from the oracle_publish set', async function () {
        // A set that exists but does not include us: the hub can never lead, and the
        // pre-fix code returned silently.
        const other = new ValidatorIdentity('22'.repeat(32));
        const { engine } = buildEngine({ validators: [{ pubkey: other.getPubkeyHex().toLowerCase(), amount: '1' }] });

        await engine._tick();

        const stats = await engine.getStats();
        expect(stats.cadence_stalls).to.equal(1);
        expect(stats.cadence_stall_reason).to.match(/not in the oracle_publish validator set/);
    });

    it('meters an unresolvable BTC snapshot block with a null stall block', async function () {
        const { engine, state } = buildEngine();
        state.btcBlock = null;
        engine.hub._resolveBtcLatestBlock = async () => null;

        await engine._tick();

        const stats = await engine.getStats();
        expect(stats.cadence_stalls).to.equal(1);
        expect(stats.cadence_stall_reason).to.match(/snapshot block/);
        expect(stats.cadence_stall_block, 'no block was resolvable').to.equal(null);
    });

    it('a cadence that is merely not due yet is NOT a stall', async function () {
        const { engine, state, db } = buildEngine();

        state.btcBlock = 100;
        await engine._tick();                       // leads the first round
        expect(db.checkpoints.length, 'first round finalizes').to.equal(1);
        expect(engine._lastCheckpointBtcBlock).to.equal(100);

        state.btcBlock = 103;                       // interval is 6, so 103 is inside it
        await engine._tick();

        const stats = await engine.getStats();
        expect(stats.cadence_stalls, 'being inside the interval is normal').to.equal(0);
        expect(stats.cadence_stall_reason).to.equal(null);
    });

    it('clears the stall reason once the validator set comes back', async function () {
        const { engine, state, db } = buildEngine({ validators: [] });
        const identity = engine.identity;

        await engine._tick();
        expect((await engine.getStats()).cadence_stall_reason, 'stalled first').to.be.a('string');

        // Operator fixes the capability config; the snapshot qualifies us again.
        state.validators = [{ pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1' }];
        await engine._tick();

        expect(db.checkpoints.length, 'the round now finalizes').to.equal(1);
        const stats = await engine.getStats();
        expect(stats.cadence_stall_reason, 'reason is cleared, not stale').to.equal(null);
        expect(stats.cadence_stall_block).to.equal(null);
        expect(stats.cadence_stalls, 'the historical count is retained').to.equal(1);
    });
});
