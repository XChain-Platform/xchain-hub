'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: a hub that serves no capability of its own still has to see
// the federation it receives frames from. Its capability registry is live but
// empty (no capability config), so every threshold resolved null and both
// snapshot fetchers refused: weighted rounds never found a weight snapshot, and
// the submission audit dropped every peer because the hand-maintained addr->key
// registry knows none of them. The stake-weight feed closes both with ONE
// answer, the canonical federation floor, and a hub without the feed must keep
// refusing exactly as it does today.

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

const OracleRound        = require('../../src/OracleRound');
const OracleConsensus    = require('../../src/OracleConsensus');
const CapabilityRegistry = require('../../src/CapabilityRegistry');
const StakeWeightFeed    = require('../../src/StakeWeightFeed');
const { createMockHub }  = require('../helpers/mockHub');
const { makeValidator }  = require('../helpers/fixtures');

// Testnet's STAKE_WEIGHTED_QUORUM activation is block 0, so any real height is
// weighted. CapabilitySnapshot buries every read by the canonical reorg buffer.
const BLOCK  = 150200;
const BURIED = BLOCK - 6;
const ROUND  = 4242;

// coins/BTC.js STAKING.CAPABILITIES.price.MIN_STAKE, the floor
// XChainHub._assertCanonicalMinStakes refuses to let a configured hub diverge from.
const CANONICAL_PRICE_FLOOR = '1000.00000000';

// The five testnet validators whose frames the public-tier hub receives. Distinct
// staking sources, so the weighted tally has a real denominator.
const FEDERATION = [1, 2, 3, 4, 5].map(i => {
    let v = makeValidator(i);
    return { addr: v.addr, pubkey: v.pubkey, source: 'src' + i, weight: '4000.00000000' };
});

function weightResult(capability, blockIndex) {
    return { data: { result: {
        capability:   capability,
        block_index:  blockIndex,
        count:        FEDERATION.length,
        source_count: FEDERATION.length,
        validators:   FEDERATION.map(v => ({ pubkey: v.pubkey, source: v.source, weight: v.weight }))
    } } };
}

function countResult(capability, blockIndex) {
    return { data: { result: {
        capability:  capability,
        block_index: blockIndex,
        count:       FEDERATION.length,
        validators:  FEDERATION.map(v => ({ pubkey: v.pubkey, amount: v.weight }))
    } } };
}

// One validator's price submission, authenticated the way the fleet authenticates
// it: a proven signing key that the CHAIN attributes (the effective signer set),
// with no registry row anywhere.
function frameFrom(validator, round) {
    return {
        type:       'ORACLE_PRICE_SUBMIT',
        sender:     validator.addr,
        sig_pubkey: validator.pubkey,
        timestamp:  Date.now(),
        data: {
            round:   round,
            sources: 2,
            prices:  [{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }]
        }
    };
}

// Rows the audit persist wrote, by validator_pubkey.
function submissionInserts(db) {
    return db.doQuery.getCalls()
        .filter(c => /INSERT IGNORE INTO oracle_submissions/.test(String(c.args[0])))
        .map(c => c.args[1]);
}

// Warnings matching a pattern, as text. Asserted as a LIST rather than a boolean
// so a regression prints the fleet's own line verbatim instead of "expected true
// to equal false", which is the only form of this failure worth reading.
function warnLines(stub, pattern) {
    return stub.getCalls()
        .map(c => c.args.map(a => String(a)).join(' '))
        .filter(line => pattern.test(line));
}

