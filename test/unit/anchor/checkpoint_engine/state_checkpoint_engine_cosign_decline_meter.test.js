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

// A follower that cannot confirm a proposed checkpoint declines to co-sign, which is the
// fail-closed answer, and the decline must leave a trace: a silent one lets a member whose
// own indexer is down drop out of every quorum while the rest still sign. Each of the five
// declines is counted by reason, warned at most once per window, and reported by
// getcheckpointstats, and a leader's round timeout names the validators that never signed.
// No signing decision moves: every case below that declines still does not co-sign.

const { expect }            = require('chai');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine');
const ValidatorIdentity     = require('../../../../src/validators/identity');
const canonicalForms        = require('../../../../src/anchor/checkpoint_engine/canonical_forms.js');
const { DB_METHODS }        = require('../../../helpers/mockHub.js');
const { waitUntil }         = require('../../../helpers/waitUntil');

const SNAP = 500;
const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

const leader   = new ValidatorIdentity('10'.repeat(32));
const follower = new ValidatorIdentity('11'.repeat(32));
const absent   = new ValidatorIdentity('12'.repeat(32));
const pk = (id) => id.getPubkeyHex().toLowerCase();

// A follower engine whose every pre-indexer guard passes, so each case turns on one input.
function buildFollower(opts) {
    let hub = {
        db: { ...DB_METHODS, async doQuery() { return []; } },
        network: 'regtest',
        p2pConfig: { CHECKPOINT_CHAINS: 'BTC', CHECKPOINT_CONFIRMATIONS: '0', BTC_INDEXER_URL: 'http://stub' },
        hubDbBroadcaster: { broadcastRow() {} },
        getPeerManager: () => ({ on() {}, removeListener() {}, broadcast() {} }),
        getIdentity: () => follower
    };
    let engine = new StateCheckpointEngine(hub);
    engine.resolveSnapshotBlock = async () => (opts.tip !== undefined ? opts.tip : SNAP);
    engine.resolveCapabilityValidators = async () => [leader, follower].map(id => ({ pubkey: pk(id), amount: '1' }));
    engine.followsCadenceLeader = () => true;
    engine.getMaxCheckpointSeq = async () => null;
    if (opts.latch !== undefined) engine._lastCheckpointBtcBlock = opts.latch;
    engine.indexerCall = opts.indexerCall || (async () => Object.assign({}, TIP));
    engine.cosigned = [];
    engine.coSignAgainstOwnBlock = (cp) => { engine.cosigned.push(cp); };
    return engine;
}

function signReq() {
    let cp = Object.assign({ chain: 'BTC', snapshot_block: SNAP, checkpoint_seq: canonicalForms.deriveCheckpointSeq(SNAP) }, TIP);
    let sig = leader.sign(StateCheckpointEngine.canonicalCheckpoint(cp));
    return { type: 'XCHK_SIGN_REQ', sender: pk(leader), data: { checkpoint: cp, sig_pubkey: pk(leader), sig: sig } };
}

// Run fn with console.warn captured, returning the warn lines it produced.
async function warnsDuring(fn) {
    let seen = [], orig = console.warn;
    console.warn = (m) => seen.push(String(m));
    try { await fn(); } finally { console.warn = orig; }
    return seen;
}

const DECLINE_CASES = [
    ['indexer_read_failed', { indexerCall: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4000'); } }, /ECONNREFUSED/],
    ['indexer_no_block',    { indexerCall: async () => null }, /indexer_no_block/],
    ['own_tip_unresolved',  { tip: null }, /own_tip_unresolved/],
    ['snapshot_out_of_tolerance', { tip: SNAP + 10000 }, /proposed 500, our tip 10500/],
    ['off_cadence',         { latch: SNAP - 2 }, /proposed 500, last checkpoint 498, interval 6/],
];

describe('StateCheckpointEngine: follower co-sign declines are counted and named', function () {
    for (let [reason, opts, detail] of DECLINE_CASES) {
        it(reason + ': declines, counts it, and warns once per window', async function () {
            let engine = buildFollower(opts);
            let lines = await warnsDuring(async () => {
                await engine.handleSignReq(signReq());
                await engine.handleSignReq(signReq());
            });
            expect(engine.cosigned, 'still fail-closed').to.have.lengthOf(0);
            expect(engine._cosignDeclines[reason]).to.equal(2);
            let mine = lines.filter(l => /declining to co-sign/.test(l));
            expect(mine, 'throttled to one line for two declines').to.have.lengthOf(1);
            expect(mine[0]).to.include(reason).and.to.match(detail);
        });
    }

    it('the happy path co-signs and counts nothing', async function () {
        let engine = buildFollower({});
        await engine.handleSignReq(signReq());
        expect(engine.cosigned).to.have.lengthOf(1);
        expect(Object.values(engine._cosignDeclines).every(n => n === 0)).to.equal(true);
    });

    it('getcheckpointstats reports every reason and the last one seen', async function () {
        let engine = buildFollower({ indexerCall: async () => null });
        let fresh = await engine.getStats();
        expect(fresh.cosign_declines).to.have.all.keys('own_tip_unresolved', 'snapshot_out_of_tolerance', 'off_cadence',
            'indexer_read_failed', 'indexer_no_block');
        expect(fresh.last_cosign_decline_reason).to.equal(null);
        await warnsDuring(() => engine.handleSignReq(signReq()));
        let stats = await engine.getStats();
        expect(stats.cosign_declines.indexer_no_block).to.equal(1);
        expect(stats.last_cosign_decline_reason).to.equal('indexer_no_block');
    });
});

describe('StateCheckpointEngine: a timed-out round names its missing signers', function () {
    it('lists the validators that did not sign, deduped, and not the leader', async function () {
        let engine = buildFollower({});
        engine.roundTimeoutMs = 20;
        let validators = [leader, follower, absent, absent].map(id => ({ pubkey: pk(id), source: 's', weight: '1' }));
        let cp = Object.assign({ chain: 'BTC', snapshot_block: SNAP, checkpoint_seq: 9 }, TIP);
        let lines = await warnsDuring(async () => {
            engine.openLeaderRound({ id: 'BTC|regtest|500|9', cp: cp, canonical: 'c', quorum: 3, weighted: false,
                validators: validators, myPubkey: pk(leader), mySig: 'sig' });
            await waitUntil(() => engine._roundTimeouts === 1, { label: 'the round timeout' });
        });
        let line = lines.find(l => /timed out/.test(l));
        expect(line, 'the timeout warned').to.be.a('string');
        expect(line).to.include('missing: ' + [pk(follower), pk(absent)].sort().join(','));
        expect(line).to.not.include(pk(leader));
        expect(engine._roundTimeouts).to.equal(1);
    });
});
