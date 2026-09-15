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
//
// StateAnchorPublisher on a bare publisher, no mesh: the getAnchorStats balance
// surface, the spec-stable capability-snapshot archive sort, the stop()
// archive-attestation teardown, the rootless co-sign guard canonical, and the
// recordRewardAttestation mirror INSERT.

const { expect }            = require('chai');
const StateAnchorPublisher  = require('../../../../src/anchor/publisher');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine');
const arMod                 = require('../../../../src/anchor_reward_activation.js');
const { DB_METHODS }        = require('../../../helpers/mockHub.js');

// Publisher-wallet runway stats (#5443): checkBalance records the last-observed
// DOGE balance and getAnchorStats surfaces it for the monitor/operator.
describe('StateAnchorPublisher getAnchorStats balance', function () {
    function newPub(cfg) {
        return new StateAnchorPublisher({ db: {}, p2pConfig: Object.assign({ DOGE_ADDRESS: 'Dpub1' }, cfg || {}) });
    }
    it('starts with a null balance and exposes address + threshold', function () {
        let s = newPub({ DOGE_LOW_BALANCE_THRESHOLD: '10' }).getAnchorStats();
        expect(s.dogeBalance).to.equal(null);
        expect(s.dogeBalanceAt).to.equal(null);
        expect(s.dogeAddress).to.equal('Dpub1');
        expect(s.lowBalanceThreshold).to.equal(10);
    });
    it('checkBalance records the observed balance into getAnchorStats', async function () {
        let pub = newPub();
        let bal = await pub.checkBalance({ getBalanceFn: async () => 42.5 });
        expect(bal).to.equal(42.5);
        let s = pub.getAnchorStats();
        expect(s.dogeBalance).to.equal(42.5);
        expect(s.dogeBalanceAt).to.be.a('number');
    });
    it('a failed balance read leaves the last-observed value untouched', async function () {
        let pub = newPub();
        await pub.checkBalance({ getBalanceFn: async () => 5 });
        await pub.checkBalance({ getBalanceFn: async () => { throw new Error('node down'); } });
        expect(pub.getAnchorStats().dogeBalance).to.equal(5);   // not clobbered to null
    });
    // The encoder branch reports get_utxos `value` in satoshis, while
    // lowBalanceThreshold, spendGuard.minBalance and the monitor's dogeBalance
    // alert are all whole DOGE, so the sum has to convert.
    it('sums encoder UTXOs into DOGE, not satoshis', async function () {
        let pub = newPub({ DOGE_LOW_BALANCE_THRESHOLD: '10' });
        let signer = { encoder: { getUtxos: async () => [
            { value: '500000000', amount: '5.00000000' },
            { value: '350000000', amount: '3.50000000' }
        ] } };
        let bal = await pub.checkBalance(signer);
        expect(bal).to.equal(8.5);
        expect(bal).to.be.below(pub.lowBalanceThreshold);   // 8.5 DOGE is low; 8.5e8 never was
        expect(pub.getAnchorStats().dogeBalance).to.equal(8.5);
    });
    it('converts an encoder UTXO carrying only the satoshi value field', async function () {
        let pub = newPub();
        let signer = { encoder: { getUtxos: async () => [{ value: '1500000000' }] } };
        expect(await pub.checkBalance(signer)).to.equal(15);
    });
});

describe('StateAnchorPublisher: capability-snapshot archive sort is a spec-stable total order', function () {

    // The archive JSON is crc32-bearing bytes verified byte-for-byte by
    // follower co-signers, so the capability-snapshot ordering must be fully
    // determined by the data (pubkey, then source), never by the engine's
    // handling of an inconsistent (equal-returns-1) comparator. Equal pubkeys
    // are legitimately possible in weighted snapshots: one row per
    // (source, pubkey), and a key may be delegated by multiple sources.

    function newPub() {
        return new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    }
    function capSnaps(pub, set) {
        pub._resolveCapabilitySet = async () => set.map(r => Object.assign({}, r));
        return pub.buildArchive('regtest', 1, [], 100, [], [])
            .then(a => JSON.parse(a.json).capability_snapshots
                .map(s => s.signing_pubkey + '|' + s.source));
    }

    it('orders equal-pubkey rows by source regardless of input order', async function () {
        let scrambled = [
            { pubkey: 'aa', amount: '1', source: 'srcB' },
            { pubkey: 'bb', amount: '2', source: 'srcA' },
            { pubkey: 'aa', amount: '1', source: 'srcA' }
        ];
        let out = await capSnaps(newPub(), scrambled);
        expect(out).to.deep.equal(['aa|srcA', 'aa|srcB', 'bb|srcA']);
    });

    it('produces byte-identical ordering for two different input orders of equal pubkeys', async function () {
        let orderA = [
            { pubkey: 'aa', amount: '1', source: 'srcA' },
            { pubkey: 'aa', amount: '1', source: 'srcB' }
        ];
        let orderB = [
            { pubkey: 'aa', amount: '1', source: 'srcB' },
            { pubkey: 'aa', amount: '1', source: 'srcA' }
        ];
        let outA = await capSnaps(newPub(), orderA);
        let outB = await capSnaps(newPub(), orderB);
        expect(outA).to.deep.equal(outB);
        expect(outA).to.deep.equal(['aa|srcA', 'aa|srcB']);
    });
});

