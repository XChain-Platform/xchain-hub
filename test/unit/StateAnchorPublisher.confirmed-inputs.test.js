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

// The ANCHOR rail passed no `unconfirmed` flag to the encoder, so it took the
// encoder default and funded anchors from its own mempool change. Dogecoin Core
// 1.14 scores each transaction on its own fee rate, so one anchor that
// does not mine strands every anchor built on its change. The PRICE rail already
// moved to confirmed inputs only (c16ef5c); these tests pin the same rule on the
// anchor rail, its deferral path, the wake retry it arms, and the confirmation
// watchdog over this hub's own broadcasts.

const { expect }           = require('chai');
const { waitUntil }        = require('../helpers/waitUntil');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const { summarizeUtxoConfirmations } = require('../../src/lib/utxo_balance');

const ENV_KEYS = ['ANCHOR_PUBLISH_ALLOW_UNCONFIRMED_INPUTS', 'ANCHOR_CONFIRM_CHECK_MS', 'ANCHOR_CONFIRM_STALE_MS',
    'ANCHOR_STARTUP_FLUSH_MS'];

const CONFIRMED   = { txid: 'aa'.repeat(32), vout: 0, value: '15290000000000', confirmations: 12 };
const UNCONFIRMED = { txid: 'bb'.repeat(32), vout: 1, value: '15289000000000', confirmations: 0 };

function buildPub(utxos, extra) {
    let identity = new ValidatorIdentity('11'.repeat(32));
    let created  = [];
    let signed   = 0;
    let encoder  = {
        getUtxos: async () => utxos,
        createTx: async (params) => { created.push(params); return { psbt: 'psbt-hex', encoding: 'OP_RETURN' }; },
        broadcastTx: async () => ({ txid: 'cc'.repeat(32) })
    };
    let hub = Object.assign({
        db: { async doQuery() { return []; } },
        network: 'regtest',
        capabilitySnapshot: null,
        capabilityRegistry: null,
        getIdentity:    () => identity,
        getPeerManager: () => ({ broadcast() {}, on() {}, removeListener() {} }),
        p2pConfig: { DOGE_ADDRESS: 'nsTakeTestAddress0000000000000000' },
        rewardTracker: { anchorReward: '10.00000000', resolveSourceByPubkey: async () => 'src' },
        _resolveBtcLatestBlock: async () => 100,
        oraclePublisher: { encoder: encoder, walletSignFn: async () => { signed++; return 'deadbeef'; } }
    }, extra || {});
    let pub = new StateAnchorPublisher(hub);
    pub.dogeAddress = 'nsTakeTestAddress0000000000000000';
    return { pub, created, signedCount: () => signed, encoder };
}