describe('StakeWeightFeed: a standalone hub reads the federation stake snapshot', function () {

    let hub, pm, db, axiosStub, CapabilitySnapshot, oracle, oc, logs;

    beforeEach(function () {
        axiosStub = { post: sinon.stub().callsFake(async (url, body) => {
            if (body.method === 'getstakeweightsbycapability')
                return weightResult(body.params.capability, body.params.block_index);
            if (body.method === 'getcapabilityvalidators')
                return countResult(body.params.capability, body.params.block_index);
            return { data: { result: null } };
        }) };
        CapabilitySnapshot = proxyquire('../../src/CapabilitySnapshot', { axios: axiosStub });

        hub = createMockHub({ p2pConfig: { HUB_NETWORK: 'testnet', ORACLE_EPOCH_START: 1704067200000 } });
        db  = hub.db;
        pm  = hub._peerManager;
        // The public-tier shape: no identity of its own, an EMPTY validator registry
        // (the 2026-09-01 registration was reverted), and the five peers admitted by
        // the chain-effective signer set alone.
        pm.validatorPubkeys  = new Map();
        pm.effectiveSignerSet = new Set(FEDERATION.map(v => v.pubkey));
        pm.getPeerStatus     = sinon.stub().returns(FEDERATION.map(v => ({ addr: v.addr, state: 'open' })));

        hub.network                = 'testnet';
        hub._resolveBtcIndexerUrl  = async () => 'http://indexer.local/rpc';
        hub._btcIndexerHeaders     = () => ({});
        hub._resolveBtcLatestBlock = sinon.stub().resolves(BLOCK);
        // A live registry with NO configured thresholds: exactly what a hub booted
        // without HUB_CAPABILITY_CONFIG carries.
        hub.capabilityRegistry     = new CapabilityRegistry(hub);
        hub.capabilitySnapshot     = new CapabilitySnapshot(hub);
        hub.stakeWeightFeed        = new StakeWeightFeed(hub);

        logs = { warn: sinon.stub(console, 'warn'), log: sinon.stub(console, 'log'),
                 error: sinon.stub(console, 'error') };

        oracle = new OracleRound(hub);
        oracle.currentRound          = ROUND;
        oracle.roundStartTime        = Date.now();
        oracle.currentBtcBlockHeight = BLOCK;
        oc = new OracleConsensus(hub, oracle);
        oracle.setConsensus(oc);
        // No validator rows in the database either, so quorum falls through to the
        // live peer count: federated, which is what arms every fail-closed guard.
        oc.setValidatorSet([]);
    });

    afterEach(function () { sinon.restore(); });

    it('resolves the canonical federation floor when the registry has none', function () {
        expect(hub.capabilityRegistry.getMinStake('price', BURIED)).to.equal(null);
        expect(hub.stakeWeightFeed.minStake('price')).to.equal(CANONICAL_PRICE_FLOOR);
    });

    it('persists the audit row for a sender no registry row attributes', async function () {
        for (let v of FEDERATION) oracle._handleMessage(frameFrom(v, ROUND));
        // The persist is fire-and-forget off a synchronous handler; let it settle.
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));

        expect(warnLines(logs.warn, /skipping DB persist for unregistered sender/)).to.deep.equal([]);
        let inserts = submissionInserts(db);
        expect(inserts.length).to.equal(FEDERATION.length);
        // Attributed to the PROVEN signing key of each peer, never a placeholder.
        expect(inserts.map(a => a[2]).sort()).to.deep.equal(FEDERATION.map(v => v.pubkey).sort());
    });

    it('finalizes under the weight snapshot the indexer served, not a count fallback', async function () {
        // Resolve the snapshot first and hold the object: CapabilitySnapshot caches
        // for a full round, so the round below must evaluate this exact instance.
        let served = await hub.capabilitySnapshot.getWeightSnapshot('price', BLOCK);

        let quorumSpy = sinon.spy(hub.capabilitySnapshot, 'getQuorum');
        for (let v of FEDERATION) oracle._handleMessage(frameFrom(v, ROUND));
        await oc.finalizeRound(ROUND, BLOCK, 1767225600);

        // The refusal that stalls the public tier today, asserted before anything
        // else so a regression prints the fleet's own line rather than a null deref.
        expect(warnLines(logs.warn, /weight snapshot unavailable/)).to.deep.equal([]);
        expect(served, 'the price weight snapshot was refused, not served').to.not.equal(null);
        expect(served.validators).to.have.length(FEDERATION.length);

        // Identity, not a count: the object the round sized its quorum from IS the
        // stake-weight snapshot the federation's own indexer returned.
        expect(quorumSpy.calledOnce).to.equal(true);
        expect(quorumSpy.firstCall.args[0]).to.equal(served);
        let methods = axiosStub.post.getCalls().map(c => c.args[1].method);
        expect(methods).to.include('getstakeweightsbycapability');
        // The count fetcher is the fallback this round must NOT have taken.
        expect(methods).to.not.include('getcapabilityvalidators');

        let weightCall = axiosStub.post.getCalls().find(c => c.args[1].method === 'getstakeweightsbycapability');
        expect(weightCall.args[1].params.min_stake).to.equal(CANONICAL_PRICE_FLOOR);
        expect(weightCall.args[1].params.block_index).to.equal(BURIED);
    });

    it('a hub with NO feed behaves exactly as today: no RPC, no snapshot, round skipped', async function () {
        hub.stakeWeightFeed = null;
        let skipped = sinon.stub(oc, '_storeSkippedRound').resolves();

        expect(await hub.capabilitySnapshot.getWeightSnapshot('price', BLOCK)).to.equal(null);

        for (let v of FEDERATION) oracle._handleMessage(frameFrom(v, ROUND));
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        await oc.finalizeRound(ROUND, BLOCK, 1767225600);

        // The fleet's own two symptoms, both still present without the feed.
        expect(warnLines(logs.warn, /skipping DB persist for unregistered sender/))
            .to.have.length(FEDERATION.length);
        expect(submissionInserts(db).length).to.equal(0);
        expect(skipped.calledWithMatch(ROUND, BLOCK, sinon.match.any,
            'weighted quorum active but weight snapshot unavailable')).to.equal(true);
        // Fail-closed means the indexer is never asked at all.
        expect(axiosStub.post.called).to.equal(false);
    });
});
