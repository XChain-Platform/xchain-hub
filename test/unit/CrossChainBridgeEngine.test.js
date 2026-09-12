/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * CrossChainBridgeEngine: the XBRIDGE transfer record and the XPOLICY token
 * policy snapshot. Covers the two signed canonicals and their id preimages, the
 * activation gates, the issuer-raised confirmation depth, independent follower
 * re-verification, the fail-closed write path, the fenced retraction and the
 * invariant read.
 *
 * The canonicals and the id preimages are CONSENSUS: an indexer rebuilds them
 * byte for byte from the mirrored row to verify the quorum's signatures, so the
 * assertions here spell the strings out in full rather than re-deriving them
 * from the code under test (a test that calls the same builder proves only that
 * the builder is deterministic).
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const crypto     = require('crypto');

const CrossChainBridgeEngine = require('../../src/CrossChainBridgeEngine.js');
const Database               = require('../../src/db.js');
const eq                     = require('../../src/equivocation_header.js');

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// A Database carrying the REAL bridge methods over a recording driver, so the
// column lists, the INSERT IGNORE and the retracted-row revive are exercised as
// written instead of being stubbed away.
function memDb(){
    const calls = [];
    const state = { insertAffected: 1, reviveAffected: 0, pairs: [], inflight: [], seq: 0, atSeq: null, exists: false, rows: [] };
    const db = Object.create(Database.prototype);
    db.calls = calls;
    db.state = state;
    db.doQuery = async function(sql, params){
        calls.push({ sql, params: params || [] });
        if(sql.startsWith('INSERT IGNORE INTO bridge_transfers')) return { affectedRows: state.insertAffected };
        if(sql.startsWith("UPDATE bridge_transfers SET status = 'finalized'")) return { affectedRows: state.reviveAffected };
        if(sql.startsWith('INSERT IGNORE INTO policy_snapshots')) return { affectedRows: state.insertAffected };
        if(sql.startsWith('SELECT MAX(policy_seq)')) return [{ seq: state.seq }];
        if(sql.startsWith('SELECT snapshot_id, policy_hash')) return state.atSeq ? [state.atSeq] : [];
        if(sql.startsWith('SELECT DISTINCT tick, src_chain, dest_chain')) return state.pairs;
        if(sql.startsWith('SELECT tick, dest_chain, amount FROM bridge_transfers')) return state.inflight;
        if(sql.startsWith('SELECT 1 FROM bridge_transfers')) return state.exists ? [{ 1: 1 }] : [];
        if(sql.startsWith('SELECT transfer_id FROM bridge_transfers WHERE')) return state.rows;
        if(sql.startsWith("UPDATE bridge_transfers SET status = 'retracted'")) return { affectedRows: 1 };
        if(sql.startsWith('SELECT * FROM bridge_transfers WHERE transfer_id')) return [{ transfer_id: params[0] }];
        if(sql.startsWith('SELECT * FROM policy_snapshots WHERE snapshot_id')) return [{ snapshot_id: params[0] }];
        return [];
    };
    db.getChainTip = async () => ({ chainId: 'f'.repeat(64) });
    return db;
}

function makeEngine(opts){
    opts = opts || {};
    const db = memDb();
    const broadcaster = { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub(), dropAllForResync: sinon.stub() };
    const hub = {
        db,
        network: opts.network || 'regtest',
        p2pConfig: { BTC_INDEXER_URL: 'http://btc', DOGE_INDEXER_URL: 'http://doge', LTC_INDEXER_URL: 'http://ltc' },
        hubDbBroadcaster: broadcaster,
        capabilitySnapshot: {
            async getSnapshot(){ return { validators: [{ pubkey: 'a'.repeat(64), amount: '1' }] }; },
            async getWeightSnapshot(){
                return { validators: [{ pubkey: 'a'.repeat(64), source: 's1', weight: '1' }], count: 1, sourceCount: 1 };
            }
        },
        getPeerManager: () => null,
        getIdentity:    () => null,
        _resolveBtcLatestBlock: async () => (opts.btcBlock === undefined ? 150 : opts.btcBlock)
    };
    const engine = new CrossChainBridgeEngine(hub);
    // Never gossip or run a real round in a unit test.
    const stubConsensus = () => ({ propose: sinon.stub().resolves(), start: sinon.stub(), stop: sinon.stub(),
                                   on: () => {}, forgetFinalized: sinon.stub() });
    engine.transferConsensus = stubConsensus();
    engine.policyConsensus   = stubConsensus();
    // The flag-day twins ARE vendored beside the engine, so the real predicates load and a
    // regtest hub is armed at every height. Replace them anyway: a unit test that wants an
    // armed gate must say so, and `gates: false` must mean the twin is UNREADABLE (both
    // predicates null), which is the fail-closed case, not merely "not yet reached".
    engine.activation = (opts.gates === false)
        ? { bridge: null, token: null, policy: null }
        : {
            bridge: () => opts.bridgeActive !== false,
            token:  () => opts.tokenActive  !== false,
            policy: () => opts.policyActive !== false
        };
    return { engine, db, broadcaster, hub };
}