describe('StateAnchorPublisher: confirmed inputs only (the PRICE-rail rule on the anchor rail)', function () {

    let saved;
    before(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    after(function () {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
    afterEach(function () { for (const k of ENV_KEYS) delete process.env[k]; });

    describe('the shared summary helper', function () {
        it('splits by depth, tracks the deepest confirmation per txid, and reports unknown when no field is served', function () {
            let s = summarizeUtxoConfirmations([CONFIRMED, UNCONFIRMED, { txid: 'aa'.repeat(32), vout: 2, confirmations: 3 }], 1);
            expect(s).to.include({ total: 3, confirmed: 2, unconfirmed: 1, known: true });
            expect(s.byTxid.get('aa'.repeat(32))).to.equal(12);
            let unknown = summarizeUtxoConfirmations([{ txid: 'x', vout: 0, value: '1' }], 1);
            expect(unknown).to.include({ total: 1, confirmed: 0, unconfirmed: 0, known: false });
            expect(summarizeUtxoConfirmations(null, 1)).to.include({ total: 0, known: false });
        });
    });

    describe('what reaches the encoder', function () {
        it('asks for confirmed inputs only by default', async function () {
            const { pub, created } = buildPub([CONFIRMED, UNCONFIRMED]);
            expect(pub.allowUnconfirmedInputs).to.equal(false);
            let res = await pub._defaultBroadcast('ANCHOR|5|payload');
            expect(res.txid).to.equal('cc'.repeat(32));
            expect(created).to.have.length(1);
            expect(created[0].unconfirmed, 'the encoder must not fund from mempool change').to.equal(false);
        });
        it('the escape hatch forwards unconfirmed:true', async function () {
            process.env.ANCHOR_PUBLISH_ALLOW_UNCONFIRMED_INPUTS = 'true';
            const { pub, created } = buildPub([UNCONFIRMED]);
            expect(pub.allowUnconfirmedInputs).to.equal(true);
            await pub._defaultBroadcast('ANCHOR|5|payload');
            expect(created[0].unconfirmed).to.equal(true);
        });
        it('a per-call allowUnconfirmed (archive chunks) overrides the default for that broadcast only', async function () {
            const { pub, created } = buildPub([UNCONFIRMED]);
            await pub._defaultBroadcast('ANCHOR|2|chunk', null, { allowUnconfirmed: true });
            expect(created[0].unconfirmed).to.equal(true);
            expect(pub.allowUnconfirmedInputs, 'the default is untouched').to.equal(false);
        });
    });

    describe('a wallet holding only unconfirmed change', function () {
        it('is refused BEFORE anything is built or signed, with a typed deferral error', async function () {
            const { pub, created, signedCount } = buildPub([UNCONFIRMED, { ...UNCONFIRMED, vout: 2 }]);
            let err = null;
            try { await pub._defaultBroadcast('ANCHOR|5|payload'); } catch (e) { err = e; }
            expect(err, 'throws').to.not.equal(null);
            expect(err.anchorNoConfirmedUtxo).to.equal(true);
            expect(err.message).to.contain('NO_CONFIRMED_UTXO');
            expect(created, 'no PSBT built').to.have.length(0);
            expect(signedCount(), 'nothing signed').to.equal(0);
            expect(pub.lastUtxoReserve).to.include({ total: 2, confirmed: 0, unconfirmed: 2, known: true });
        });
        it('is NOT refused when the source serves no confirmations field (unknown is not unconfirmed)', async function () {
            const { pub, created } = buildPub([{ txid: 'dd'.repeat(32), vout: 0, value: '100000000' }]);
            await pub._defaultBroadcast('ANCHOR|5|payload');
            expect(created).to.have.length(1);
        });
        it('defers the whole flush at the gate, arms the wake retry, and counts it', async function () {
            const { pub } = buildPub([UNCONFIRMED]);
            pub._checkBalance = async () => 152890;                       // above the floor: balance alone would pass
            let walked = false;
            pub._publishPendingCheckpoints = async () => { walked = true; return []; };
            pub._startArchiveRound         = async () => { walked = true; return 'none'; };
            expect(pub._wakeFlushOpts()).to.deep.equal({ failoverOnly: true });
            let res = await pub.flush();
            expect(res.skipped).to.equal('no_confirmed_utxo');
            expect(walked, 'no row is walked, no marker armed').to.equal(false);
            expect(pub.noConfirmedUtxoDeferrals).to.equal(1);
            expect(pub.lastNoConfirmedUtxoAt).to.be.a('number');
            expect(pub._leaderRetryDue).to.equal(true);
            expect(pub._wakeFlushOpts(), 'the next wake is a NORMAL flush').to.deep.equal({ failoverOnly: false });
            let stats = pub.getAnchorStats();
            expect(stats).to.include({ leaderRetryDue: true, noConfirmedUtxoDeferrals: 1, confirmedUtxos: 0, unconfirmedUtxos: 1 });
        });
        it('a normal flush that finds a confirmed output clears the retry and the wake returns to failover-only', async function () {
            const { pub } = buildPub([UNCONFIRMED]);
            pub._checkBalance = async () => 152890;
            pub._publishPendingCheckpoints = async () => [];
            pub._startArchiveRound         = async () => 'none';
            await pub.flush();
            expect(pub._leaderRetryDue).to.equal(true);
            pub.allowUnconfirmedInputs = false;
            pub.hub.oraclePublisher.encoder.getUtxos = async () => [CONFIRMED];
            let res = await pub.flush({ failoverOnly: false });
            expect(res.skipped).to.equal(undefined);
            expect(pub._leaderRetryDue).to.equal(false);
            expect(pub._wakeFlushOpts()).to.deep.equal({ failoverOnly: true });
        });
        it('a mid-flush deferral (the last confirmed output spent by an earlier anchor) is a deferral, not a failed publish', async function () {
            const { pub } = buildPub([UNCONFIRMED]);
            let row = { id: 1, chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
                        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
                        checkpoint_seq: 100, snapshot_block: 100, state_root: 'e4'.repeat(32), state_root_version: 1, block_merkle_root: 'f5'.repeat(32), block_merkle_version: 1, anchor_txid: null };
            pub.hub.db.doQuery = async (sql) => sql.indexOf('FROM state_checkpoints') !== -1 ? [row] : [];
            let me = pub.identity.getPubkeyHex().toLowerCase();
            pub._getActiveOraclePublishPubkeys = async () => [me];       // sole member: rank 0, always unlocked
            pub._recordAnchorIntent   = async () => {};
            pub._withdrawAnchorIntent = async () => {};
            pub._findExistingCheckpointAnchor = async () => null;
            // A MET attestation round. This case is about the UTXO deferral downstream of
            // the round; without this the round resolves its own capability set, comes back
            // degraded, and the bundle now defers there instead of reaching the wallet path
            // under test.
            pub._runPublisherAttestationRound = async () => ({
                met: true, sigs: [{ pubkey: me, sig: 'bb'.repeat(64) }], publisher: me });
            let errors = [];
            let origErr = console.error;
            console.error = (...a) => errors.push(a.join(' '));
            try {
                let anchored = await pub._publishPendingCheckpoints(pub._resolveSigner(), 100, false);
                expect(anchored).to.deep.equal([]);
            } finally { console.error = origErr; }
            expect(errors.filter(l => l.indexOf('v0 publish failed') !== -1), 'not reported as a failure').to.have.length(0);
            expect(pub.noConfirmedUtxoDeferrals).to.equal(1);
            expect(pub._leaderRetryDue).to.equal(true);
        });
    });

    describe('the confirmation watchdog', function () {
        it('is armed by start() on its own cadence and released by stop()', async function () {
            process.env.ANCHOR_STARTUP_FLUSH_MS = '0';
            const { pub } = buildPub([CONFIRMED]);
            expect(pub.confirmCheckIntervalMs).to.equal(300000);
            expect(pub.confirmStaleMs).to.equal(1800000);
            await pub.start();
            expect(pub._confirmTimer).to.not.equal(null);
            await pub.stop();
            expect(pub._confirmTimer).to.equal(null);
        });
        it('tracks a broadcast txid, resolves it when its change confirms, and counts it', async function () {
            const { pub } = buildPub([{ txid: 'ee'.repeat(32), vout: 1, value: '1', confirmations: 0 }]);
            pub._notePendingConfirmation('anchor_BTC', 'EE'.repeat(32), '100');
            pub._notePendingConfirmation('anchor_BTC', 'ee'.repeat(32), '100');        // case-folded dedupe
            expect(pub.getAnchorStats().unconfirmedPublishes).to.equal(1);
            await pub._checkPublishedConfirmations();
            expect(pub.getAnchorStats().unconfirmedPublishes, 'still at depth 0').to.equal(1);
            pub.hub.oraclePublisher.encoder.getUtxos = async () => [{ txid: 'ee'.repeat(32), vout: 1, value: '1', confirmations: 1 }];
            await pub._checkPublishedConfirmations();
            expect(pub.getAnchorStats().unconfirmedPublishes).to.equal(0);
            expect(pub.confirmedPublishes).to.equal(1);
        });
        it('an absent txid counts as landed only when the address holds a confirmed output (its change was spent on)', async function () {
            const { pub } = buildPub([{ txid: 'ff'.repeat(32), vout: 0, value: '1', confirmations: 0 }]);
            pub._notePendingConfirmation('archive_head', 'ee'.repeat(32), '7');
            await pub._checkPublishedConfirmations();
            expect(pub.getAnchorStats().unconfirmedPublishes, 'absent + nothing confirmed = still stuck').to.equal(1);
            pub.hub.oraclePublisher.encoder.getUtxos = async () => [{ txid: 'ff'.repeat(32), vout: 0, value: '1', confirmations: 2 }];
            await pub._checkPublishedConfirmations();
            expect(pub.getAnchorStats().unconfirmedPublishes).to.equal(0);
        });
        it('warns UNCONFIRMED_ANCHOR once a broadcast is older than the stale bound, naming it', async function () {
            process.env.ANCHOR_CONFIRM_STALE_MS = '1';
            const { pub } = buildPub([{ txid: 'ee'.repeat(32), vout: 1, value: '1', confirmations: 0 }]);
            const notedAt = Date.now();
            pub._notePendingConfirmation('anchor_DOGE', 'ee'.repeat(32), '150174');
            // The stale bound is wall-clock; poll until it has provably elapsed.
            await waitUntil(() => Date.now() - notedAt > 1, { label: 'stale bound elapsed' });
            let warns = [];
            let origWarn = console.warn;
            console.warn = (...a) => warns.push(a.join(' '));
            try { await pub._checkPublishedConfirmations(); } finally { console.warn = origWarn; }
            let hit = warns.filter(l => l.indexOf('UNCONFIRMED_ANCHOR') !== -1);
            expect(hit).to.have.length(1);
            expect(hit[0]).to.contain('anchor_DOGE 150174');
            expect(hit[0]).to.contain('Nothing is re-broadcast or fee-bumped');
            let oldest = pub.getAnchorStats().oldestUnconfirmedPublish;
            expect(oldest).to.include({ kind: 'anchor_DOGE', ref: '150174' });
        });
        it('an unreadable UTXO set fails soft: counted, nothing resolved, nothing thrown', async function () {
            const { pub } = buildPub([CONFIRMED]);
            pub._notePendingConfirmation('anchor_LTC', 'ee'.repeat(32), '1');
            pub.hub.oraclePublisher.encoder.getUtxos = async () => { throw new Error('encoder down'); };
            await pub._checkPublishedConfirmations();
            expect(pub.confirmationCheckFailures).to.equal(1);
            expect(pub.getAnchorStats().unconfirmedPublishes).to.equal(1);
        });
    });
});
