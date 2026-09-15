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
const fs         = require('fs');
const path       = require('path');

const CrossChainCallEngine = require('../../../../src/cross_chain/call_engine');
const eq         = require('../../../../src/equivocation_header.js');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

const CALL_ID = 'c'.repeat(64);
const sha256  = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// ── real getcrosschaincall response shape (item 2367) ────────────────────────
// validateDispatch re-verifies a leader's proposed row field-for-field against
// the source indexer's getcrosschaincall reply. A hand-written `call:` stub can
// therefore assert a field the REAL handler never emits, which is exactly how the
// push_generation pin passed CI while being dead in production: the handler's
// response literal omitted the field, every follower re-derived 0, and from the
// first source-chain rollback onward no honest dispatch could ever be co-signed.
//
// So the fixture is not hand-written. It is produced by EXECUTING the sibling
// indexer's own success-response literal, lifted verbatim out of its source. The
// literal is a pure projection of (indexer.config, latest, row, pushGeneration),
// so it evaluates with no DB, network or express involvement - which matters
// because xchain-indexer/src/api.js calls startApi() at load and cannot be
// required. If the handler drops a pinned field again, these cases fail instead
// of passing against a shape production cannot emit.
const INDEXER_API = process.env.XCHAIN_INDEXER_DIR
    ? path.join(process.env.XCHAIN_INDEXER_DIR, 'src', 'api.js')
    : path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'api.js');

// Slice the handler body, brace-match its success-response object literal, and
// compile it into a builder. Throws (never silently degrades) on any parse miss:
// a guard that cannot find its target is a guard that is not running.
function compileIndexerCallResponse() {
    const src   = fs.readFileSync(INDEXER_API, 'utf8');
    const start = src.indexOf('async getcrosschaincall({call_id}){');
    if (start === -1)
        throw new Error('getcrosschaincall handler header not found in ' + INDEXER_API);
    const rel  = src.slice(start + 1).search(/\n {8}async\s+\w+\s*\(/);
    const body = src.slice(start, rel === -1 ? src.length : start + 1 + rel);
    const hit  = /return\s*\{\s*[\r\n]?\s*exists:\s*true,/.exec(body);
    if (!hit)
        throw new Error('getcrosschaincall success-response literal not found in ' + INDEXER_API);
    const open = body.indexOf('{', hit.index);
    let depth = 0, end = -1;
    for (let i = open; i < body.length; i++) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end === -1)
        throw new Error('unbalanced getcrosschaincall response literal in ' + INDEXER_API);
    const literal = body.slice(open, end + 1);
    const make = new Function('indexer', 'latest', 'row', 'pushGeneration',
        'return (' + literal + ');');
    return function (opts) {
        return make({ config: { NETWORK: opts.network } }, opts.latest, opts.row, opts.pushGeneration);
    };
}

// A row shaped like getCrossChainCallRequestById's `SELECT x.* FROM xcalls`, matching
// the dispatchRow() fixture below field-for-field so an honest round validates.
function xcallsRow(overrides) {
    return Object.assign({
        call_id: CALL_ID, action_index: 41, block_index: 100, contract_index: 5,
        target_chain: 'DOGE', target_contract_index: 99, method: 'onArrival',
        params_json: '["x"]', gas_limit: 50000, cross_hops: 1, deadline_block: 4000,
        request_status: 'pending'
    }, overrides);
}

let buildIndexerCallResponse = null, indexerSrcErr = null;
try { buildIndexerCallResponse = compileIndexerCallResponse(); } catch (e) { indexerSrcErr = e; }

// Sibling-gated like every other cross-repo guard in this fleet: skip when the
// indexer checkout is absent (standalone hub deploy), hard-fail in the
// required-siblings CI lane so the gap cannot recur as a green skip.
function requireIndexerSource() {
    if (buildIndexerCallResponse) return;
    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the sibling indexer getcrosschaincall handler could not be '
            + 'read from ' + INDEXER_API + ': ' + (indexerSrcErr && indexerSrcErr.message));
    this.skip();
}

function selectStoredCall(rows, sql, params) {
    if (sql.startsWith('SELECT 1 FROM cross_chain_calls WHERE call_id = ?'))
        return rows.filter(r => r.call_id === params[0] && r.phase === params[1]).slice(0, 1).map(() => ({ 1: 1 }));
    if (sql.startsWith('SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ?'))
        return rows.filter(r => r.call_id === params[0] && r.phase === params[1]).slice(0, 1);
    if (sql.startsWith("SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = 'dispatch'"))
        return rows.filter(r => r.call_id === params[0] && r.phase === 'dispatch').slice(0, 1);
}

function insertStoredCall(rows, sql, params) {
    if (!sql.startsWith('INSERT INTO cross_chain_calls')) return;
    const cols = ['call_id', 'phase', 'snapshot_block', 'network',
        'source_chain', 'source_action_index', 'source_contract_index',
        'target_chain', 'target_contract_index', 'method', 'params_json',
        'gas_limit', 'cross_hops', 'effective_time', 'result_status', 'return_payload_b64',
        'finalizing_view', 'validator_signatures'];
    const newRow = { id: rows.length + 1, status: 'finalized' };
    cols.forEach((column, index) => newRow[column] = params[index]);
    const existing = rows.findIndex(row => row.call_id === newRow.call_id && row.phase === newRow.phase);
    if (existing === -1) {
        rows.push(newRow);
        return { affectedRows: 1, insertId: newRow.id };
    }
    Object.assign(rows[existing], newRow, { status: 'finalized' });
    return { affectedRows: 2, insertId: rows[existing].id };
}

