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

const sinon          = require('sinon');
const { expect }     = require('chai');
const ReorgHandler   = require('../../src/ReorgHandler');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4 } = require('../helpers/fixtures');

// A valid observed-hash pair for the R2-C2 wire format (distinct 64-hex).
const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);

describe('ReorgHandler', function () {

    let hub, pm, rh;

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

    // Most flow tests are about the PBFT round, not the node probe, so verification
    // is stubbed to "confirmed". The probe itself is covered in its own section.
    function stubVerified(result = true) {
        return sinon.stub(rh, '_verifyReorgAgainstOwnNode').resolves(result);
    }

    // -----------------------------------------------------------------
    // _getAffectedChains()
    // -----------------------------------------------------------------

    describe('_getAffectedChains()', function () {
        it('returns all chains except source: BTC', function () {
            expect(rh._getAffectedChains('BTC')).to.deep.equal(['LTC', 'DOGE']);
        });

        it('returns all chains except source: LTC', function () {
            expect(rh._getAffectedChains('LTC')).to.deep.equal(['BTC', 'DOGE']);
        });

        it('returns all chains except source: DOGE', function () {
            expect(rh._getAffectedChains('DOGE')).to.deep.equal(['BTC', 'LTC']);
        });
    });

    // -----------------------------------------------------------------
    // _getQuorum()
    // -----------------------------------------------------------------

    describe('_getQuorum()', function () {
        it('N=3 → 2 (majority floor)', function () {
            rh.setValidatorSet(VALIDATORS_3);
            // f=floor(2/3)=0 → 2f+1=1, floored at ceil((3+1)/2)=2
            expect(rh._getQuorum()).to.equal(2);
        });

        it('single node → 0', function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            expect(rh._getQuorum()).to.equal(0);
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
            expect(rh._getQuorum()).to.equal(2); // N=3 → majority floor ceil(4/2)=2
        });

        it('adds 1 for self when this node is not yet in the registry', function () {
            rh.setValidatorSet([]);
            pm.validatorAddr    = 'ws://self-not-registered:10001';
            pm.validatorPubkeys = new Map(VALIDATORS_3.map(v => [v.addr, v.pubkey]));
            expect(rh._getQuorum()).to.equal(3); // N=3+1=4 → 2f+1=3
        });

        it('falls back to the peer-socket count only when the registry is empty (bootstrap)', function () {
            rh.setValidatorSet([]);
            pm.validatorPubkeys = new Map();
            pm.getPeerStatus.returns([{ state: 'open' }, { state: 'open' }]);
            expect(rh._getQuorum()).to.equal(2); // N=2 peers + 1 self = 3 → majority floor 2
        });
    });

    // -----------------------------------------------------------------
    // _digest()
    // -----------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // _hashesWellFormed()
    // -----------------------------------------------------------------

    describe('_hashesWellFormed()', function () {
        it('accepts two distinct 64-hex hashes', function () {
            expect(rh._hashesWellFormed(OLD_HASH, NEW_HASH)).to.be.true;
        });

        it('rejects identical hashes (not a reorg)', function () {
            expect(rh._hashesWellFormed(OLD_HASH, OLD_HASH)).to.be.false;
        });

        it('rejects non-hex / wrong-length / missing values', function () {
            expect(rh._hashesWellFormed('xyz', NEW_HASH)).to.be.false;
            expect(rh._hashesWellFormed(OLD_HASH, 'b'.repeat(63))).to.be.false;
            expect(rh._hashesWellFormed(undefined, NEW_HASH)).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // reportReorg(): single-node fallback
    // -----------------------------------------------------------------

    describe('reportReorg()', function () {

        it('single-node executes rollback directly (after self-verification)', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            stubVerified(true);

            await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH);

            // Should have called doQuery for: delete attestations, update snapshots, insert reorg attestation
            expect(hub.db.doQuery.callCount).to.equal(3);
            expect(hub.db.doQuery.getCall(0).args[0]).to.include('DELETE FROM attestations');
            expect(hub.db.doQuery.getCall(1).args[0]).to.include("status = 'disputed'");
            expect(hub.db.doQuery.getCall(2).args[0]).to.include('reorg_attestations');
        });

        it('single-node emits reorg:confirmed event', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            stubVerified(true);

            let emitted = null;
            rh.on('reorg:confirmed', (d) => { emitted = d; });

            await rh.reportReorg('LTC', 300000, Date.now(), OLD_HASH, NEW_HASH);

            expect(emitted).to.not.be.null;
            expect(emitted.sourceChain).to.equal('LTC');
            expect(emitted.reorgHeight).to.equal(300000);
        });

        it('skips already-processed reorgs', async function () {
            let ts = Date.now();
            rh.processed.add('BTC:500000:' + ts);
            let verify = stubVerified(true);
            await rh.reportReorg('BTC', 500000, ts, OLD_HASH, NEW_HASH);
            expect(hub.db.doQuery.called).to.be.false;
            expect(verify.called, 'no probe for an already-processed reorg').to.be.false;
        });

        it('rejects a reorg whose timestamp is far in the past (blast-radius bound)', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            let threw = false;
            // A timestamp near epoch would otherwise DELETE nearly all attestations.
            try { await rh.reportReorg('BTC', 500000, 1700000000000, OLD_HASH, NEW_HASH); }
            catch (e) { threw = true; expect(e.message).to.match(/too far in the past/); }
            expect(threw).to.be.true;
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('multi-node broadcasts REORG_ALERT (carrying the hash pair) and initiates consensus', async function () {
            rh.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
            stubVerified(true);

            await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH);

            // With N=3 and quorum=1, self-prepare meets quorum immediately.
            // Broadcasts: REORG_ALERT, XCHAIN_REORG_PREPARE, XCHAIN_REORG_COMMIT
            expect(pm.broadcast.callCount).to.be.at.least(2);
            expect(pm.broadcast.getCall(0).args[0]).to.equal('REORG_ALERT');
            expect(pm.broadcast.getCall(0).args[1].oldHash).to.equal(OLD_HASH);
            expect(pm.broadcast.getCall(0).args[1].newHash).to.equal(NEW_HASH);
            expect(pm.broadcast.getCall(1).args[0]).to.equal('XCHAIN_REORG_PREPARE');
            expect(pm.broadcast.getCall(1).args[1].oldHash).to.equal(OLD_HASH);
            expect(pm.broadcast.getCall(1).args[1].newHash).to.equal(NEW_HASH);
        });
    });

    // -----------------------------------------------------------------
    // R2-C2: self-node verification gates
    // -----------------------------------------------------------------

    describe('self-node verification (R2-C2)', function () {

        it('reportReorg requires a well-formed, distinct hash pair', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            for (let [o, n] of [[undefined, undefined], [OLD_HASH, OLD_HASH], ['nope', NEW_HASH]]) {
                let threw = false;
                try { await rh.reportReorg('BTC', 500000, Date.now(), o, n); }
                catch (e) { threw = true; expect(e.message).to.match(/distinct 64-hex/); }
                expect(threw, 'should reject ' + o + '/' + n).to.be.true;
            }
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('reportReorg refuses (and does not broadcast or roll back) when the own node does not confirm', async function () {
            rh.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
            stubVerified(false);

            let threw = false;
            try { await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH); }
            catch (e) { threw = true; expect(e.message).to.match(/own indexer does not confirm/); }
            expect(threw).to.be.true;
            expect(pm.broadcast.called).to.be.false;
            expect(hub.db.doQuery.called).to.be.false;
            expect(rh.pendingReorgs.size).to.equal(0);
        });

        it('single-node fast path is gated on self-verification too', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            stubVerified(false);

            let threw = false;
            try { await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH); }
            catch (e) { threw = true; }
            expect(threw).to.be.true;
            expect(hub.db.doQuery.called, 'no rollback without confirmation').to.be.false;
        });

        it('_handleAlert abstains (no round, no PREPARE) when verification fails', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            stubVerified(false);

            let ts = Date.now();
            let reorgId = 'BTC:500:' + ts;
            await rh._handleAlert({
                sender: VALIDATORS_4[1].addr,
                data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has(reorgId)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('reportReorg rejects a timestamp that predates the reorged block\'s own block_time', async function () {
            // R1 (over-rollback): a registered reporter announcing a REAL reorg with a
            // far-past timestamp must be refused once our own node shows the reorged
            // block is fresh (a reorg cannot be observed before the block existed).
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            let blockTime = Date.now() - 60000;                       // block mined 1 min ago
            stubVerified({ blockTimeMs: blockTime });

            let threw = false;
            let ts = blockTime - rh.timestampSkewToleranceMs - 60000; // predates block beyond tolerance
            try { await rh.reportReorg('BTC', 500000, ts, OLD_HASH, NEW_HASH); }
            catch (e) { threw = true; expect(e.message).to.match(/predates the reorged block/); }
            expect(threw).to.be.true;
            expect(hub.db.doQuery.called, 'no rollback for an over-reaching timestamp').to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('single-node rollback anchors its bound to the observed block_time', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            let blockTime = Date.now() - 600000;                      // reorged block 10 min old
            stubVerified({ blockTimeMs: blockTime });

            await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH);

            expect(hub.db.doQuery.getCall(0).args[1][1], 'DELETE bound = block_time, not reported now')
                .to.equal(blockTime);
            expect(hub.db.doQuery.getCall(1).args[1][0], 'dispute bound = block_time').to.equal(blockTime);
        });

        it('_handleAlert abstains when the timestamp predates the observed block_time', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let blockTime = Date.now() - 60000;
            stubVerified({ blockTimeMs: blockTime });

            let ts = blockTime - rh.timestampSkewToleranceMs - 60000;
            let reorgId = 'BTC:500:' + ts;
            await rh._handleAlert({
                sender: VALIDATORS_4[1].addr,
                data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has(reorgId), 'no round co-signed').to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('_handlePrepare (leader-bypass) abstains when the timestamp predates the observed block_time', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let blockTime = Date.now() - 60000;
            stubVerified({ blockTimeMs: blockTime });

            let ts = blockTime - rh.timestampSkewToleranceMs - 60000;
            let reorgId = 'BTC:500:' + ts;
            let digest = rh._digest(reorgId, 'BTC', 500, ts, OLD_HASH, NEW_HASH);
            await rh._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                        affectedChains: ['LTC', 'DOGE'], digest,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has(reorgId), 'no round joined').to.be.false;
        });

        it('a consensus round carries the observed block_time into the rollback bound', async function () {
            rh.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
            let blockTime = Date.now() - 600000;
            stubVerified({ blockTimeMs: blockTime });

            let ts = Date.now();
            await rh.reportReorg('BTC', 500000, ts, OLD_HASH, NEW_HASH);
            let reorgId = 'BTC:500000:' + ts;
            let pending = rh.pendingReorgs.get(reorgId);
            expect(pending, 'round created').to.exist;
            expect(pending.observedBlockTimeMs).to.equal(blockTime);

            // Drive the round to commit quorum and confirm the executed bound.
            pending.commits.add(VALIDATORS_3[1].addr);
            pending.commits.add(VALIDATORS_3[2].addr);
            rh._checkCommitQuorum(reorgId);
            await new Promise(r => setImmediate(r));
            expect(hub.db.doQuery.getCall(0).args[1][1], 'quorum rollback bound = block_time')
                .to.equal(blockTime);
        });

        it('_handleAlert ignores an alert missing the hash pair (legacy / malformed wire)', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            let verify = stubVerified(true);
            let ts = Date.now();
            await rh._handleAlert({
                sender: VALIDATORS_4[1].addr,
                data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId: 'BTC:500:' + ts }
            });
            expect(rh.pendingReorgs.size).to.equal(0);
            expect(verify.called, 'no probe for a hashless alert').to.be.false;
        });

        it('_handleAlert drops an ALERT whose reorgId is not the canonical chain:height:timestamp (REORG-INBOUND-UNBOUNDED-ROUNDS-1)', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let verify = stubVerified(true);
            let ts = Date.now();
            // Real (chain, height, timestamp) but an attacker-minted reorgId string: without
            // the binding this would create a fresh round (and PREPARE fan-out) per distinct id.
            await rh._handleAlert({
                sender: VALIDATORS_4[1].addr,
                data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId: 'FORGED:' + ts,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.size, 'no round created for a non-canonical reorgId').to.equal(0);
            expect(verify.called, 'dropped before the indexer probe').to.be.false;
        });

        it('_handleAlert abstains at the concurrent-round cap (REORG-INBOUND-UNBOUNDED-ROUNDS-1)', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let verify = stubVerified(true);
            rh.maxPendingReorgs = 1;
            rh.pendingReorgs.set('BTC:1:1', { reorgId: 'BTC:1:1', timer: null });   // at cap
            let ts = Date.now();
            await rh._handleAlert({
                sender: VALIDATORS_4[1].addr,
                data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId: 'BTC:500:' + ts,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has('BTC:500:' + ts), 'no new round past the cap').to.be.false;
            expect(verify.called, 'cap checked before the indexer probe').to.be.false;
        });

        it('_handlePrepare drops a PREPARE whose reorgId is not canonical (REORG-INBOUND-UNBOUNDED-ROUNDS-1)', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let verify = stubVerified(true);
            let ts = Date.now();
            let reorgId = 'FORGED:' + ts;
            let digest = rh._digest(reorgId, 'LTC', 300, ts, OLD_HASH, NEW_HASH);
            await rh._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: ts,
                        affectedChains: ['BTC', 'DOGE'], digest, oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has(reorgId), 'no round for a non-canonical reorgId').to.be.false;
            expect(verify.called, 'dropped before the indexer probe').to.be.false;
        });

        it('reportReorg does NOT consume the rate budget when self-verification fails (REORG-RATELIMIT-BEFORE-VERIFY-1)', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let verify = sinon.stub(rh, '_verifyReorgAgainstOwnNode');
            verify.onFirstCall().resolves(false);   // local node momentarily lagging
            verify.onSecondCall().resolves(true);    // re-synced on the retry
            let ts = Date.now();

            let threw = false;
            try { await rh.reportReorg('BTC', 500000, ts, OLD_HASH, NEW_HASH); }
            catch (e) { threw = true; expect(e.message).to.match(/own indexer does not confirm/); }
            expect(threw, 'the failed report throws').to.be.true;
            expect(rh.reorgRateTracker.has('BTC'), 'a failed verify does not burn the 60s budget').to.be.false;

            // The retry (node now synced) is therefore not rate-limited and broadcasts the ALERT.
            await rh.reportReorg('BTC', 500001, ts + 1, OLD_HASH, NEW_HASH);
            expect(pm.broadcast.getCalls().some(c => c.args[0] === 'REORG_ALERT'),
                'the genuine retry is not blocked by the rate limit').to.be.true;
        });

        it('_handlePrepare (leader-bypass path) abstains when verification fails', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            stubVerified(false);

            let ts = Date.now();
            let reorgId = 'LTC:300:' + ts;
            let digest = rh._digest(reorgId, 'LTC', 300, ts, OLD_HASH, NEW_HASH);
            await rh._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: ts,
                        affectedChains: ['BTC', 'DOGE'], digest,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has(reorgId)).to.be.false;
        });

        it('_handlePrepare recomputes the digest and drops a wire digest that does not match the fields', async function () {
            rh.setValidatorSet(VALIDATORS_4);
            let verify = stubVerified(true);

            let ts = Date.now();
            let reorgId = 'LTC:300:' + ts;
            // Digest computed over a DIFFERENT newHash than the wire fields carry.
            let poisoned = rh._digest(reorgId, 'LTC', 300, ts, OLD_HASH, 'c'.repeat(64));
            await rh._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: ts,
                        affectedChains: ['BTC', 'DOGE'], digest: poisoned,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has(reorgId)).to.be.false;
            expect(verify.called, 'digest mismatch is dropped before probing').to.be.false;
        });

        it('an unverified pending round never commits or rolls back, regardless of votes', async function () {
            rh.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;

            let reorgId = 'BTC:500:123';
            let digest = rh._digest(reorgId, 'BTC', 500, 123, OLD_HASH, NEW_HASH);
            rh.pendingReorgs.set(reorgId, {
                reorgId, chain: 'BTC', reorgHeight: 500, timestamp: 123,
                affectedChains: ['LTC', 'DOGE'], digest, oldHash: OLD_HASH, newHash: NEW_HASH,
                selfVerified: false,
                quorum: 2,
                prepares: new Set([VALIDATORS_3[0].addr, VALIDATORS_3[1].addr]),
                commits: new Set([VALIDATORS_3[0].addr, VALIDATORS_3[1].addr]),
                finalized: false, timer: null
            });

            rh._checkPrepareQuorum(reorgId);
            expect(pm.broadcast.called, 'no COMMIT broadcast for an unverified round').to.be.false;

            rh._checkCommitQuorum(reorgId);
            await new Promise(r => setTimeout(r, 20));
            expect(hub.db.doQuery.called, 'no rollback for an unverified round').to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // _probeOwnNode(): the actual indexer probe
    // -----------------------------------------------------------------

    describe('_probeOwnNode()', function () {

        beforeEach(function () {
            rh.indexers.BTC = { url: 'http://btc-indexer.test', key: '' };
            rh.network = 'regtest';
        });

        // Default reorg history: OLD_HASH was orphaned at height 500 (the honest
        // case). Individual tests override `hist` to exercise the oldHash gate.
        function stubIndexer(tip, at, hist) {
            if (hist === undefined)
                hist = { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: OLD_HASH }] }], count: 1, matched: true };
            return sinon.stub(rh, '_indexerCall').callsFake(async (coin, method, params) => {
                if (method === 'getreorghistory') return hist;
                if (params && params.block_index != null) return at;
                return tip;
            });
        }

        it('abstains (false) without an indexer endpoint', async function () {
            rh.indexers.BTC = { url: '', key: '' };
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        });

        it('confirms when the node serves newHash at reorgHeight on the right network', async function () {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'regtest' });
            let r = await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH);
            expect(r).to.be.ok;
            expect(r.blockTimeMs, 'no block_time served → null anchor (legacy bound)').to.equal(null);
        });

        it('captures the served block_time (seconds) as the ms rollback anchor', async function () {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'regtest', block_time: 1700000000 });
            let r = await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH);
            expect(r).to.be.ok;
            expect(r.blockTimeMs).to.equal(1700000000000);
        });

        it('abstains while the node still serves the pre-reorg hash (lagging sync)', async function () {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: OLD_HASH, network: 'regtest' });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        });

        it('rejects a reorgHeight above the own tip', async function () {
            let ic = stubIndexer({ block_index: 400, block_hash: 'f'.repeat(64), network: 'regtest' }, null);
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
            expect(ic.callCount, 'no second call past the tip bound').to.equal(1);
        });

        it('rejects a reorgHeight deeper than REORG_MAX_DEPTH below the tip', async function () {
            rh.maxReorgDepth = 100;
            let ic = stubIndexer({ block_index: 1000, block_hash: 'f'.repeat(64), network: 'regtest' }, null);
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
            expect(ic.callCount).to.equal(1);
        });

        it('rejects a cross-network (or network-agnostic) answer', async function () {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'mainnet' });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;

            sinon.restore();
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        });

        it('reuses the tip response when reorgHeight IS the tip (single getblockhashes RPC)', async function () {
            let ic = stubIndexer({ block_index: 500, block_hash: NEW_HASH, network: 'regtest' }, null);
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.ok;
            expect(ic.getCalls().filter(c => c.args[1] === 'getblockhashes').length).to.equal(1);
        });

        // REORG-OLDHASH-UNVERIFIED-1 : the "before" half of the reorg.
        it('abstains when reorg history has no event orphaning oldHash at reorgHeight (fabricated oldHash)', async function () {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                        { events: [], count: 0, matched: false });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        });

        it('abstains when a reorg at that height orphaned a DIFFERENT hash', async function () {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                        { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: 'c'.repeat(64) }] }], count: 1 });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        });

        it('abstains when the orphaned-hash match is at a DIFFERENT height in the same event', async function () {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                        { events: [{ id: 1, blocks: [{ block_index: 501, block_hash: OLD_HASH }] }], count: 1 });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        });

        it('accepts a legacy REORG event at that height whose hash is unrecorded (null)', async function () {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                        { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: null }] }], count: 1 });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.ok;
        });

        it('matches an uppercase recorded orphaned hash case-insensitively', async function () {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                        { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: OLD_HASH.toUpperCase() }] }], count: 1 });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.ok;
        });

        it('abstains (never throws) when getreorghistory errors or is unsupported', async function () {
            // App-level error shape ({error}) from an indexer without a ready decoder DB.
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                        { error: 'decoder database not ready' });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;

            // RPC rejection (e.g. an indexer predating getreorghistory).
            sinon.restore();
            sinon.stub(rh, '_indexerCall').callsFake(async (coin, method) => {
                if (method === 'getreorghistory') throw new Error('indexer RPC error: method not found');
                return { block_index: 500, block_hash: NEW_HASH, network: 'regtest' };
            });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        });

        it('skips the reorg-history probe entirely when the served hash already mismatches', async function () {
            let ic = stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                                 { block_index: 500, block_hash: OLD_HASH, network: 'regtest' });
            expect(await rh._probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
            expect(ic.getCalls().some(c => c.args[1] === 'getreorghistory')).to.be.false;
        });

        it('_verifyReorgAgainstOwnNode maps an RPC error to abstain (false), never a throw', async function () {
            sinon.stub(rh, '_indexerCall').rejects(new Error('ECONNREFUSED'));
            expect(await rh._verifyReorgAgainstOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        });

        it('_verifyReorgAgainstOwnNode dedupes concurrent probes for the same observation', async function () {
            let resolveProbe;
            sinon.stub(rh, '_probeOwnNode').callsFake(() => new Promise(res => { resolveProbe = res; }));
            let p1 = rh._verifyReorgAgainstOwnNode('BTC', 500, OLD_HASH, NEW_HASH);
            let p2 = rh._verifyReorgAgainstOwnNode('BTC', 500, OLD_HASH, NEW_HASH);
            resolveProbe(true);
            expect(await p1).to.be.true;
            expect(await p2).to.be.true;
            expect(rh._probeOwnNode.callCount).to.equal(1);
        });
    });

    // -----------------------------------------------------------------
    // _executeRollback()
    // -----------------------------------------------------------------

    describe('_executeRollback()', function () {

        it('deletes attestations for affected chain after a recent timestamp (legacy fallback bound)', async function () {
            let ts = Date.now() - 60000;
            await rh._executeRollback('BTC', 500000, ts, 'reorg-1', 3, '[]');

            let deleteCall = hub.db.doQuery.getCall(0);
            expect(deleteCall.args[0]).to.include('DELETE FROM attestations');
            expect(deleteCall.args[1][0]).to.equal('BTC');
            expect(deleteCall.args[1][1]).to.equal(ts);
        });

        it('anchors the DELETE/UPDATE bound to the observed block_time, not the reported timestamp', async function () {
            // R1 (over/under-rollback): the reporter-supplied timestamp is gameable,
            // so the bound must come from OUR OWN node's block_time for reorgHeight.
            let reported  = Date.now() - 12 * 3600000;   // adversarial far-past report
            let blockTime = Date.now() - 600000;         // the reorged block is 10 min old
            await rh._executeRollback('BTC', 500000, reported, 'reorg-bt', 3, '[]', blockTime);

            expect(hub.db.doQuery.getCall(0).args[1][1], 'attestation DELETE bound').to.equal(blockTime);
            expect(hub.db.doQuery.getCall(1).args[1][0], 'snapshot dispute bound').to.equal(blockTime);
        });

        it('clamps the rollback bound to the lookback floor (blast-radius bound)', async function () {
            let before = Date.now() - rh.maxLookbackMs;
            await rh._executeRollback('BTC', 500000, Date.now(), 'reorg-deep', 3, '[]',
                Date.now() - 3 * rh.maxLookbackMs);      // fabricated deep "reorg" block_time
            let after = Date.now() - rh.maxLookbackMs;

            let bound = hub.db.doQuery.getCall(0).args[1][1];
            expect(bound, 'bound never reaches past the lookback window').to.be.at.least(before);
            expect(bound).to.be.at.most(after);
        });

        it('marks price snapshots as disputed', async function () {
            await rh._executeRollback('BTC', 500000, Date.now() - 60000, 'reorg-1', 3, '[]');

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[0]).to.include("status = 'disputed'");
        });

        it('stores reorg attestation', async function () {
            await rh._executeRollback('BTC', 500000, Date.now() - 60000, 'reorg-1', 3, '["v1","v2","v3"]');

            let insertCall = hub.db.doQuery.getCall(2);
            expect(insertCall.args[0]).to.include('reorg_attestations');
            expect(insertCall.args[1]).to.include('reorg-1');
            expect(insertCall.args[1]).to.include(3); // validator_count
        });

        it('adds reorgId to processed set', async function () {
            await rh._executeRollback('BTC', 500000, Date.now() - 60000, 'reorg-x', 1, '[]');
            expect(rh.processed.has('reorg-x')).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // PBFT reorg flow
    // -----------------------------------------------------------------

    describe('PBFT reorg flow', function () {

        beforeEach(function () {
            rh.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
        });

        it('PREPARE from peer is recorded', async function () {
            let ts = Date.now();
            let reorgId = 'BTC:500:' + ts;
            let digest = rh._digest(reorgId, 'BTC', 500, ts, OLD_HASH, NEW_HASH);

            rh.pendingReorgs.set(reorgId, {
                reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                affectedChains: ['LTC', 'DOGE'], digest,
                oldHash: OLD_HASH, newHash: NEW_HASH, selfVerified: true,
                prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            await rh._handlePrepare({
                sender: VALIDATORS_3[1].addr,
                data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                        affectedChains: ['LTC', 'DOGE'], digest,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });

            expect(rh.pendingReorgs.get(reorgId).prepares.has(VALIDATORS_3[1].addr)).to.be.true;
        });

        it('_handleAlert refuses an out-of-window (old) timestamp and starts no consensus', async function () {
            let ts = 1700000000000; // ~2023, far outside the 24h blast-radius window
            let reorgId = 'BTC:500:' + ts;
            await rh._handleAlert({
                sender: VALIDATORS_3[1].addr,
                data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has(reorgId), 'no pending round for a stale reorg').to.be.false;
            expect(pm.broadcast.called, 'no PREPARE broadcast for a stale reorg').to.be.false;
        });

        it('_handlePrepare refuses to co-sign an out-of-window (old) timestamp', async function () {
            let ts = 1700000000000;
            let reorgId = 'BTC:500:' + ts;
            await rh._handlePrepare({
                sender: VALIDATORS_3[1].addr,
                data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                        affectedChains: ['LTC', 'DOGE'],
                        digest: rh._digest(reorgId, 'BTC', 500, ts, OLD_HASH, NEW_HASH),
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has(reorgId), 'a follower does not create a round for a stale reorg').to.be.false;
        });

        it('PREPARE with wrong digest is rejected', async function () {
            let ts = Date.now();
            let reorgId = 'BTC:500:' + ts;
            let digest = rh._digest(reorgId, 'BTC', 500, ts, OLD_HASH, NEW_HASH);

            rh.pendingReorgs.set(reorgId, {
                reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                affectedChains: ['LTC', 'DOGE'], digest,
                oldHash: OLD_HASH, newHash: NEW_HASH, selfVerified: true,
                prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            await rh._handlePrepare({
                sender: VALIDATORS_3[1].addr,
                data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                        oldHash: OLD_HASH, newHash: NEW_HASH, digest: 'wrong' }
            });

            expect(rh.pendingReorgs.get(reorgId).prepares.size).to.equal(0);
        });

        it('COMMIT quorum executes rollback', async function () {
            let reorgId = 'BTC:500:123';
            let digest = rh._digest(reorgId, 'BTC', 500, 123, OLD_HASH, NEW_HASH);

            rh.pendingReorgs.set(reorgId, {
                reorgId, chain: 'BTC', reorgHeight: 500, timestamp: 123,
                affectedChains: ['LTC', 'DOGE'], digest,
                oldHash: OLD_HASH, newHash: NEW_HASH, selfVerified: true,
                prepares: new Set([VALIDATORS_3[0].addr, VALIDATORS_3[1].addr]),
                commits: new Set([VALIDATORS_3[0].addr]),
                finalized: false, timer: null, _commitSent: true
            });

            let emitted = null;
            rh.on('reorg:confirmed', (d) => { emitted = d; });

            rh._handleCommit({
                sender: VALIDATORS_3[1].addr,
                data: { reorgId, digest }
            });

            await new Promise(r => setTimeout(r, 20));

            expect(hub.db.doQuery.callCount).to.equal(3); // delete + update + insert
            expect(rh.processed.has(reorgId)).to.be.true;
            expect(emitted).to.not.be.null;
        });
    });

    // -----------------------------------------------------------------
    // Consensus timeout: surfaced event (not silent discard)
    //
    // When a reorg round can't reach quorum within the window, the pending
    // rollback used to be dropped with only a console.warn, leaving cross-chain
    // state dirty after a reorg with no programmatic signal. The handler now
    // emits a 'reorg:timeout' event carrying the discarded rollback details
    // before deleting it, so operators/consumers can alert or retry.
    // -----------------------------------------------------------------

    describe('consensus timeout event', function () {

        let clock;

        afterEach(function () {
            if (clock) { clock.restore(); clock = null; }
        });

        it('emits reorg:timeout instead of silently discarding when quorum is not reached', async function () {
            clock = sinon.useFakeTimers({ now: 1700000000000 });
            // N=4 → quorum=3, so a lone self-prepare can't finalize and the round
            // must time out (N=3 would finalize immediately at quorum=1).
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            stubVerified(true);

            let emitted = null;
            rh.on('reorg:timeout', (d) => { emitted = d; });

            await rh.reportReorg('BTC', 500000, 1700000000000, OLD_HASH, NEW_HASH);
            let reorgId = 'BTC:500000:1700000000000';

            // Round is pending, no event yet.
            expect(rh.pendingReorgs.has(reorgId)).to.be.true;
            expect(emitted).to.be.null;

            // Window elapses without quorum → event fires, round discarded.
            clock.tick(rh.timeout + 1);

            expect(emitted).to.not.be.null;
            expect(emitted.reorgId).to.equal(reorgId);
            expect(emitted.sourceChain).to.equal('BTC');
            expect(emitted.reorgHeight).to.equal(500000);
            expect(emitted.affectedChains).to.deep.equal(['LTC', 'DOGE']);
            expect(rh.pendingReorgs.has(reorgId)).to.be.false;
        });

        it('emits reorg:timeout for a follower-created round (PREPARE path) that never reaches quorum', async function () {
            clock = sinon.useFakeTimers({ now: 1700000000000 });
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            stubVerified(true);

            let reorgId = 'LTC:300:1700000000000';
            let digest = rh._digest(reorgId, 'LTC', 300, 1700000000000, OLD_HASH, NEW_HASH);

            let emitted = null;
            rh.on('reorg:timeout', (d) => { emitted = d; });

            // A peer's PREPARE creates the pending round locally.
            await rh._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: 1700000000000,
                        affectedChains: ['BTC', 'DOGE'], digest,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });
            expect(rh.pendingReorgs.has(reorgId)).to.be.true;

            // Follower timer is timeout*2; quorum (3) unreachable → event fires.
            clock.tick(rh.timeout * 2 + 1);

            expect(emitted).to.not.be.null;
            expect(emitted.reorgId).to.equal(reorgId);
            expect(emitted.sourceChain).to.equal('LTC');
            expect(rh.pendingReorgs.has(reorgId)).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // getReorgHistory()
    // -----------------------------------------------------------------

    describe('getReorgHistory()', function () {
        it('queries with limit', async function () {
            hub.db.doQuery.resolves([]);
            await rh.getReorgHistory(10);
            expect(hub.db.doQuery.getCall(0).args[1]).to.deep.equal([10]);
        });

        it('defaults to 50', async function () {
            hub.db.doQuery.resolves([]);
            await rh.getReorgHistory();
            expect(hub.db.doQuery.getCall(0).args[1]).to.deep.equal([50]);
        });
    });

    // -----------------------------------------------------------------
    // start() / stop() + dispatch
    // -----------------------------------------------------------------

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

    describe('_handleMessage dispatch', function () {
        it('routes alert / prepare / commit and ignores unknown types', async function () {
            let a = sinon.spy(rh, '_handleAlert');
            let p = sinon.spy(rh, '_handlePrepare');
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
            expect(() => pm.emit('message', { type: 'REORG_ALERT', data: {} })).to.not.throw();
            await new Promise(r => setTimeout(r, 10));
            await rh.stop();
        });
    });

    // -----------------------------------------------------------------
    // _handleAlert()
    // -----------------------------------------------------------------

    describe('_handleAlert()', function () {
        beforeEach(function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('ignores an alert with missing fields', async function () {
            await rh._handleAlert({ sender: 'peer', data: { chain: 'BTC' } });
            expect(rh.pendingReorgs.size).to.equal(0);
        });

        it('ignores an alert for an already-processed reorg', async function () {
            rh.processed.add('BTC:5:1700000000000');
            await rh._handleAlert({ sender: 'peer', data: { chain: 'BTC', reorgHeight: 5, timestamp: 1700000000000, reorgId: 'BTC:5:1700000000000', oldHash: OLD_HASH, newHash: NEW_HASH } });
            expect(rh.pendingReorgs.size).to.equal(0);
        });

        it('starts consensus for a new (verified) reorg alert', async function () {
            stubVerified(true);
            let ts = Date.now();
            let reorgId = 'BTC:5:' + ts;
            let init = sinon.spy(rh, '_initiateReorgConsensus');
            await rh._handleAlert({ sender: 'peer', data: { chain: 'BTC', reorgHeight: 5, timestamp: ts, reorgId, oldHash: OLD_HASH, newHash: NEW_HASH } });
            expect(init.calledOnce).to.be.true;
            let p = rh.pendingReorgs.get(reorgId);
            if (p && p.timer) clearTimeout(p.timer);
        });
    });

    // -----------------------------------------------------------------
    // Commit-quorum rollback error path
    // -----------------------------------------------------------------

    describe('reportReorg() validation', function () {
        it('rejects an unsupported chain', async function () {
            try { await rh.reportReorg('ETH', 5, Date.now(), OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('Invalid chain'); }
        });

        it('rejects a negative / non-integer reorgHeight', async function () {
            try { await rh.reportReorg('BTC', -1, Date.now(), OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('non-negative integer'); }
        });

        it('rejects a negative timestamp', async function () {
            try { await rh.reportReorg('BTC', 5, -1, OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('non-negative number'); }
        });

        it('rejects a timestamp too far in the future', async function () {
            try { await rh.reportReorg('BTC', 5, Date.now() + 600000, OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('future'); }
        });

        it('enforces the per-chain rate limit', async function () {
            rh.reorgRateTracker.set('BTC', Date.now());
            try { await rh.reportReorg('BTC', 5, Date.now(), OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('Rate limit'); }
        });

        it('_initiateReorgConsensus is a no-op for an already-pending reorg', function () {
            rh.pendingReorgs.set('r1', { timer: null });
            rh._initiateReorgConsensus('r1', 'BTC', 5, 1, ['LTC', 'DOGE'], OLD_HASH, NEW_HASH);
            expect(rh.pendingReorgs.get('r1')).to.deep.equal({ timer: null });
        });
    });

    describe('_checkCommitQuorum() rollback failure', function () {
        it('logs and clears the pending reorg when rollback execution throws', async function () {
            sinon.stub(rh, '_executeRollback').rejects(new Error('db down'));
            rh.pendingReorgs.set('BTC:5:1', {
                chain: 'BTC', reorgHeight: 5, timestamp: 1,
                prepares: new Set(['a', 'b']), commits: new Set(['a', 'b']),
                finalized: false, timer: null, quorum: 2, digest: 'd', selfVerified: true
            });
            rh._checkCommitQuorum('BTC:5:1');
            await new Promise(r => setTimeout(r, 20));
            expect(rh.pendingReorgs.has('BTC:5:1')).to.be.false;
        });
    });
});
