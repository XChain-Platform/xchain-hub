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
 * CrossChainCallEngine: XCALL relay: discovery gating, canonical strings,
 * independent peer re-verification, persistence/mirroring, retraction.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const crypto     = require('crypto');

const CrossChainCallEngine = require('../../src/CrossChainCallEngine');
const eq         = require('../../src/equivocation_header.js');

const CALL_ID = 'c'.repeat(64);
const sha256  = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function memDb() {
    let rows = [];
    return {
        rows,
        async doQuery(sql, params) {
            params = params || [];
            if (sql.startsWith('SELECT 1 FROM cross_chain_calls WHERE call_id = ?')) {
                return rows.filter(r => r.call_id === params[0] && r.phase === params[1]).slice(0, 1).map(() => ({ 1: 1 }));
            }
            if (sql.startsWith('SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ?')) {
                return rows.filter(r => r.call_id === params[0] && r.phase === params[1]).slice(0, 1);
            }
            if (sql.startsWith("SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = 'dispatch'")) {
                return rows.filter(r => r.call_id === params[0] && r.phase === 'dispatch').slice(0, 1);
            }
            if (sql.startsWith('INSERT INTO cross_chain_calls')) {
                // Column order mirrors _writeFinalizedRow's cols array.
                // Implementation uses ON DUPLICATE KEY UPDATE so reorg-retracted
                // rows are overwritten with re-finalized content instead of
                // being silently discarded (fix #4049).
                let cols = ['call_id','phase','snapshot_block','network',
                            'source_chain','source_action_index','source_contract_index',
                            'target_chain','target_contract_index','method','params_json',
                            'gas_limit','cross_hops','effective_time','result_status','return_payload_b64',
                            'finalizing_view','validator_signatures'];
                let newRow = { id: rows.length + 1, status: 'finalized' };
                cols.forEach((c, i) => newRow[c] = params[i]);
                let existing = rows.findIndex(r => r.call_id === newRow.call_id && r.phase === newRow.phase);
                if (existing === -1) {
                    rows.push(newRow);
                    return { affectedRows: 1, insertId: newRow.id };
                }
                // ON DUPLICATE KEY UPDATE: overwrite non-key columns and force status='finalized'
                Object.assign(rows[existing], newRow, { status: 'finalized' });
                return { affectedRows: 2, insertId: rows[existing].id };
            }
            if (sql.startsWith('SELECT d.* FROM cross_chain_calls d')) {
                // Mirrors the LEFT JOIN ... AND r.status <> 'retracted' predicate
                // (#4478): a 'retracted' result row no longer suppresses the
                // dispatch, so the result can be re-relayed after a deep reorg.
                // The optional `AND d.call_id NOT IN (?, ...)` clause (M-14) parks
                // result-less rows; excluded call_ids arrive as params[1..].
                let excluded = sql.includes('NOT IN') ? params.slice(1) : [];
                return rows.filter(r => r.phase === 'dispatch' && r.status === 'finalized' &&
                                        r.target_chain === params[0] &&
                                        !excluded.includes(r.call_id) &&
                                        !rows.some(x => x.call_id === r.call_id && x.phase === 'result' &&
                                                        x.status !== 'retracted'));
            }
            if (sql.startsWith("SELECT id, call_id, phase FROM cross_chain_calls WHERE status = 'finalized' AND source_chain")) {
                let bounded = sql.includes('source_action_index <= ?');
                let fenced  = sql.includes('push_generation <= ?');
                let pi = 2; let to = bounded ? params[pi++] : null; let gen = fenced ? params[pi++] : null;
                return rows.filter(r => r.status === 'finalized' && r.source_chain === params[0] && r.source_action_index >= params[1]
                    && (!bounded || r.source_action_index <= to)
                    && (!fenced  || (r.push_generation || 0) <= gen));
            }
            if (sql.startsWith("UPDATE cross_chain_calls SET status = 'retracted'")) {
                let bounded = sql.includes('source_action_index <= ?');
                let fenced  = sql.includes('push_generation <= ?');
                let pi = 2; let to = bounded ? params[pi++] : null; let gen = fenced ? params[pi++] : null;
                for (let r of rows)
                    if (r.status === 'finalized' && r.source_chain === params[0] && r.source_action_index >= params[1]
                        && (!bounded || r.source_action_index <= to)
                        && (!fenced  || (r.push_generation || 0) <= gen))
                        r.status = 'retracted';
                return [];
            }
            return [];
        }
    };
}