// A getpendingbridgetransfers leg, the seam's PendingBridgeTransfer shape.
function pendingLeg(over){
    return Object.assign({
        transfer_kind: 'lock', src_chain: 'BTC', src_action_index: 41,
        src_address: 'mSrcAddress', dest_chain: 'DOGE', dest_address: 'nDestAddress',
        tick: 'XCHAIN', decimals: 8, amount: '5.00000000', min_depth: 0,
        block_index: 100, confirmations: 6, tx_hash: 'd'.repeat(64), push_generation: 0
    }, over);
}

describe('CrossChainBridgeEngine', function(){

    afterEach(function(){ sinon.restore(); });

    // ---------------------------------------------------------------------
    describe('signed canonicals and id preimages', function(){

        it('builds the XBRIDGE transfer canonical exactly as the spec spells it', function(){
            const { engine } = makeEngine();
            const row = {
                transfer_id: 'b'.repeat(64), snapshot_block: 150, tick: 'XCHAIN', decimals: 8,
                src_chain: 'BTC', src_action_index: 41, src_address: 'mSrc',
                dest_chain: 'DOGE', dest_address: 'nDest', amount: '5.00000000',
                effective_time: 1757000000, network: 'regtest'
            };
            const raw = 'XBRIDGE|' + 'b'.repeat(64) + '|150|XCHAIN|8|BTC|41|mSrc|DOGE|nDest|5.00000000|1757000000|regtest';
            // regtest EQUIV activation is 0, so the wrap is unconditional on this venue.
            expect(eq.isEquivHeaderActive(150, 'regtest')).to.equal(true);
            expect(engine._canonicalMatch(row, 3))
                .to.equal('EQUIV|XBRIDGE|' + 'b'.repeat(64) + '|3||' + raw);
        });

        it('builds the XPOLICY snapshot canonical exactly as the spec spells it', function(){
            const { engine } = makeEngine();
            const row = {
                snapshot_id: 'c'.repeat(64), snapshot_block: 150, origin_chain: 'BTC', tick: 'FUFU',
                policy_seq: 2, origin_block: 900, policy_hash: 'e'.repeat(64),
                effective_time: 1757000000, network: 'regtest'
            };
            const raw = 'XPOLICY|' + 'c'.repeat(64) + '|150|BTC|FUFU|2|900|' + 'e'.repeat(64) + '|1757000000|regtest';
            expect(engine._canonicalMatch(row, 0))
                .to.equal('EQUIV|XPOLICY|' + 'c'.repeat(64) + '|0||' + raw);
        });

        it('refuses a row that carries both ids or neither, rather than guessing a family', function(){
            const { engine } = makeEngine();
            expect(() => engine._canonicalMatch({ transfer_id: 'a', snapshot_id: 'b' }, 0)).to.throw(/exactly one/);
            expect(() => engine._canonicalMatch({ snapshot_block: 1 }, 0)).to.throw(/exactly one/);
        });

        it('derives transfer_id and snapshot_id from the spec preimages', function(){
            const { engine } = makeEngine();
            expect(engine._deriveTransferId('regtest', 'BTC', 41, 'DOGE', 'nDest', 150))
                .to.equal(sha256('regtest|BTC:41|DOGE:nDest|150'));
            expect(engine._deriveSnapshotId('regtest', 'BTC', 'FUFU', 2, 150))
                .to.equal(sha256('regtest|BTC:FUFU|2|150'));
        });

        it('hashes a policy membership, telling "no list" apart from "an empty list"', function(){
            const { engine } = makeEngine();
            expect(engine._policyHash(null, null, false)).to.equal(sha256('ALLOW|-|BLOCK|-|SLEEP|0'));
            expect(engine._policyHash([], null, false)).to.equal(sha256('ALLOW|0|BLOCK|-|SLEEP|0'));
            // The two must differ: an empty ALLOW list denies everyone under isActionAllowed,
            // while no list at all denies nobody, and a copy has to be able to tell them apart.
            expect(engine._policyHash([], null, false)).to.not.equal(engine._policyHash(null, null, false));
            expect(engine._policyHash(['mA', 'mB'], ['nC'], true))
                .to.equal(sha256('ALLOW|2|mA|mB|BLOCK|1|nC|SLEEP|1'));
        });

        it('reads canonical membership order as BYTES, not UTF-16 code units', function(){
            const { engine } = makeEngine();
            expect(engine._isCanonicalOrder(['a', 'b', 'c'])).to.equal(true);
            expect(engine._isCanonicalOrder(['b', 'a'])).to.equal(false);
            expect(engine._isCanonicalOrder(['a', 'a'])).to.equal(false);   // strictly ascending
            expect(engine._isCanonicalOrder(null)).to.equal(true);
        });
    });

    // ---------------------------------------------------------------------
    describe('activation gates', function(){

        it('idles with no flag-day module readable, rather than signing ungated', async function(){
            const { engine } = makeEngine({ gates: false });
            engine._indexerCall = sinon.stub().resolves({
                latest_block_index: 200, network: 'regtest', transfers: [pendingLeg()]
            });
            await engine._poll();
            expect(engine._indexerCall.called).to.equal(false);
            expect(engine.transferConsensus.propose.called).to.equal(false);
        });

        it('polls once the bridge gate is armed', async function(){
            const { engine } = makeEngine();
            engine._indexerCall = sinon.stub().resolves({
                latest_block_index: 200, network: 'regtest', transfers: []
            });
            await engine._poll();
            expect(engine._indexerCall.called).to.equal(true);
        });

        // Row 28: XCHAIN_BRIDGE_ACTIVATION is keyed '<COIN>:<network>', because BTC, LTC and
        // DOGE reach the flag day at three heights that are not comparable. The poll's own
        // gate reads the BTC-anchored snapshot block, so without a per-leg gate the hub would
        // start signing LTC and DOGE legs the instant BTC crossed. The predicate is replaced
        // with a coin-aware stand-in (the vendored twin answers the same for every coin on
        // regtest, which no coin-blind call could be told apart from), and the leg's OWN
        // height and chain are what it must be handed.
        it('gates a leg on the source chain\'s own flag day, not on BTC\'s', async function(){
            const { engine } = makeEngine();
            const seen = [];
            engine.activation.bridge = (block, network, coin) => {
                seen.push(String(coin) + '@' + String(block));
                return (coin === 'DOGE') ? Number(block) >= 500 : true;
            };

            // DOGE below its own instant: refused, even though BTC (the snapshot anchor) is armed.
            await engine._maybeFinalizeTransfer('DOGE', 'regtest', 200, 150,
                pendingLeg({ transfer_kind: 'burn', src_chain: 'DOGE', dest_chain: 'BTC', block_index: 100 }));
            expect(engine.transferConsensus.propose.called).to.equal(false);
            expect(seen).to.include('DOGE@100');

            // A BTC leg at the very same height is signed: the refusal above was the CHAIN,
            // not the height.
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({ block_index: 100 }));
            expect(engine.transferConsensus.propose.calledOnce).to.equal(true);

            // And DOGE at its own instant goes through.
            await engine._maybeFinalizeTransfer('DOGE', 'regtest', 700, 150,
                pendingLeg({ transfer_kind: 'burn', src_chain: 'DOGE', dest_chain: 'BTC',
                             block_index: 600, src_action_index: 43 }));
            expect(engine.transferConsensus.propose.callCount).to.equal(2);
        });

        // The follower half of the same rule. A proposer that gated per chain and a validator
        // that did not would disagree across the boundary, which is the one place a bridge
        // cannot afford to: the validator must refuse a leg from a chain still below its own
        // instant rather than accept it because the BTC anchor is past.
        it('refuses to validate a proposed row whose source chain is below its own flag day', async function(){
            const { engine } = makeEngine();
            engine.activation.bridge = (block, network, coin) => (coin === 'DOGE') ? Number(block) >= 500 : true;
            engine._indexerCall = sinon.stub().resolves({
                latest_block_index: 200, network: 'regtest',
                transfers: [pendingLeg({ transfer_kind: 'burn', src_chain: 'DOGE', dest_chain: 'BTC',
                                         block_index: 100 })]
            });
            const row = {
                transfer_id: engine._deriveTransferId('regtest', 'DOGE', 41, 'BTC', 'nDestAddress', 150),
                snapshot_block: 150, tick: 'XCHAIN', decimals: 8,
                src_chain: 'DOGE', src_action_index: 41, src_address: 'mSrcAddress',
                dest_chain: 'BTC', dest_address: 'nDestAddress', amount: '5.00000000',
                effective_time: 1757000000, network: 'regtest', push_generation: 0
            };
            expect(await engine._validateTransfer(row)).to.equal(false);

            // The positive control, without which the refusal above would pass against a
            // row rejected for some entirely different reason: arm DOGE at its own height
            // and the identical row validates.
            engine.activation.bridge = () => true;
            expect(await engine._validateTransfer(row)).to.equal(true);
        });

        it('holds a non-XCHAIN leg behind the token gate while XCHAIN rides the bridge gate', async function(){
            const { engine } = makeEngine({ tokenActive: false });
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({ tick: 'FUFU' }));
            expect(engine.transferConsensus.propose.called).to.equal(false);
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg());
            expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
        });
    });

    // ---------------------------------------------------------------------
    describe('confirmation depth (the issuer-raised MIN_DEPTH)', function(){

        it('raises the platform depth and never lowers it', function(){
            const { engine } = makeEngine();
            expect(engine.confirmations.BTC).to.equal(6);
            expect(engine._effectiveDepth('BTC', 0)).to.equal(6);     // unset
            expect(engine._effectiveDepth('BTC', 3)).to.equal(6);     // below platform: no lowering
            expect(engine._effectiveDepth('BTC', 20)).to.equal(20);   // above platform: raised
        });

        it('holds a leg below its effective depth and proposes at it', async function(){
            const { engine } = makeEngine();
            // BTC floor is 6: block 100 at latest 104 is depth 5.
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 104, 150, pendingLeg());
            expect(engine.transferConsensus.propose.called).to.equal(false);
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 105, 150, pendingLeg());
            expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
        });

        it('holds a MIN_DEPTH=20 leg that clears the platform floor', async function(){
            const { engine } = makeEngine();
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 110, 150, pendingLeg({ min_depth: 20 }));
            expect(engine.transferConsensus.propose.called).to.equal(false);
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 119, 150, pendingLeg({ min_depth: 20 }));
            expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
        });
    });

    // ---------------------------------------------------------------------
    describe('proposing a transfer record', function(){

        it('stamps the record the spec describes and reserves the round', async function(){
            const { engine } = makeEngine();
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg());
            const [roundId, ctx] = engine.transferConsensus.propose.firstCall.args;
            expect(roundId).to.equal(sha256('regtest|BTC:41|DOGE:nDestAddress|150'));
            expect(ctx.row.transfer_id).to.equal(roundId);
            expect(ctx.row.tick).to.equal('XCHAIN');
            expect(ctx.row.decimals).to.equal(8);
            expect(ctx.row.snapshot_block).to.equal(150);
            expect(ctx.row.src_chain).to.equal('BTC');
            expect(ctx.row.dest_chain).to.equal('DOGE');
            // Forward margin sized to the gating (destination) chain, DOGE: 4 x 60 s.
            expect(ctx.row.effective_time - Math.floor(Date.now() / 1000)).to.be.closeTo(240, 5);
            expect(engine._inflight.has(roundId)).to.equal(true);
        });

        it('never proposes a same-chain, unknown-chain, zero-amount or already-recorded leg', async function(){
            const { engine, db } = makeEngine();
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({ dest_chain: 'BTC' }));
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({ dest_chain: 'XRP' }));
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({ amount: '0' }));
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({ transfer_kind: 'settle' }));
            expect(engine.transferConsensus.propose.called).to.equal(false);
            db.state.exists = true;
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg());
            expect(engine.transferConsensus.propose.called).to.equal(false);
        });

        it('learns a tick origin from the leg kind: a lock is mined where the token is native', async function(){
            const { engine } = makeEngine();
            await engine._maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({ tick: 'FUFU' }));
            expect(engine._tickOrigin.get('regtest|FUFU')).to.equal('BTC');
            await engine._maybeFinalizeTransfer('DOGE', 'regtest', 200, 150,
                pendingLeg({ tick: 'PEPE', transfer_kind: 'burn', src_chain: 'DOGE', dest_chain: 'BTC', src_action_index: 7 }));
            expect(engine._tickOrigin.get('regtest|PEPE')).to.equal('BTC');
        });
    });

    // ---------------------------------------------------------------------
    describe('follower verification of a proposed transfer', function(){

        function proposedRow(engine, over){
            const now = Math.floor(Date.now() / 1000);
            const row = Object.assign({
                snapshot_block: 150, network: 'regtest', src_chain: 'BTC', src_action_index: 41,
                src_address: 'mSrcAddress', dest_chain: 'DOGE', dest_address: 'nDestAddress',
                tick: 'XCHAIN', decimals: 8, amount: '5.00000000',
                effective_time: now + 240, push_generation: 0
            }, over);
            row.transfer_id = over && over.transfer_id ? over.transfer_id :
                engine._deriveTransferId(row.network, row.src_chain, row.src_action_index,
                                         row.dest_chain, row.dest_address, row.snapshot_block);
            return row;
        }

        function withLeg(engine, leg){
            engine._indexerCall = sinon.stub().resolves({
                latest_block_index: 200, network: 'regtest',
                transfers: [leg === null ? pendingLeg({ src_action_index: 999 }) : pendingLeg(leg)]
            });
        }

        it('co-signs a record its own indexer confirms field for field', async function(){
            const { engine } = makeEngine();
            withLeg(engine, {});
            expect(await engine.validateProposedMatch(proposedRow(engine))).to.equal(true);
        });

        it('refuses a record whose signed fields do not match its own view', async function(){
            const { engine } = makeEngine();
            for(const over of [{ amount: '6.00000000' }, { dest_address: 'nOther' }, { tick: 'FUFU' },
                               { decimals: 2 }, { src_address: 'mOther' }]){
                withLeg(engine, {});
                // eslint-disable-next-line no-await-in-loop
                expect(await engine.validateProposedMatch(proposedRow(engine, over)),
                       'must refuse ' + JSON.stringify(over)).to.equal(false);
            }
        });

        it('pins push_generation to its own indexer view, so an inflated fence cannot be signed', async function(){
            const { engine } = makeEngine();
            withLeg(engine, { push_generation: 0 });
            expect(await engine.validateProposedMatch(proposedRow(engine, { push_generation: 9 }))).to.equal(false);
        });

        it('refuses a leader-chosen effective_time outside the propagation window', async function(){
            const { engine } = makeEngine();
            const now = Math.floor(Date.now() / 1000);
            withLeg(engine, {});
            expect(await engine.validateProposedMatch(proposedRow(engine, { effective_time: now + 5 }))).to.equal(false);
            withLeg(engine, {});
            expect(await engine.validateProposedMatch(proposedRow(engine, { effective_time: now + 7200 }))).to.equal(false);
        });

        it('refuses a non-canonical integer spelling before any numeric comparison', async function(){
            const { engine } = makeEngine();
            withLeg(engine, {});
            expect(await engine.validateProposedMatch(proposedRow(engine, { src_action_index: '041' }))).to.equal(false);
        });

        it('refuses a transfer_id that does not re-derive, and a leg it cannot see', async function(){
            const { engine } = makeEngine();
            withLeg(engine, {});
            expect(await engine.validateProposedMatch(proposedRow(engine, { transfer_id: 'f'.repeat(64) }))).to.equal(false);
            withLeg(engine, null);
            expect(await engine.validateProposedMatch(proposedRow(engine))).to.equal(false);
        });

        it('refuses a record anchored far from its own BTC tip view', async function(){
            const { engine } = makeEngine();
            withLeg(engine, {});
            expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: 9000 }))).to.equal(false);
        });

        it('refuses a leg its own indexer does not yet hold at the effective depth', async function(){
            const { engine } = makeEngine();
            engine._indexerCall = sinon.stub().resolves({
                latest_block_index: 103, network: 'regtest', transfers: [pendingLeg()]
            });
            expect(await engine.validateProposedMatch(proposedRow(engine))).to.equal(false);
        });
    });

    // ---------------------------------------------------------------------
    describe('policy snapshots', function(){

        const ALLOW = null;
        const BLOCK = ['nBlockedOne', 'nBlockedTwo'];

        function withPolicy(engine, over){
            const policy = Object.assign({
                allow_list: ALLOW, block_list: BLOCK, sleeping: false, bridged: true, origin_block: 900
            }, over || {});
            if(policy.policy_hash === undefined)
                policy.policy_hash = engine._policyHash(policy.allow_list, policy.block_list, policy.sleeping);
            engine._indexerCall = sinon.stub().callsFake(async (coin, method) => {
                if(method === 'getlatestblock') return { block_index: 906 };
                if(method === 'gettokenpolicy') return policy;
                return null;
            });
            return policy;
        }

        it('signs the first snapshot of a token at seq 1 with the membership as transport', async function(){
            const { engine } = makeEngine();
            const policy = withPolicy(engine);
            engine._tickOrigin.set('regtest|FUFU', 'BTC');
            await engine._maybeSnapshotPolicy({ origin_chain: 'BTC', tick: 'FUFU', copies: new Set(['DOGE']) }, 'regtest', 150);
            const [roundId, ctx] = engine.policyConsensus.propose.firstCall.args;
            expect(ctx.row.policy_seq).to.equal(1);
            expect(ctx.row.origin_block).to.equal(900);   // 906 tip minus BTC depth 6
            expect(ctx.row.policy_hash).to.equal(policy.policy_hash);
            expect(ctx.row.allow_list).to.equal(null);
            expect(JSON.parse(ctx.row.block_list)).to.deep.equal(BLOCK);
            expect(roundId).to.equal(sha256('regtest|BTC:FUFU|1|150'));
        });

        it('signs nothing when the policy has not changed, and seq+1 when it has', async function(){
            const { engine, db } = makeEngine();
            const policy = withPolicy(engine);
            db.state.seq = 4;
            db.state.atSeq = { policy_hash: policy.policy_hash };
            await engine._maybeSnapshotPolicy({ origin_chain: 'BTC', tick: 'FUFU', copies: new Set() }, 'regtest', 150);
            expect(engine.policyConsensus.propose.called).to.equal(false);
            db.state.atSeq = { policy_hash: 'a'.repeat(64) };
            await engine._maybeSnapshotPolicy({ origin_chain: 'BTC', tick: 'FUFU', copies: new Set() }, 'regtest', 150);
            expect(engine.policyConsensus.propose.firstCall.args[1].row.policy_seq).to.equal(5);
        });

        it('declines to sign a membership over XPOLICY_MAX_MEMBERS', async function(){
            const { engine } = makeEngine();
            const big = [];
            for(let i = 0; i < 10001; i++) big.push('addr' + String(i).padStart(6, '0'));
            withPolicy(engine, { block_list: big });
            await engine._maybeSnapshotPolicy({ origin_chain: 'BTC', tick: 'FUFU', copies: new Set() }, 'regtest', 150);
            expect(engine.policyConsensus.propose.called).to.equal(false);
        });

        it('declines to sign when the indexer answer does not hash to its own policy_hash', async function(){
            const { engine } = makeEngine();
            withPolicy(engine, { policy_hash: 'b'.repeat(64) });
            await engine._maybeSnapshotPolicy({ origin_chain: 'BTC', tick: 'FUFU', copies: new Set() }, 'regtest', 150);
            expect(engine.policyConsensus.propose.called).to.equal(false);
        });

        it('declines to sign an out-of-canonical-order membership rather than re-sorting it', async function(){
            const { engine } = makeEngine();
            withPolicy(engine, { block_list: ['nZ', 'nA'], policy_hash: undefined });
            await engine._maybeSnapshotPolicy({ origin_chain: 'BTC', tick: 'FUFU', copies: new Set() }, 'regtest', 150);
            expect(engine.policyConsensus.propose.called).to.equal(false);
        });

        it('abstains, never refuses, when its origin indexer read fails', async function(){
            const { engine } = makeEngine();
            engine._indexerCall = sinon.stub().rejects(new Error('ECONNREFUSED'));
            await engine._maybeSnapshotPolicy({ origin_chain: 'BTC', tick: 'FUFU', copies: new Set() }, 'regtest', 150);
            expect(engine.policyConsensus.propose.called).to.equal(false);
        });

        describe('follower verification', function(){

            function proposedPolicy(engine, over){
                const now  = Math.floor(Date.now() / 1000);
                const hash = engine._policyHash(ALLOW, BLOCK, false);
                const row = Object.assign({
                    snapshot_block: 150, network: 'regtest', origin_chain: 'BTC', tick: 'FUFU',
                    policy_seq: 1, origin_block: 900, policy_hash: hash,
                    allow_list: null, block_list: JSON.stringify(BLOCK), sleeping: 0,
                    effective_time: now + 2400
                }, over);
                row.snapshot_id = (over && over.snapshot_id) ? over.snapshot_id :
                    engine._deriveSnapshotId(row.network, row.origin_chain, row.tick, row.policy_seq, row.snapshot_block);
                return row;
            }

            it('co-signs a snapshot its own read at the same origin_block reproduces', async function(){
                const { engine } = makeEngine();
                withPolicy(engine);
                expect(await engine.validateProposedMatch(proposedPolicy(engine))).to.equal(true);
            });

            it('refuses when its own read at the same origin_block yields a different hash', async function(){
                const { engine } = makeEngine();
                withPolicy(engine, { block_list: ['nOther'], policy_hash: undefined });
                expect(await engine.validateProposedMatch(proposedPolicy(engine))).to.equal(false);
            });

            it('refuses transport arrays that do not hash to the agreed policy_hash', async function(){
                const { engine } = makeEngine();
                withPolicy(engine);
                expect(await engine.validateProposedMatch(
                    proposedPolicy(engine, { block_list: JSON.stringify(['nBlockedOne']) }))).to.equal(false);
                withPolicy(engine);
                expect(await engine.validateProposedMatch(
                    proposedPolicy(engine, { block_list: 'not json' }))).to.equal(false);
            });

            it('refuses a second content at a seq it already finalized (that is equivocation)', async function(){
                const { engine, db } = makeEngine();
                withPolicy(engine);
                db.state.atSeq = { policy_hash: 'd'.repeat(64) };
                expect(await engine.validateProposedMatch(proposedPolicy(engine))).to.equal(false);
            });

            it('refuses a snapshot_id that does not re-derive', async function(){
                const { engine } = makeEngine();
                withPolicy(engine);
                expect(await engine.validateProposedMatch(
                    proposedPolicy(engine, { snapshot_id: 'e'.repeat(64) }))).to.equal(false);
            });

            it('refuses every policy round while the inheritance gate is closed', async function(){
                const { engine } = makeEngine({ policyActive: false });
                withPolicy(engine);
                expect(await engine.validateProposedMatch(proposedPolicy(engine))).to.equal(false);
            });
        });
    });

    // ---------------------------------------------------------------------
    describe('the write path is fail-closed', function(){

        function finalized(engine, over){
            return Object.assign({
                transfer_id: 'b'.repeat(64), snapshot_block: 150, network: 'regtest',
                src_chain: 'BTC', src_action_index: 41, src_address: 'mSrc',
                dest_chain: 'DOGE', dest_address: 'nDest', tick: 'XCHAIN', decimals: 8,
                amount: '5.00000000', effective_time: 1757000000, push_generation: 0
            }, over);
        }

        it('writes and mirrors a finalized transfer once the capability snapshot is persisted', async function(){
            const { engine, db, broadcaster } = makeEngine();
            engine._persistCapabilitySnapshot = sinon.stub().resolves(1);
            const row = finalized(engine);
            engine._inflight.add(row.transfer_id);
            await engine._writeFinalizedTransfer({ row, signatures: [{ pubkey: 'a', sig: 'b' }], view: 2 });
            const insert = db.calls.find(c => c.sql.startsWith('INSERT IGNORE INTO bridge_transfers'));
            expect(insert, 'the record must be written').to.not.equal(undefined);
            // The signed content plus the two fences and the transport chain id.
            expect(insert.sql).to.contain('tick, decimals, amount');
            expect(insert.params[insert.params.length - 1]).to.equal('f'.repeat(64));  // btc_chain_id
            expect(row.finalizing_view).to.equal(2);
            expect(broadcaster.broadcastRow.calledWithMatch({ table: 'bridge_transfers' })).to.equal(true);
            expect(engine._inflight.has(row.transfer_id)).to.equal(false);
        });

        it('writes NOTHING when the capability snapshot degrades to zero rows', async function(){
            const { engine, db, broadcaster } = makeEngine();
            engine._persistCapabilitySnapshot = sinon.stub().resolves(0);
            const row = finalized(engine);
            engine._inflight.add(row.transfer_id);
            await engine._writeFinalizedTransfer({ row, signatures: [], view: 0 });
            expect(db.calls.some(c => c.sql.startsWith('INSERT IGNORE INTO bridge_transfers'))).to.equal(false);
            expect(broadcaster.broadcastRow.called).to.equal(false);
            // Deferred, not retired: the next poll must be able to re-propose it.
            expect(engine._inflight.has(row.transfer_id)).to.equal(false);
            expect(engine.transferConsensus.forgetFinalized.calledWith(row.transfer_id)).to.equal(true);
        });

        it('revives a retracted record rather than stranding a re-formed transfer', async function(){
            const { engine, db, broadcaster } = makeEngine();
            engine._persistCapabilitySnapshot = sinon.stub().resolves(1);
            db.state.insertAffected = 0;      // INSERT IGNORE no-ops against the retracted row
            db.state.reviveAffected = 1;
            await engine._writeFinalizedTransfer({ row: finalized(engine), signatures: [], view: 0 });
            const revive = db.calls.find(c => c.sql.startsWith("UPDATE bridge_transfers SET status = 'finalized'"));
            expect(revive, 'a retracted row must be revived').to.not.equal(undefined);
            expect(revive.sql).to.contain("status = 'retracted'");
            expect(broadcaster.broadcastRow.calledWithMatch({ table: 'bridge_transfers' })).to.equal(true);
        });

        it('mirrors nothing on a duplicate finalize', async function(){
            const { engine, db, broadcaster } = makeEngine();
            engine._persistCapabilitySnapshot = sinon.stub().resolves(1);
            db.state.insertAffected = 0;
            db.state.reviveAffected = 0;      // the row is already 'finalized'
            await engine._writeFinalizedTransfer({ row: finalized(engine), signatures: [], view: 0 });
            expect(broadcaster.broadcastRow.called).to.equal(false);
        });

        it('writes a finalized policy snapshot append-only, with no revive path', async function(){
            const { engine, db, broadcaster } = makeEngine();
            engine._persistCapabilitySnapshot = sinon.stub().resolves(1);
            const row = {
                snapshot_id: 'c'.repeat(64), snapshot_block: 150, origin_chain: 'BTC', tick: 'FUFU',
                policy_seq: 1, origin_block: 900, policy_hash: 'e'.repeat(64),
                allow_list: null, block_list: '["nA"]', sleeping: 0,
                effective_time: 1757000000, network: 'regtest', push_generation: 0
            };
            await engine._writeFinalizedPolicy({ row, signatures: [], view: 0 });
            expect(db.calls.some(c => c.sql.startsWith('INSERT IGNORE INTO policy_snapshots'))).to.equal(true);
            expect(db.calls.some(c => c.sql.startsWith("UPDATE policy_snapshots"))).to.equal(false);
            expect(broadcaster.broadcastRow.calledWithMatch({ table: 'policy_snapshots' })).to.equal(true);
        });
    });

    // ---------------------------------------------------------------------
    describe('fenced retraction', function(){

        it('retracts only the fenced, bounded source range and broadcasts the deletion', async function(){
            const { engine, db, broadcaster } = makeEngine();
            db.state.rows = [{ transfer_id: 'b'.repeat(64) }];
            const n = await engine.retractTransfersForReorg('BTC', 40, 50, 3);
            expect(n).to.equal(1);
            const select = db.calls.find(c => c.sql.startsWith('SELECT transfer_id FROM bridge_transfers WHERE'));
            expect(select.sql).to.contain('src_action_index >= ?');
            expect(select.sql).to.contain('src_action_index <= ?');
            expect(select.sql).to.contain('push_generation <= ?');
            expect(select.params).to.deep.equal(['BTC', 40, 50, 3]);
            expect(broadcaster.broadcastDeletion.calledWithMatch({
                table: 'bridge_transfers', source_chain: 'BTC', from_action_index: 40,
                to_action_index: 50, retraction_generation: 3
            })).to.equal(true);
            expect(engine.transferConsensus.forgetFinalized.calledWith('b'.repeat(64))).to.equal(true);
        });

        it('omits the bound and the fence when the indexer sent neither', async function(){
            const { engine, db } = makeEngine();
            db.state.rows = [];
            await engine.retractTransfersForReorg('DOGE', 7);
            const select = db.calls.find(c => c.sql.startsWith('SELECT transfer_id FROM bridge_transfers WHERE'));
            expect(select.sql).to.not.contain('<=');
            expect(select.params).to.deep.equal(['DOGE', 7]);
        });

        it('fails closed on a supplied-but-invalid bound instead of widening the range', async function(){
            const { engine } = makeEngine();
            let threw = false;
            try { await engine.retractTransfersForReorg('BTC', 40, 10); } catch(e){ threw = true; }
            expect(threw).to.equal(true);
        });
    });

    // ---------------------------------------------------------------------
    describe('getBridgeInvariant', function(){

        it('always carries XCHAIN and sums in-flight from both halves', async function(){
            const { engine, db } = makeEngine();
            db.state.inflight = [{ tick: 'XCHAIN', dest_chain: 'DOGE', amount: '2.00000000' }];
            engine._pendingInFlight = new Map([['XCHAIN|DOGE', ['1.50000000']]]);
            // No indexer answers getbridgebalances (the read lands on the same train), which
            // is the state a hub rolled ahead of its fleet is in. A unit test must not dial
            // out, so the failure is staged here instead of being left to DNS.
            sinon.stub(console, 'warn');
            engine._indexerCall = async () => { throw new Error('indexer RPC error: {"code":-32601}'); };
            const inv = await engine.getBridgeInvariant(null);
            expect(Object.keys(inv)).to.include('XCHAIN');
            expect(Object.keys(inv.XCHAIN).sort()).to.deep.equal(['BTC', 'DOGE', 'LTC']);
            // Signed-but-not-yet-applyable plus mined-but-not-yet-finalized.
            expect(Number(inv.XCHAIN.DOGE.in_flight)).to.equal(3.5);
            expect(Number(inv.XCHAIN.LTC.in_flight)).to.equal(0);
            // No chain reader: the chain half is UNKNOWN, never a fabricated zero.
            expect(inv.XCHAIN.DOGE.escrow).to.equal(null);
            expect(inv.XCHAIN.DOGE.delta).to.equal(null);
        });

        it('signs the delta: a surplus is positive and a deficit negative', async function(){
            const { engine } = makeEngine();
            // The escrow backing a copy sits on the ORIGIN chain at ADDRESS.BRIDGE_<copy>,
            // never on the copy itself (base spec section 3).
            engine.chainStateReader = async (coin) => {
                if(coin === 'BTC')  return { XCHAIN: { supply: '10', escrow: { DOGE: '6', LTC: '4' } } };
                if(coin === 'DOGE') return { XCHAIN: { supply: '5',  escrow: {} } };
                return { XCHAIN: { supply: '5', escrow: {} } };
            };
            const inv = await engine.getBridgeInvariant('XCHAIN');
            // DOGE: 6 held on BTC against 5 minted on DOGE, nothing in flight. A stray SEND
            // to the escrow is the only way this goes positive, and it is a surplus (D65).
            expect(inv.XCHAIN.DOGE.escrow).to.equal('6');
            expect(inv.XCHAIN.DOGE.supply).to.equal('5');
            expect(inv.XCHAIN.DOGE.delta).to.equal('1');
            // LTC: 4 held against 5 minted. Somebody else's unit has nothing behind it.
            expect(inv.XCHAIN.LTC.delta).to.equal('-1');
            // BTC is the origin: it holds the asset, nothing escrows it there.
            expect(inv.XCHAIN.BTC.supply).to.equal('10');
            expect(inv.XCHAIN.BTC.escrow).to.equal(null);
            expect(inv.XCHAIN.BTC.delta).to.equal(null);
        });

        it('subtracts in-flight before judging the delta, so the confirmation window is not a surplus', async function(){
            const { engine } = makeEngine();
            engine._pendingInFlight = new Map([['XCHAIN|DOGE', ['5']]]);
            engine.chainStateReader = async (coin) =>
                (coin === 'BTC' ? { XCHAIN: { supply: '5', escrow: { DOGE: '5' } } }
                                : { XCHAIN: { supply: '0', escrow: {} } });
            const inv = await engine.getBridgeInvariant('XCHAIN');
            expect(inv.XCHAIN.DOGE.delta).to.equal('0');
        });

        it('reports the highest FINALIZED policy seq the hub holds', async function(){
            const { engine, db } = makeEngine();
            db.state.pairs = [{ tick: 'FUFU', src_chain: 'BTC', dest_chain: 'DOGE' }];
            db.state.seq = 7;
            engine._tickOrigin.set('regtest|FUFU', 'BTC');
            // The policy seq is hub-ledger state; the chain read is irrelevant here and must
            // not dial an indexer that does not exist.
            engine.chainStateReader = async () => null;
            const inv = await engine.getBridgeInvariant('FUFU');
            expect(inv.FUFU.DOGE.finalized_policy_seq).to.equal(7);
            expect(inv.FUFU.BTC.finalized_policy_seq).to.equal(7);
        });

        it('survives a chain reader that throws, rather than failing the whole read', async function(){
            const { engine } = makeEngine();
            engine.chainStateReader = async () => { throw new Error('indexer down'); };
            const inv = await engine.getBridgeInvariant('XCHAIN');
            expect(inv.XCHAIN.BTC.escrow).to.equal(null);
        });
    });
});