function selectRelayCandidates(rows, sql, params) {
    if (!sql.startsWith('SELECT d.* FROM cross_chain_calls d')) return;
    const excluded = sql.includes('NOT IN') ? params.slice(1) : [];
    return rows.filter(row => row.phase === 'dispatch' && row.status === 'finalized' &&
        row.target_chain === params[0] && !excluded.includes(row.call_id) &&
        !rows.some(result => result.call_id === row.call_id && result.phase === 'result' &&
            result.status !== 'retracted'));
}

function selectRetractableCalls(rows, sql, params) {
    if (!sql.startsWith("SELECT id, call_id, phase FROM cross_chain_calls WHERE status = 'finalized' AND source_chain")) return;
    const bounded = sql.includes('source_action_index <= ?');
    const fenced = sql.includes('push_generation <= ?');
    let index = 2;
    const to = bounded ? params[index++] : null;
    const generation = fenced ? params[index++] : null;
    return rows.filter(row => row.status === 'finalized' && row.source_chain === params[0] &&
        row.source_action_index >= params[1] && (!bounded || row.source_action_index <= to) &&
        (!fenced || (row.push_generation || 0) <= generation));
}

function retractStoredCalls(rows, sql, params) {
    if (!sql.startsWith("UPDATE cross_chain_calls SET status = 'retracted'")) return;
    const matches = selectRetractableCalls(rows,
        "SELECT id, call_id, phase FROM cross_chain_calls WHERE status = 'finalized' AND source_chain" +
            (sql.includes('source_action_index <= ?') ? ' source_action_index <= ?' : '') +
            (sql.includes('push_generation <= ?') ? ' push_generation <= ?' : ''), params);
    for (const row of matches) row.status = 'retracted';
    return [];
}

function listStoredCalls(rows, sql, params) {
    if (sql.includes('FROM cross_chain_calls WHERE call_id = ? ORDER BY phase'))
        return rows.filter(row => row.call_id === params[0])
            .sort((a, b) => String(a.phase).localeCompare(String(b.phase)));
    if (!sql.startsWith('SELECT id, call_id, phase, snapshot_block, network, source_chain') ||
        !sql.includes('ORDER BY id DESC')) return;
    let out = rows.slice();
    let index = 0;
    for (const [filter, field] of [['source_chain = ?', 'source_chain'], ['target_chain = ?', 'target_chain'],
        ['status = ?', 'status'], ['phase = ?', 'phase']]) {
        if (sql.includes(filter)) {
            const value = params[index++];
            out = out.filter(row => row[field] === value);
        }
    }
    out.sort((a, b) => (b.id || 0) - (a.id || 0));
    return out.slice(0, params[index]);
}

function memDb() {
    const rows = [];
    return { ...DB_METHODS, rows, async doQuery(sql, params) {
        params = params || [];
        const handlers = [selectStoredCall, insertStoredCall, selectRelayCandidates,
            selectRetractableCalls, retractStoredCalls, listStoredCalls];
        for (const handler of handlers) {
            const result = handler(rows, sql, params);
            if (result !== undefined) return result;
        }
        return [];
    } };
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
            // resolveCapabilityValidators takes the weighted path: source-keyed rows.
            async getWeightSnapshot() {
                return { validators: [{ pubkey: 'a'.repeat(64), source: 's1', weight: '1' }], count: 1, sourceCount: 1 };
            }
        },
        getPeerManager: () => null,
        getIdentity: () => null,
        resolveBtcLatestBlock: async () => 150
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