function makeEngine(opts) {
    opts = opts || {};
    const db = memDb();
    const broadcaster = { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub() };
    const hub = {
        db,
        p2pConfig: { BTC_INDEXER_URL: 'http://btc', DOGE_INDEXER_URL: 'http://doge', LTC_INDEXER_URL: 'http://ltc' },
        hubDbBroadcaster: broadcaster,
        capabilitySnapshot: {
            async getSnapshot() { return { validators: [{ pubkey: 'a'.repeat(64), amount: '1' }] }; },
            // STAKE_WEIGHTED_QUORUM (WI-1) is active at regtest/testnet block 0+, so
            // _resolveCapabilityValidators takes the weighted path: source-keyed rows.
            async getWeightSnapshot() {
                return { validators: [{ pubkey: 'a'.repeat(64), source: 's1', weight: '1' }], count: 1, sourceCount: 1 };
            }
        },
        getPeerManager: () => null,
        getIdentity: () => null,
        _resolveBtcLatestBlock: async () => 150
    };
    const engine = new CrossChainCallEngine(hub);
    // Never let a unit test gossip or run a real round.
    engine.consensus = { propose: sinon.stub().resolves(), start: sinon.stub(), stop: sinon.stub(), on: () => {},
                         forgetFinalized: sinon.stub() };
    return { engine, db, broadcaster };
}

function pendingCall(overrides) {
    return Object.assign({
        call_id: CALL_ID, action_index: 41, block_index: 100,
        source_contract_index: 5, target_chain: 'DOGE', target_contract_index: 99,
        method: 'onArrival', params_json: '["x"]', gas_limit: 50000,
        cross_hops: 1, deadline_block: 4000
    }, overrides);
}

