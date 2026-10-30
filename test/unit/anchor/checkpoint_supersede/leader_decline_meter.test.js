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

// A round this hub leads that its own proposal check refuses must show on getcheckpointstats
// and must not clear that chain's failure entry; decline log lines keep leader and co-sign apart.

const { expect }            = require('chai');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine');
const ValidatorIdentity     = require('../../../../src/validators/identity');
const canonicalForms        = require('../../../../src/anchor/checkpoint_engine/canonical_forms.js');
const { DB_METHODS }        = require('../../../helpers/mockHub.js');

const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};
const REPLAYING = { replay: { state: 'replaying' } };

let engines = [];

// In-memory state_checkpoints store that records each checkpoint write.
function memDb() {
    let checkpoints = [];
    return { ...DB_METHODS, checkpoints,
        async doQuery(sql, params) {
            if (sql.startsWith('SELECT MAX(snapshot_block)')) return [{ last_block: null }];
            if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) checkpoints.push({ chain: params[0] });
            return [];
        }
    };
}

// A single-member federation leading BTC and LTC. `state.replaying` chains read an open replay
// after the tip-level hold passed (the race); `state.down` chains serve no tip.
function buildEngine() {
    const identity = new ValidatorIdentity('11'.repeat(32));
    const state = { btcBlock: 100, replaying: new Set(), down: new Set() };
    const validators = [{ pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1' }];
    const db = memDb();
    const hub = {
        db, network: 'regtest',
        p2pConfig: {
            CHECKPOINT_CHAINS: 'BTC,LTC', CHECKPOINT_CONFIRMATIONS: '0', CHECKPOINT_INTERVAL_BLOCKS: '6',
            BTC_INDEXER_URL: 'http://stub', LTC_INDEXER_URL: 'http://stub'
        },
        hubDbBroadcaster: { broadcastRow() {} },
        capabilitySnapshot: {
            async getSnapshot() { return { validators }; },
            async getWeightSnapshot() { return { validators: validators.map(v => ({ pubkey: v.pubkey, source: 'src:' + v.pubkey, weight: v.amount })) }; }
        },
        getPeerManager: () => ({ on() {}, removeListener() {}, broadcast() {} }),
        getIdentity: () => identity,
        resolveBtcLatestBlock: async () => state.btcBlock
    };
    const engine = new StateCheckpointEngine(hub);
    engine.leaderReplayHeld = async () => false;
    engine.indexerCall = async (chain) => {
        if (state.down.has(chain)) return null;
        return Object.assign({}, TIP, state.replaying.has(chain) ? { rules: REPLAYING } : {});
    };
    engines.push(engine);
    return { engine, state, db };
}

// Run fn with console.warn captured, returning the warn lines it produced.
async function warnsDuring(fn) {
    let seen = [], orig = console.warn;
    console.warn = (m) => seen.push(String(m));
    try { await fn(); } finally { console.warn = orig; }
    return seen;
}

function checkpointAt(snapshotBlock) {
    return Object.assign({ chain: 'BTC', snapshot_block: snapshotBlock,
        checkpoint_seq: canonicalForms.deriveCheckpointSeq(snapshotBlock) }, TIP);
}

function registerLeaderAndCosignDeclineTest() {
    it('logs a leader and a co-sign decline of one seq apart, each with its own count', async function () {
        const { engine } = buildEngine();
        const cp = checkpointAt(100);
        const lines = await warnsDuring(() => {
            engine.noteCosignDecline('indexer_replaying', cp);
            engine.noteCosignDecline('indexer_replaying', cp);
            engine.noteCosignDecline('indexer_replaying', cp);
            engine.noteLeaderDecline('indexer_replaying', cp);
            engine.noteLeaderDecline('indexer_replaying', cp);
        });
        const cosign = lines.filter(l => /declining to co-sign/.test(l));
        const leader = lines.filter(l => /declining to open leader round/.test(l));
        expect(cosign, 'one co-sign line for the seq').to.have.lengthOf(1);
        expect(leader, 'one leader line for the seq').to.have.lengthOf(1);
        expect(leader[0]).to.include('declines for this reason so far: 1)');
        expect(engine._cosignDeclines.indexer_replaying).to.equal(3);
        expect(engine._leaderDeclines.indexer_replaying).to.equal(2);
    });
}

describe('StateCheckpointEngine leader proposal declines', function () {
    afterEach(async function () {
        for (let e of engines) await e.stop();
        engines = [];
    });

    it('counts a declined led round per reason and names it for that chain', async function () {
        const { engine, state, db } = buildEngine();
        const fresh = await engine.getStats();
        expect(fresh.leader_declines_total).to.equal(0);
        expect(Object.values(fresh.leader_declines).every(n => n === 0)).to.equal(true);
        state.replaying.add('LTC');
        await warnsDuring(() => engine.tick());
        const stats = await engine.getStats();
        expect(stats.leader_declines.indexer_replaying).to.equal(1);
        expect(stats.leader_declines_total).to.equal(1);
        expect(stats.last_leader_decline_by_chain.LTC.reason).to.equal('indexer_replaying');
        expect(stats.last_leader_decline_by_chain.LTC.block).to.equal(100);
        expect(stats.last_leader_decline_by_chain).to.not.have.property('BTC');
        expect(Object.values(stats.cosign_declines).every(n => n === 0), 'the co-sign meter is untouched').to.equal(true);
        expect(db.checkpoints.map(r => r.chain), 'the undeclined chain still checkpoints').to.deep.equal(['BTC']);
    });

    it('keeps the chain failure entry through a declined retry and clears both on a passing round', async function () {
        const { engine, state } = buildEngine();
        state.down.add('LTC');
        await warnsDuring(() => engine.tick());
        expect((await engine.getStats()).last_round_failure_by_chain).to.have.property('LTC');
        state.down.delete('LTC');
        state.replaying.add('LTC');
        state.btcBlock = 101;
        await warnsDuring(() => engine.tick());
        let stats = await engine.getStats();
        expect(stats.leader_declines.indexer_replaying, 'the retry was led and declined').to.equal(1);
        expect(stats.last_round_failure_by_chain, 'a declined round is not a good round').to.have.property('LTC');
        expect(stats.last_leader_decline_by_chain.LTC.reason).to.equal('indexer_replaying');
        state.replaying.delete('LTC');
        state.btcBlock = 106;
        await warnsDuring(() => engine.tick());
        stats = await engine.getStats();
        expect(stats.last_round_failure_by_chain).to.deep.equal({});
        expect(stats.last_leader_decline_by_chain).to.deep.equal({});
    });

    registerLeaderAndCosignDeclineTest();
});

describe('StateCheckpointEngine pre-authentication co-sign decline log', function () {
    afterEach(async function () {
        for (let e of engines) await e.stop();
        engines = [];
    });

    it('logs once per reason per window while the sender varies the seq', async function () {
        const { engine } = buildEngine();
        const lines = await warnsDuring(() => {
            for (let snap = 1000; snap < 1050; snap++) {
                engine.noteCosignDecline('own_tip_unresolved', checkpointAt(snap));
                engine.noteCosignDecline('snapshot_out_of_tolerance', checkpointAt(snap), 'proposed ' + snap);
            }
        });
        expect(lines.filter(l => /own_tip_unresolved/.test(l))).to.have.lengthOf(1);
        expect(lines.filter(l => /snapshot_out_of_tolerance/.test(l))).to.have.lengthOf(1);
        expect(engine._cosignDeclines.own_tip_unresolved, 'every decline is still counted').to.equal(50);
        expect(engine._cosignDeclines.snapshot_out_of_tolerance).to.equal(50);
    });

    it('logs the reason again once the window has passed', async function () {
        const { engine } = buildEngine();
        engine._cadenceStallLogMs = 1000;
        await warnsDuring(() => engine.noteCosignDecline('own_tip_unresolved', checkpointAt(1000)));
        engine._cosignDeclineLoggedAt.own_tip_unresolved -= 1001;
        const lines = await warnsDuring(() => engine.noteCosignDecline('own_tip_unresolved', checkpointAt(1001)));
        expect(lines.filter(l => /own_tip_unresolved/.test(l))).to.have.lengthOf(1);
        expect(lines[0]).to.include('declines for this reason so far: 2)');
    });

    it('keeps the per-seq log for a decline after authentication', async function () {
        const { engine } = buildEngine();
        const lines = await warnsDuring(() => {
            for (let snap = 1000; snap < 1005; snap++) engine.noteCosignDecline('indexer_no_block', checkpointAt(snap));
        });
        expect(lines.filter(l => /indexer_no_block/.test(l))).to.have.lengthOf(5);
    });
});