// stop() must settle the archive-attestation round's awaited promise, mirroring
// the v4/v5 _attestRound teardown (#2360). Without it a stop() mid-round leaves
// _publishArchive hung on a promise only an unref'd timer could ever settle.
describe('StateAnchorPublisher stop() archive-attestation teardown (#2360)', function () {
    function barePub() {
        return new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    }

    it('resolves a pending _archiveAttestRound with { met:false, sigs:[] } and nulls the field', async function () {
        let pub = barePub();
        let settled = null;
        let timer = setTimeout(() => {}, 1e6);
        if (timer.unref) timer.unref();
        pub._archiveAttestRound = { done: false, timer: timer, resolve: (v) => { settled = v; } };
        await pub.stop();
        expect(settled, 'awaiting _publishArchive is unblocked on shutdown').to.deep.equal({ met: false, sigs: [] });
        expect(pub._archiveAttestRound, 'field nulled').to.equal(null);
    });

    it('is a no-op when the round is already done (no double-resolve)', async function () {
        let pub = barePub();
        let calls = 0;
        pub._archiveAttestRound = { done: true, timer: null, resolve: () => { calls++; } };
        await pub.stop();
        expect(calls, 'a completed round is not re-resolved').to.equal(0);
        expect(pub._archiveAttestRound).to.equal(null);
    });
});

// cpFromRow intentionally omits the SPV roots, and the co-sign guards compare via
// rawCanonicalCheckpoint so the presence-gated root suffix can never flip them
// fail-closed post-flag-day (#2462).
describe('StateAnchorPublisher checkpoint co-sign guard uses the rootless canonical (#2462)', function () {
    const ckptMod = require('../../../../src/checkpoint_commitment_activation.js');
    let savedRegtest;
    beforeEach(function () {
        savedRegtest = ckptMod.CHECKPOINT_COMMITMENT_ACTIVATION.regtest;
        ckptMod.CHECKPOINT_COMMITMENT_ACTIVATION.regtest = 0;   // roots committed at genesis on regtest
    });
    afterEach(function () {
        ckptMod.CHECKPOINT_COMMITMENT_ACTIVATION.regtest = savedRegtest;
    });

    it('rawCanonicalCheckpoint matches across the rootless and root-bearing shapes while canonicalCheckpoint differs', function () {
        let row = {
            chain: 'BTC', network: 'regtest', block_index: 494,
            block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
            actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
            checkpoint_seq: 7, snapshot_block: 100,
            state_root: 'd4'.repeat(32), state_root_version: 1,
            block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
        };
        let rootless = StateAnchorPublisher.prototype.cpFromRow(row);
        expect(rootless).to.not.have.property('state_root');    // cpFromRow drops the roots by design
        let rootBearing = Object.assign({}, rootless, {
            state_root: row.state_root, state_root_version: row.state_root_version,
            block_merkle_root: row.block_merkle_root, block_merkle_version: row.block_merkle_version
        });
        // The guard (via rawCanonicalCheckpoint) still binds identity fields and
        // passes even when exactly one operand carries roots.
        expect(StateCheckpointEngine.rawCanonicalCheckpoint(rootless))
            .to.equal(StateCheckpointEngine.rawCanonicalCheckpoint(rootBearing));
        // Whereas canonicalCheckpoint would DIFFER on the presence-gated suffix,
        // which is exactly why the guards must not use it.
        expect(StateCheckpointEngine.canonicalCheckpoint(rootless))
            .to.not.equal(StateCheckpointEngine.canonicalCheckpoint(rootBearing));
    });
});

// ── anchor_reward_attestations mirror INSERT ──────────────────────
describe('StateAnchorPublisher.recordRewardAttestation', function () {
    const sinon = require('sinon');

    function makePub(){
        const queries = [];
        const broadcast = [];
        const db = { ...DB_METHODS, async doQuery(sql, params){ queries.push({ sql, params }); return sql.indexOf('SELECT') === 0 ? [{ id: 1, publisher: params[5] }] : { affectedRows: 1 }; } };
        const hub = { db, getIdentity: () => null, hubDbBroadcaster: { broadcastRow: (ev) => broadcast.push(ev) } };
        return { pub: new StateAnchorPublisher(hub), queries, broadcast };
    }

    afterEach(() => sinon.restore());

    it('below the derive gate (inert mainnet placeholder) it writes NOTHING', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
        const { pub, queries, broadcast } = makePub();
        await pub.recordRewardAttestation('BTC', 'mainnet', 'anchor_BTC', 5, 1000000, 'ab'.repeat(32), [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }]);
        expect(queries.length).to.equal(0);
        expect(broadcast.length).to.equal(0);
    });

    it('at/above the gate it INSERT-IGNOREs the tuple with the FROZEN amount and broadcasts the row', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries, broadcast } = makePub();
        const pk = 'ab'.repeat(32);
        await pub.recordRewardAttestation('BTC', 'regtest', 'anchor_BTC', 5, 0, pk, [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }]);
        const ins = queries.find(q => q.sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0);
        expect(ins, 'INSERT IGNORE issued').to.exist;
        expect(ins.params[2]).to.equal('anchor_BTC');            // reward_type
        expect(ins.params[6]).to.equal(arMod.ANCHOR_REWARD_AMOUNT); // frozen amount, not wire
        expect(broadcast.length).to.equal(1);
        expect(broadcast[0].table).to.equal('anchor_reward_attestations');
    });

    it('uses the ARCHIVE frozen amount for an anchor_archive tuple', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makePub();
        await pub.recordRewardAttestation('BTC', 'regtest', 'anchor_archive', 3, 0, 'ab'.repeat(32), [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }]);
        const ins = queries.find(q => q.sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0);
        expect(ins.params[6]).to.equal(arMod.ARCHIVE_REWARD_AMOUNT);
    });

    it('writes nothing when the attestation sig list is empty', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makePub();
        await pub.recordRewardAttestation('BTC', 'regtest', 'anchor_BTC', 5, 0, 'ab'.repeat(32), []);
        expect(queries.length).to.equal(0);
    });
});