describe('CrossChainCallEngine', function () {

    afterEach(function () { sinon.restore(); });

    describe('dispatch discovery gating (_maybeDispatch)', function () {

        it('proposes a dispatch row only once the request is at confirmation depth', async function () {
            const { engine } = makeEngine();
            // BTC threshold is 6: block 100 at latest 104 = depth 5 → hold.
            await engine._maybeDispatch('BTC', 'regtest', 104, pendingCall());
            expect(engine.consensus.propose.called).to.equal(false);
            // latest 105 = depth 6 → dispatch.
            await engine._maybeDispatch('BTC', 'regtest', 105, pendingCall());
            expect(engine.consensus.propose.calledOnce).to.equal(true);
            const [roundId, ctx] = engine.consensus.propose.firstCall.args;
            expect(roundId).to.equal(sha256('XCALLROUND|dispatch|' + CALL_ID));
            expect(ctx.row.phase).to.equal('dispatch');
            expect(ctx.row.source_chain).to.equal('BTC');
            expect(ctx.row.snapshot_block).to.equal(150);
            expect(ctx.row.cross_hops).to.equal(1);
        });

        it('never dispatches an expired request or a same-chain target', async function () {
            const { engine } = makeEngine();
            await engine._maybeDispatch('BTC', 'regtest', 500, pendingCall({ deadline_block: 400 }));
            await engine._maybeDispatch('BTC', 'regtest', 500, pendingCall({ target_chain: 'BTC' }));
            expect(engine.consensus.propose.called).to.equal(false);
        });

        it('dedupes against an already-finalized dispatch row', async function () {
            const { engine, db } = makeEngine();
            db.rows.push({ call_id: CALL_ID, phase: 'dispatch', status: 'finalized', target_chain: 'DOGE', source_chain: 'BTC', source_action_index: 41 });
            await engine._maybeDispatch('BTC', 'regtest', 500, pendingCall());
            expect(engine.consensus.propose.called).to.equal(false);
        });
    });

    describe('relay margin (effective_time is stamped in the FUTURE)', function () {

        // Regression guard for the live/replay fork: a relayed row's effective_time
        // must be ahead of the finalization instant by a margin sized to the gating
        // chain, so the row propagates everywhere before any chain reaches the block
        // it applies at. With margin 0 (the pre-fix behavior) effective_time = now and
        // a node already at the tip injects late, shifting its action-index counter and
        // forking from a replaying node (EMITTER_ACTION_INDEX is in the call_id preimage).

        it('stamps effective_time a gating-chain margin into the future (never the bare clock second)', function () {
            const { engine } = makeEngine();
            const now = Math.floor(Date.now() / 1000);
            // Default 4 blocks. DOGE 60s → +240s; LTC 150s → +600s; BTC 600s → +2400s.
            expect(engine._relayEffectiveTime('DOGE') - now).to.be.at.least(240);
            expect(engine._relayEffectiveTime('LTC')  - now).to.be.at.least(600);
            expect(engine._relayEffectiveTime('BTC')  - now).to.be.at.least(2400);
            // Always strictly in the future of the finalization instant (that is the whole point).
            expect(engine._relayEffectiveTime('DOGE')).to.be.greaterThan(now);
        });

        it('keeps every chain’s margin under the follower clock-skew bound (3600s)', function () {
            const { engine } = makeEngine();
            const now = Math.floor(Date.now() / 1000);
            for (const chain of ['BTC', 'LTC', 'DOGE']) {
                expect(engine._relayEffectiveTime(chain) - now).to.be.lessThan(3600);
            }
        });

        it('a margined dispatch row still passes a follower’s own re-verification', async function () {
            const { engine } = makeEngine();
            sinon.stub(engine, '_indexerCall').resolves({
                exists: true, network: 'regtest', latest_block_index: 200, call: pendingCall()
            });
            // The dispatch targets DOGE → margin sized to DOGE; the source (BTC) follower
            // adopts the leader-choice effective_time, bounded to within an hour of its clock.
            const row = {
                round_id: sha256('XCALLROUND|dispatch|' + CALL_ID),
                call_id: CALL_ID, phase: 'dispatch', snapshot_block: 150, network: 'regtest',
                source_chain: 'BTC', source_action_index: 41, source_contract_index: 5,
                target_chain: 'DOGE', target_contract_index: 99, method: 'onArrival',
                params_json: '["x"]', gas_limit: 50000, cross_hops: 1,
                effective_time: engine._relayEffectiveTime('DOGE')
            };
            expect(await engine.validateProposedMatch(row)).to.equal(true);
        });

        it('honors XCALL_RELAY_MARGIN_BLOCKS and caps a huge value under the clock-skew bound', function () {
            const prev = process.env.XCALL_RELAY_MARGIN_BLOCKS;
            try {
                process.env.XCALL_RELAY_MARGIN_BLOCKS = '0';
                expect(makeEngine().engine.relayMarginBlocks).to.equal(0);
                process.env.XCALL_RELAY_MARGIN_BLOCKS = '999999';
                const { engine } = makeEngine();
                const now = Math.floor(Date.now() / 1000);
                // Even an absurd block count is capped below 3600s on every chain.
                expect(engine._relayEffectiveTime('BTC') - now).to.be.at.most(3000);
                expect(engine._relayEffectiveTime('DOGE') - now).to.be.at.most(3000);
            } finally {
                if (prev === undefined) delete process.env.XCALL_RELAY_MARGIN_BLOCKS;
                else process.env.XCALL_RELAY_MARGIN_BLOCKS = prev;
            }
        });
    });

    describe('canonical strings (consensus-critical, byte-matched fleet-wide)', function () {

        it('dispatch canonical matches the indexer/recovery verifiers', function () {
            const { engine } = makeEngine();
            const row = {
                phase: 'dispatch', call_id: CALL_ID, snapshot_block: 150, network: 'regtest',
                source_chain: 'BTC', source_action_index: 41, source_contract_index: 5,
                target_chain: 'DOGE', target_contract_index: 99, method: 'onArrival',
                params_json: '["x"]', gas_limit: 50000, cross_hops: 1, effective_time: 1700000000
            };
            // EQUIV active in regtest: TAG=XCALL, ROUND_ID=sha256('XCALLROUND|dispatch|'+call_id), VIEW=0.
            const raw = [
                'XCALL', 'DISPATCH', CALL_ID, '150', 'regtest', 'BTC', '41', '5', 'DOGE', '99',
                'onArrival', sha256('["x"]'), '50000', '1', '1700000000'
            ].join('|');
            expect(engine._canonicalMatch(row)).to.equal(
                eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha256('XCALLROUND|dispatch|' + CALL_ID), 0, raw));
        });

        it('result canonical hashes the payload and binds result_status', function () {
            const { engine } = makeEngine();
            const row = {
                phase: 'result', call_id: CALL_ID, snapshot_block: 160, network: 'regtest',
                target_chain: 'DOGE', result_status: 'ok', return_payload_b64: 'cGF5bG9hZA',
                effective_time: 1700000050
            };
            // EQUIV active in regtest: TAG=XCALL, ROUND_ID=sha256('XCALLROUND|result|'+call_id), VIEW=0.
            const raw = [
                'XCALL', 'RESULT', CALL_ID, '160', 'regtest', 'DOGE', 'ok',
                sha256('cGF5bG9hZA'), '1700000050'
            ].join('|');
            expect(engine._canonicalMatch(row)).to.equal(
                eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha256('XCALLROUND|result|' + CALL_ID), 0, raw));
        });
    });

    describe('independent peer re-verification (validateProposedMatch)', function () {

        function dispatchRow(overrides) {
            return Object.assign({
                round_id: sha256('XCALLROUND|dispatch|' + CALL_ID),
                call_id: CALL_ID, phase: 'dispatch', snapshot_block: 150, network: 'regtest',
                source_chain: 'BTC', source_action_index: 41, source_contract_index: 5,
                target_chain: 'DOGE', target_contract_index: 99, method: 'onArrival',
                params_json: '["x"]', gas_limit: 50000, cross_hops: 1,
                effective_time: Math.floor(Date.now() / 1000)   // leader-choice field, clock-bounded by validation
            }, overrides);
        }

        it('signs a dispatch only when its OWN source indexer confirms every field at depth', async function () {
            const { engine } = makeEngine();
            sinon.stub(engine, '_indexerCall').resolves({
                exists: true, network: 'regtest', latest_block_index: 200,
                call: pendingCall()
            });
            expect(await engine.validateProposedMatch(dispatchRow())).to.equal(true);
            // A single diverging field must refuse the signature.
            expect(await engine.validateProposedMatch(dispatchRow({ gas_limit: 60000 }))).to.equal(false);
            expect(await engine.validateProposedMatch(dispatchRow({ params_json: '["y"]' }))).to.equal(false);
            expect(await engine.validateProposedMatch(dispatchRow({ cross_hops: 2 }))).to.equal(false);
        });

        it('refuses a dispatch below confirmation depth or on the wrong network', async function () {
            const { engine } = makeEngine();
            const stub = sinon.stub(engine, '_indexerCall');
            stub.resolves({ exists: true, network: 'regtest', latest_block_index: 103, call: pendingCall() }); // depth 4 < 6
            expect(await engine.validateProposedMatch(dispatchRow())).to.equal(false);
            stub.resolves({ exists: true, network: 'mainnet', latest_block_index: 200, call: pendingCall() });
            expect(await engine.validateProposedMatch(dispatchRow())).to.equal(false);
        });

        it('refuses a round id that does not derive from (phase, call_id)', async function () {
            const { engine } = makeEngine();
            expect(await engine.validateProposedMatch(dispatchRow({ round_id: sha256('bogus') }))).to.equal(false);
        });

        it('bounds the leader-choice fields: stale effective_time / pinned snapshot_block are refused', async function () {
            const { engine } = makeEngine();
            sinon.stub(engine, '_indexerCall').resolves({
                exists: true, network: 'regtest', latest_block_index: 200,
                call: pendingCall()
            });
            // baseline passes
            expect(await engine.validateProposedMatch(dispatchRow())).to.equal(true);
            // a clock more than an hour off is refused (Byzantine leader-choice)
            expect(await engine.validateProposedMatch(dispatchRow({ effective_time: 1700000000 }))).to.equal(false);
            expect(await engine.validateProposedMatch(dispatchRow({ effective_time: Math.floor(Date.now() / 1000) + 7200 }))).to.equal(false);
            // a snapshot_block pinned far from OUR tip view (150) selects a stale
            // validator set for indexer-side sig verification; refused
            expect(await engine.validateProposedMatch(dispatchRow({ snapshot_block: 1 }))).to.equal(false);
            expect(await engine.validateProposedMatch(dispatchRow({ snapshot_block: 1000 }))).to.equal(false);
        });

        it('signs a result only when its OWN target indexer reports the identical outcome at depth, for a KNOWN dispatch', async function () {
            const { engine, db } = makeEngine();
            db.rows.push(Object.assign(dispatchRow(), { status: 'finalized' }));
            const resultRow = {
                round_id: sha256('XCALLROUND|result|' + CALL_ID),
                call_id: CALL_ID, phase: 'result', snapshot_block: 160, network: 'regtest',
                source_chain: 'BTC', target_chain: 'DOGE',
                // Dispatch-inherited reorg-fence metadata (must match the local dispatch row).
                source_action_index: 41, push_generation: 0,
                result_status: 'ok', return_payload_b64: 'cGF5bG9hZA',
                effective_time: Math.floor(Date.now() / 1000)
            };
            const stub = sinon.stub(engine, '_indexerCall').resolves({
                exists: true, latest_block_index: 600, executed_block_index: 500,   // depth 101 >= DOGE 60
                status: 'ok', return_payload_b64: 'cGF5bG9hZA'
            });
            expect(await engine.validateProposedMatch(resultRow)).to.equal(true);
            stub.resolves({ exists: true, latest_block_index: 600, executed_block_index: 500, status: 'reverted', return_payload_b64: '' });
            expect(await engine.validateProposedMatch(resultRow)).to.equal(false);
            // Unknown dispatch → never vouch for its result.
            db.rows.length = 0;
            expect(await engine.validateProposedMatch(resultRow)).to.equal(false);
        });

        it('refuses a result row whose inherited reorg-fence metadata diverges from the local dispatch row', async function () {
            const { engine, db } = makeEngine();
            db.rows.push(Object.assign(dispatchRow(), { status: 'finalized', source_action_index: 41, push_generation: 3 }));
            const baseResult = {
                round_id: sha256('XCALLROUND|result|' + CALL_ID),
                call_id: CALL_ID, phase: 'result', snapshot_block: 160, network: 'regtest',
                source_chain: 'BTC', target_chain: 'DOGE',
                source_action_index: 41, push_generation: 3,
                result_status: 'ok', return_payload_b64: 'cGF5bG9hZA',
                effective_time: Math.floor(Date.now() / 1000)
            };
            sinon.stub(engine, '_indexerCall').resolves({
                exists: true, latest_block_index: 600, executed_block_index: 500,
                status: 'ok', return_payload_b64: 'cGF5bG9hZA'
            });
            // Honest inherited metadata is accepted.
            expect(await engine.validateProposedMatch(baseResult)).to.equal(true);
            // A forged source_action_index is rejected.
            expect(await engine.validateProposedMatch(Object.assign({}, baseResult, { source_action_index: 42 }))).to.equal(false);
            // An inflated push_generation is rejected.
            expect(await engine.validateProposedMatch(Object.assign({}, baseResult, { push_generation: 9 }))).to.equal(false);
        });

        it('refuses a dispatch row whose push_generation diverges from the source indexer', async function () {
            const { engine } = makeEngine();
            sinon.stub(engine, '_indexerCall').resolves({
                exists: true, network: 'regtest', latest_block_index: 200,
                call: pendingCall({ push_generation: 4 })
            });
            // Matching generation passes.
            expect(await engine.validateProposedMatch(dispatchRow({ push_generation: 4 }))).to.equal(true);
            // A forged (inflated) generation is refused.
            expect(await engine.validateProposedMatch(dispatchRow({ push_generation: 7 }))).to.equal(false);
        });
    });

    describe('persistence + retraction', function () {

        it('_writeFinalizedRow upserts (ON DUPLICATE KEY UPDATE) and mirrors the stored row', async function () {
            const { engine, db, broadcaster } = makeEngine();
            const row = {
                round_id: sha256('XCALLROUND|dispatch|' + CALL_ID),
                call_id: CALL_ID, phase: 'dispatch', snapshot_block: 150, network: 'regtest',
                source_chain: 'BTC', source_action_index: 41, source_contract_index: 5,
                target_chain: 'DOGE', target_contract_index: 99, method: 'onArrival',
                params_json: '["x"]', gas_limit: 50000, cross_hops: 1, effective_time: 1700000000,
                result_status: null, return_payload_b64: null
            };
            const persist = sinon.stub(engine, '_persistCapabilitySnapshot').resolves();
            await engine._writeFinalizedRow({ row, signatures: [{ pubkey: 'a'.repeat(64), sig: '1'.repeat(128) }] });
            expect(db.rows.length).to.equal(1);
            // EVERY hub (followers included) must persist the snapshot the
            // indexers verify against. Leader-only persistence left follower
            // DBs without it (live finding: DOGE XEXEC deferred forever when
            // hub2/3 led the round but the indexers mirror hub1's DB).
            expect(persist.calledWith('cross_chain', 150)).to.equal(true);
            expect(db.rows[0].validator_signatures).to.contain('a'.repeat(64));
            expect(broadcaster.broadcastRow.calledOnce).to.equal(true);
            expect(broadcaster.broadcastRow.firstCall.args[0].table).to.equal('cross_chain_calls');
        });

        it('re-discovers a dispatch whose only result row is retracted (#4478)', async function () {
            const { engine, db } = makeEngine();
            // A finalized dispatch targeting DOGE plus a 'retracted' result row left
            // by a deep reorg. The unfiltered join treated r.id IS NOT NULL and never
            // re-relayed; the AND r.status <> 'retracted' predicate re-opens it.
            db.rows.push(
                { id: 1, call_id: CALL_ID, phase: 'dispatch', status: 'finalized', target_chain: 'DOGE',
                  source_chain: 'BTC', source_action_index: 41 },
                { id: 2, call_id: CALL_ID, phase: 'result', status: 'retracted', target_chain: 'DOGE',
                  source_chain: 'BTC', source_action_index: 41 }
            );
            const seen = [];
            sinon.stub(engine, '_maybeRelayResult').callsFake(async (coin, d) => { seen.push(d.call_id); });
            await engine._pollTargetResults('DOGE');
            expect(seen).to.deep.equal([CALL_ID]);

            // A live (non-retracted) result row still suppresses re-discovery.
            db.rows[1].status = 'finalized';
            seen.length = 0;
            await engine._pollTargetResults('DOGE');
            expect(seen).to.deep.equal([]);
        });

        it('retractCallsForReorg flips BOTH phases to retracted (match model) and broadcasts a deletion', async function () {
            const { engine, db, broadcaster } = makeEngine();
            db.rows.push(
                { call_id: CALL_ID, phase: 'dispatch', status: 'finalized', source_chain: 'BTC', source_action_index: 41 },
                { call_id: CALL_ID, phase: 'result',   status: 'finalized', source_chain: 'BTC', source_action_index: 41 },
                { call_id: 'd'.repeat(64), phase: 'dispatch', status: 'finalized', source_chain: 'BTC', source_action_index: 7 }
            );
            await engine.retractCallsForReorg('BTC', 40);
            expect(db.rows.filter(r => r.status === 'retracted').length).to.equal(2);
            expect(db.rows.find(r => r.source_action_index === 7).status).to.equal('finalized');
            expect(broadcaster.broadcastDeletion.calledOnce).to.equal(true);
            expect(broadcaster.broadcastDeletion.firstCall.args[0]).to.deep.include(
                { table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 40 });
        });

        it('retractCallsForReorg with a closed-range ceiling leaves a re-published row above the ceiling intact (item 5296)', async function () {
            const { engine, db, broadcaster } = makeEngine();
            db.rows.push(
                { call_id: CALL_ID,         phase: 'dispatch', status: 'finalized', source_chain: 'BTC', source_action_index: 41 }, // in [40,75]
                { call_id: 'e'.repeat(64),  phase: 'dispatch', status: 'finalized', source_chain: 'BTC', source_action_index: 90 }  // re-published A' > 75
            );
            await engine.retractCallsForReorg('BTC', 40, 75);
            expect(db.rows.find(r => r.source_action_index === 41).status).to.equal('retracted');
            expect(db.rows.find(r => r.source_action_index === 90).status).to.equal('finalized', 'row above the ceiling must survive');
            expect(broadcaster.broadcastDeletion.firstCall.args[0]).to.deep.include(
                { table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 40, to_action_index: 75 });
        });

        it('retractCallsForReorg gen-fences: a re-finalized relay row at a RECYCLED source index survives (item 5308)', async function () {
            const { engine, db, broadcaster } = makeEngine();
            // Both rows at the SAME recycled source_action_index = 41 (inside [40,75]); only the
            // generation differs. The pre-bump retraction generation is 5.
            db.rows.push(
                { call_id: CALL_ID,        phase: 'dispatch', status: 'finalized', source_chain: 'BTC', source_action_index: 41, push_generation: 5 }, // orphan
                { call_id: 'f'.repeat(64), phase: 'dispatch', status: 'finalized', source_chain: 'BTC', source_action_index: 41, push_generation: 6 }  // re-finalized post-reorg
            );
            await engine.retractCallsForReorg('BTC', 40, 75, 5);
            expect(db.rows.find(r => r.call_id === CALL_ID).status).to.equal('retracted', 'gen-5 orphan retracted');
            expect(db.rows.find(r => r.call_id === 'f'.repeat(64)).status).to.equal('finalized', 'gen-6 re-finalize at the recycled index must survive');
            expect(broadcaster.broadcastDeletion.firstCall.args[0]).to.deep.include(
                { table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 40, to_action_index: 75, retraction_generation: 5 });
        });

        // M-13: retraction must clear the consensus finalized-ring entry for BOTH phases,
        // otherwise a call re-confirmed after this reorg can never re-run its deterministic
        // round (propose() no-ops on a finalized id) and is stranded in 'retracted' forever.
        it('retractCallsForReorg clears the consensus finalized ring for every retracted round (M-13)', async function () {
            const { engine, db } = makeEngine();
            db.rows.push(
                { call_id: CALL_ID, phase: 'dispatch', status: 'finalized', source_chain: 'BTC', source_action_index: 41 },
                { call_id: CALL_ID, phase: 'result',   status: 'finalized', source_chain: 'BTC', source_action_index: 41 }
            );
            await engine.retractCallsForReorg('BTC', 40);
            const forgot = engine.consensus.forgetFinalized.getCalls().map(c => c.args[0]);
            expect(forgot).to.include(sha256('XCALLROUND|dispatch|' + CALL_ID));
            expect(forgot).to.include(sha256('XCALLROUND|result|' + CALL_ID));
        });
    });

    // M-14: the result poll must not let a permanently result-less dispatch pin the
    // ORDER BY id ASC window and starve newer dispatches (head-of-line blocking).
    describe('result-relay backoff (head-of-line blocking, M-14)', function () {

        it('parks a result-less dispatch so a newer dispatch is no longer starved', async function () {
            const { engine, db } = makeEngine();
            // One older result-less dispatch (id 1) and one newer (id 2), both targeting DOGE.
            db.rows.push(
                { id: 1, call_id: 'a'.repeat(64), phase: 'dispatch', status: 'finalized', target_chain: 'DOGE', source_chain: 'BTC', source_action_index: 1 },
                { id: 2, call_id: 'b'.repeat(64), phase: 'dispatch', status: 'finalized', target_chain: 'DOGE', source_chain: 'BTC', source_action_index: 2 }
            );
            // No result exists on the target for either call: _maybeRelayResult returns false.
            sinon.stub(engine, '_indexerCall').resolves({ exists: false });

            // First poll: both are attempted and parked (result-less).
            await engine._pollTargetResults('DOGE');
            expect(engine._resultBackoff.has('a'.repeat(64))).to.equal(true);
            expect(engine._resultBackoff.has('b'.repeat(64))).to.equal(true);

            // Second poll: both are inside their backoff window, so both are excluded
            // from the hot query. The window is free for whatever arrives next.
            const spy = sinon.spy(engine, '_maybeRelayResult');
            await engine._pollTargetResults('DOGE');
            expect(spy.called).to.equal(false, 'parked rows must not be re-polled while backed off');
        });

        it('clears backoff once the result becomes available', async function () {
            const { engine, db } = makeEngine();
            db.rows.push(
                { id: 1, call_id: 'a'.repeat(64), phase: 'dispatch', status: 'finalized', target_chain: 'DOGE', source_chain: 'BTC', source_action_index: 1 }
            );
            const relay = sinon.stub(engine, '_maybeRelayResult');
            relay.onFirstCall().resolves(false);   // result absent -> park
            relay.onSecondCall().resolves(true);    // result arrived -> round proposed

            await engine._pollTargetResults('DOGE');
            expect(engine._resultBackoff.has('a'.repeat(64))).to.equal(true);

            // Force the backoff window to have elapsed, then poll again.
            engine._resultBackoff.get('a'.repeat(64)).nextAt = Date.now() - 1;
            await engine._pollTargetResults('DOGE');
            expect(engine._resultBackoff.has('a'.repeat(64))).to.equal(false, 'a delivered result clears backoff');
        });

        it('exponential backoff grows and is capped', function () {
            const { engine } = makeEngine();
            const id = 'a'.repeat(64);
            const t0 = Date.now();
            engine._parkResult(id);
            const first = engine._resultBackoff.get(id).nextAt - t0;
            engine._parkResult(id);
            const second = engine._resultBackoff.get(id).nextAt - Date.now();
            expect(second).to.be.greaterThan(first - 5);       // second delay >= first (allow scheduling slack)
            for (let i = 0; i < 40; i++) engine._parkResult(id);
            expect(engine._resultBackoff.get(id).nextAt - Date.now()).to.be.at.most(60 * 60 * 1000 + 5);
        });
    });

    describe('_resolveCapabilityValidators (SWQ-TRUNC flag propagation)', function () {
        it('carries truncated=true through the .map when the weighted snapshot overflowed the cap', async function () {
            const { engine } = makeEngine();
            engine.capSnapshot.getWeightSnapshot = async () => ({
                validators: [{ pubkey: 'a'.repeat(64), source: 's1', weight: '1' }], count: 1, truncated: true
            });
            const vals = await engine._resolveCapabilityValidators('cross_chain', 100, 'regtest');
            // The consensus fails closed only when the flag survives the map (meetsStakeThreshold).
            expect(vals.truncated).to.equal(true);
        });

        it('does NOT mark truncated for a complete weighted snapshot', async function () {
            const { engine } = makeEngine();
            const vals = await engine._resolveCapabilityValidators('cross_chain', 100, 'regtest');
            expect(vals.truncated).to.not.equal(true);
        });
    });
});