function registerFeature2relayMarginEffectiveTimeIsStampedInTheFUTUREPart1() {
  // Regression guard for the live/replay fork: a relayed row's effective_time
  // must be ahead of the finalization instant by a margin sized to the gating
  // chain, so the row propagates everywhere before any chain reaches the block
  // it applies at. With margin 0 (the pre-fix behavior) effective_time = now and
  // a node already at the tip injects late, shifting its action-index counter and
  // forking from a replaying node (EMITTER_ACTION_INDEX is in the call_id preimage).

  it('stamps effective_time a gating-chain margin into the future (never the bare clock second)', function () {
    const {
      engine
    } = makeEngine();
    const now = Math.floor(Date.now() / 1000);
    // Default 4 blocks. DOGE 60s → +240s; LTC 150s → +600s; BTC 600s → +2400s.
    expect(engine.relayEffectiveTime('DOGE') - now).to.be.at.least(240);
    expect(engine.relayEffectiveTime('LTC') - now).to.be.at.least(600);
    expect(engine.relayEffectiveTime('BTC') - now).to.be.at.least(2400);
    // Always strictly in the future of the finalization instant (that is the whole point).
    expect(engine.relayEffectiveTime('DOGE')).to.be.greaterThan(now);
  });
  it('keeps every chain’s margin under the follower clock-skew bound (3600s)', function () {
    const {
      engine
    } = makeEngine();
    const now = Math.floor(Date.now() / 1000);
    for (const chain of ['BTC', 'LTC', 'DOGE']) {
      expect(engine.relayEffectiveTime(chain) - now).to.be.lessThan(3600);
    }
  });
}
function registerFeature2relayMarginEffectiveTimeIsStampedInTheFUTUREPart2() {
  it('a margined dispatch row still passes a follower’s own re-verification', async function () {
    const {
      engine
    } = makeEngine();
    sinon.stub(engine, 'indexerCall').resolves({
      exists: true,
      network: 'regtest',
      latest_block_index: 200,
      call: pendingCall()
    });
    // The dispatch targets DOGE → margin sized to DOGE; the source (BTC) follower
    // adopts the leader-choice effective_time, bounded to within an hour of its clock.
    const row = {
      round_id: sha256('XCALLROUND|dispatch|' + CALL_ID),
      call_id: CALL_ID,
      phase: 'dispatch',
      snapshot_block: 150,
      network: 'regtest',
      source_chain: 'BTC',
      source_action_index: 41,
      source_contract_index: 5,
      target_chain: 'DOGE',
      target_contract_index: 99,
      method: 'onArrival',
      params_json: '["x"]',
      gas_limit: 50000,
      cross_hops: 1,
      effective_time: engine.relayEffectiveTime('DOGE')
    };
    expect(await engine.validateProposedMatch(row)).to.equal(true);
  });
  it('honors XCALL_RELAY_MARGIN_BLOCKS and caps a huge value under the clock-skew bound', function () {
    const prev = process.env.XCALL_RELAY_MARGIN_BLOCKS;
    try {
      process.env.XCALL_RELAY_MARGIN_BLOCKS = '0';
      expect(makeEngine().engine.relayMarginBlocks).to.equal(0);
      process.env.XCALL_RELAY_MARGIN_BLOCKS = '999999';
      const {
        engine
      } = makeEngine();
      const now = Math.floor(Date.now() / 1000);
      // Even an absurd block count is capped below 3600s on every chain.
      expect(engine.relayEffectiveTime('BTC') - now).to.be.at.most(3000);
      expect(engine.relayEffectiveTime('DOGE') - now).to.be.at.most(3000);
    } finally {
      if (prev === undefined) delete process.env.XCALL_RELAY_MARGIN_BLOCKS;else process.env.XCALL_RELAY_MARGIN_BLOCKS = prev;
    }
  });

  // The config is tunable UPWARD only. XCALL_RELAY_MARGIN_BLOCKS=0 once made
  // relayEffectiveTime return the bare clock second, which is precisely the
  // live/replay fork the margin exists to prevent - a misconfiguration could
  // re-open a consensus hole (#4202). The default margin is now a hard floor.
}
function registerFeature2relayMarginEffectiveTimeIsStampedInTheFUTUREPart3() {
  // The config is tunable UPWARD only. XCALL_RELAY_MARGIN_BLOCKS=0 once made
  // relayEffectiveTime return the bare clock second, which is precisely the
  // live/replay fork the margin exists to prevent - a misconfiguration could
  // re-open a consensus hole (#4202). The default margin is now a hard floor.
  it('floors the margin at the default: XCALL_RELAY_MARGIN_BLOCKS=0 cannot stamp the bare clock second', function () {
    const prev = process.env.XCALL_RELAY_MARGIN_BLOCKS;
    try {
      for (const blocks of ['0', '-5', '1']) {
        process.env.XCALL_RELAY_MARGIN_BLOCKS = blocks;
        const {
          engine
        } = makeEngine();
        const now = Math.floor(Date.now() / 1000);
        expect(engine.relayEffectiveTime('DOGE') - now, 'DOGE margin floor breached at XCALL_RELAY_MARGIN_BLOCKS=' + blocks).to.be.at.least(240);
        expect(engine.relayEffectiveTime('LTC') - now).to.be.at.least(600);
        expect(engine.relayEffectiveTime('BTC') - now).to.be.at.least(2400);
      }
    } finally {
      if (prev === undefined) delete process.env.XCALL_RELAY_MARGIN_BLOCKS;else process.env.XCALL_RELAY_MARGIN_BLOCKS = prev;
    }
  });
}
function registerFeature2relayMarginEffectiveTimeIsStampedInTheFUTURE() {
  describe('relay margin (effective_time is stamped in the FUTURE)', function () {
    registerFeature2relayMarginEffectiveTimeIsStampedInTheFUTUREPart1();
    registerFeature2relayMarginEffectiveTimeIsStampedInTheFUTUREPart2();
    registerFeature2relayMarginEffectiveTimeIsStampedInTheFUTUREPart3();
  });
}
describe('CrossChainCallEngine', function () {
  afterEach(function () {
    sinon.restore();
  });
  registerFeature2relayMarginEffectiveTimeIsStampedInTheFUTURE();
});
