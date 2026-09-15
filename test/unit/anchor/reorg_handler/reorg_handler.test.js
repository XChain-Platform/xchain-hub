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
// ReorgHandler: affected-chain and quorum derivation, the digest and hash-pair
// checks, reorg history paging, start/stop and message dispatch. The reportReorg
// entry, the self-node verification gates, the own-node probe and the PBFT round
// live in the reorg_handler_* siblings beside this file.

const sinon          = require('sinon');
const { expect }     = require('chai');
const ReorgHandler   = require('../../../../src/anchor/reorg_handler');
const { createMockHub }     = require('../../../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4 } = require('../../../helpers/fixtures');
const { waitUntil }  = require('../../../helpers/waitUntil');

// A valid observed-hash pair for the R2-C2 wire format (distinct 64-hex).
const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);

// The handler under test and its mock hub, rebuilt by the hooks inside the
// ReorgHandler describe before every case.
let hub, pm, rh;

describe('ReorgHandler', function () {

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        rh  = new ReorgHandler(hub);
    });

    afterEach(function () {
        for (let [, pending] of rh.pendingReorgs) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        sinon.restore();
    });

    registerAffectedChains();
    registerGetQuorum();
    registerDigest();
    registerHashesWellFormed();
    registerReorgHistory();
    registerStartStop();
    registerMessageDispatch();
});

// -----------------------------------------------------------------
// getAffectedChains()
// -----------------------------------------------------------------

function registerAffectedChains() {
    describe('getAffectedChains()', function () {
        it('returns all chains except source: BTC', function () {
            expect(rh.getAffectedChains('BTC')).to.deep.equal(['LTC', 'DOGE']);
        });

        it('returns all chains except source: LTC', function () {
            expect(rh.getAffectedChains('LTC')).to.deep.equal(['BTC', 'DOGE']);
        });

        it('returns all chains except source: DOGE', function () {
            expect(rh.getAffectedChains('DOGE')).to.deep.equal(['BTC', 'LTC']);
        });
    });
}

// -----------------------------------------------------------------
// getQuorum()
// -----------------------------------------------------------------

function registerGetQuorum() {
    describe('getQuorum()', function () {
        it('N=3 → 2 (majority floor)', function () {
            rh.setValidatorSet(VALIDATORS_3);
            // f=floor(2/3)=0 → 2f+1=1, floored at ceil((3+1)/2)=2
            expect(rh.getQuorum()).to.equal(2);
        });

        it('single node → 0', function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            expect(rh.getQuorum()).to.equal(0);
        });

        // REORG-QUORUM-PEER-FALLBACK-1: with no authoritative validator set the
        // destructive-rollback quorum is derived from the authenticated validator
        // registry (the same set that gates co-signs), not the raw open-socket count.
        it('derives N from the registered-validator count, not raw open sockets, when the set is empty', function () {
            rh.setValidatorSet([]);
            pm.validatorAddr    = VALIDATORS_3[0].addr;
            pm.validatorPubkeys = new Map(VALIDATORS_3.map(v => [v.addr, v.pubkey]));
            // A flood of extra open sockets must NOT move N off the registry count of 3.
            pm.getPeerStatus.returns(Array.from({ length: 9 }, () => ({ state: 'open' })));
            expect(rh.getQuorum()).to.equal(2); // N=3 → majority floor ceil(4/2)=2
        });

        it('adds 1 for self when this node is not yet in the registry', function () {
            rh.setValidatorSet([]);
            pm.validatorAddr    = 'ws://self-not-registered:10001';
            pm.validatorPubkeys = new Map(VALIDATORS_3.map(v => [v.addr, v.pubkey]));
            expect(rh.getQuorum()).to.equal(3); // N=3+1=4 → 2f+1=3
        });

        it('falls back to the peer-socket count only when the registry is empty (bootstrap)', function () {
            rh.setValidatorSet([]);
            pm.validatorPubkeys = new Map();
            pm.getPeerStatus.returns([{ state: 'open' }, { state: 'open' }]);
            expect(rh.getQuorum()).to.equal(2); // N=2 peers + 1 self = 3 → majority floor 2
        });
    });
}

// -----------------------------------------------------------------
// _digest()
// -----------------------------------------------------------------

function registerDigest() {
    describe('_digest()', function () {
        it('returns 64-char hex hash', function () {
            expect(rh._digest('BTC:100:123', 'BTC', 100, 123, OLD_HASH, NEW_HASH)).to.match(/^[0-9a-f]{64}$/);
        });

        it('is deterministic', function () {
            let a = rh._digest('id', 'BTC', 100, 999, OLD_HASH, NEW_HASH);
            let b = rh._digest('id', 'BTC', 100, 999, OLD_HASH, NEW_HASH);
            expect(a).to.equal(b);
        });

        it('binds the observed hashes (a swapped newHash changes the digest)', function () {
            let a = rh._digest('id', 'BTC', 100, 999, OLD_HASH, NEW_HASH);
            let b = rh._digest('id', 'BTC', 100, 999, OLD_HASH, 'c'.repeat(64));
            expect(a).to.not.equal(b);
        });
    });
}

// -----------------------------------------------------------------
// hashesWellFormed()
// -----------------------------------------------------------------

function registerHashesWellFormed() {
    describe('hashesWellFormed()', function () {
        it('accepts two distinct 64-hex hashes', function () {
            expect(rh.hashesWellFormed(OLD_HASH, NEW_HASH)).to.be.true;
        });

        it('rejects identical hashes (not a reorg)', function () {
            expect(rh.hashesWellFormed(OLD_HASH, OLD_HASH)).to.be.false;
        });

        it('rejects non-hex / wrong-length / missing values', function () {
            expect(rh.hashesWellFormed('xyz', NEW_HASH)).to.be.false;
            expect(rh.hashesWellFormed(OLD_HASH, 'b'.repeat(63))).to.be.false;
            expect(rh.hashesWellFormed(undefined, NEW_HASH)).to.be.false;
        });
    });
}

// -----------------------------------------------------------------
// getReorgHistory()
// -----------------------------------------------------------------

function registerReorgHistory() {
    describe('getReorgHistory()', function () {
        it('queries with limit', async function () {
            hub.db.doQuery.resolves([]);
            await rh.getReorgHistory(10);
            expect(hub.db.doQuery.getCall(0).args[0]).to.include('LIMIT 10');
        });

        it('defaults to 50', async function () {
            hub.db.doQuery.resolves([]);
            await rh.getReorgHistory();
            expect(hub.db.doQuery.getCall(0).args[0]).to.include('LIMIT 50');
        });

        // Server-side page cap: this RPC must not depend on callers behaving
        // (e.g. the explorer passing {limit:500}) or on the API layer's generic
        // validateLimit 10000 ceiling. Matches CapabilityRegistry#listState and
        // Governance#getProposals/#getVotes, which each cap at 500 in their own SQL.
        it('caps at 500 even when a larger limit is requested', async function () {
            hub.db.doQuery.resolves([]);
            await rh.getReorgHistory(99999);
            expect(hub.db.doQuery.getCall(0).args[0]).to.include('LIMIT 500');
            expect(hub.db.doQuery.getCall(0).args[0]).to.not.include('LIMIT 99999');
        });
    });
}

// -----------------------------------------------------------------
// start() / stop() + dispatch
// -----------------------------------------------------------------

function registerStartStop() {
    describe('start() / stop()', function () {
        it('start subscribes to peer messages; stop unsubscribes and clears pending timers', async function () {
            await rh.start();
            expect(rh._messageHandler).to.be.a('function');
            expect(pm.listenerCount('message')).to.equal(1);

            rh.pendingReorgs.set('x', { timer: setTimeout(() => {}, 60000) });
            await rh.stop();

            expect(rh._messageHandler).to.equal(null);
            expect(pm.listenerCount('message')).to.equal(0);
            expect(rh.pendingReorgs.size).to.equal(0);
        });
    });
}

function registerMessageDispatch() {
    describe('_handleMessage dispatch', function () {
        it('routes alert / prepare / commit and ignores unknown types', async function () {
            let a = sinon.spy(rh, 'handleAlert');
            let p = sinon.spy(rh, 'handlePrepare');
            let c = sinon.spy(rh, '_handleCommit');
            await rh._handleMessage({ type: 'REORG_ALERT', data: {} });
            await rh._handleMessage({ type: 'XCHAIN_REORG_PREPARE', data: {} });
            await rh._handleMessage({ type: 'XCHAIN_REORG_COMMIT', data: {} });
            await rh._handleMessage({ type: 'NOPE', data: {} });
            expect(a.calledOnce).to.be.true;
            expect(p.calledOnce).to.be.true;
            expect(c.calledOnce).to.be.true;
        });

        it('the start() listener surfaces (does not crash on) handler rejections', async function () {
            await rh.start();
            sinon.stub(rh, '_handleMessage').rejects(new Error('boom'));
            // The listener's own catch logs the rejection, so that log line is the
            // proof it was surfaced rather than left to crash the process.
            let errStub = sinon.stub(console, 'error');
            try {
                expect(() => pm.emit('message', { type: 'REORG_ALERT', data: {} })).to.not.throw();
                await waitUntil(() => errStub.calledWithMatch('Reorg: message handling error:'),
                    { label: 'the listener to surface the handler rejection' });
            } finally {
                errStub.restore();
            }
            await rh.stop();
        });
    });
}
