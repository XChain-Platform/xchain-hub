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

// The row fixtures and in-memory hub DB behind the StateAnchorPublisher mesh
// harness (anchor_mesh.js): the base checkpoint row, signed match and XCALL rows
// with the canonicals their fixtures sign, the ANCHOR v0 wire parsers, and a DB
// stand-in that answers the publisher's query surface from plain arrays.

const crypto         = require('crypto');
const eq             = require('../../src/equivocation_header.js');
const ccr            = require('../../src/cross_chain_royalty_activation.js');
const { DB_METHODS } = require('./mockHub.js');

// An ANCHOR v0 section is root-bearing by construction (D8), so the base checkpoint
// row carries the two light-client roots and their version bytes; a row without them is
// skipped by the selector and never rides a bundle.
const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 494, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 7, snapshot_block: 100, validator_signatures: '[]', anchor_txid: 'feedbeef',
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

function matchRow(id, status) {
    return {
        id: 1,
        match_id: id, snapshot_block: 100, network: 'regtest',
        a_chain: 'LTC', a_action_index: 5, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'Lpay',
        b_chain: 'DOGE', b_action_index: 8, b_kind: 'swap', b_tick: null, b_amount: '2000',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'Dpay',
        effective_time: 1700000000, validator_signatures: null,   // signed per-mesh in buildMesh
        status: status || 'finalized', batch_root: null, anchor_txid: null, batch_seq: null, archived_status: null
    };
}

// XMATCH canonical (mirror of the publisher's matchCanonical) - fixtures sign
// real Ed25519 sigs over it so the follower's cryptographic verification passes.
function matchCanonical(m) {
    let raw = ['XMATCH', m.match_id, String(m.snapshot_block),
        m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
        m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
        String(m.effective_time), m.network || '',
        m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
        m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')].join('|');
    // Royalty legs ride the signed match at/above CROSS_CHAIN_ROYALTY (regtest genesis).
    if (ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
        raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
    // EQUIV active in regtest: TAG=XDEX, ROUND_ID=match_id, VIEW=finalizing_view (default 0).
    if (eq.isEquivHeaderActive(m.snapshot_block, m.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
    return raw;
}

function callRow(id, phase, status) {
    return {
        id: phase === 'result' ? 2 : 1,
        call_id: id, phase: phase || 'dispatch', snapshot_block: 100, network: 'regtest',
        source_chain: 'LTC', source_action_index: 41, source_contract_index: 7,
        target_chain: 'DOGE', target_contract_index: 9, method: 'onArrival',
        params_json: '["a","b"]', gas_limit: 50000, cross_hops: 0,
        effective_time: 1700000100,
        result_status: phase === 'result' ? 'ok' : null,
        return_payload_b64: phase === 'result' ? 'cGF5bG9hZA' : null,
        validator_signatures: null,                                // signed per-mesh in buildMesh
        status: status || 'finalized', anchor_txid: null, batch_seq: null, archived_status: null
    };
}

// XCALL phase canonicals (mirror of the publisher's callCanonical).
function callCanonical(c) {
    let sha = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
    let phase = (c.phase === 'result') ? 'result' : 'dispatch';
    let raw;
    if (c.phase === 'result') {
        raw = ['XCALL', 'RESULT', c.call_id, String(c.snapshot_block), c.network || '',
            c.target_chain, String(c.result_status || ''), sha(c.return_payload_b64), String(c.effective_time)].join('|');
    } else {
        raw = ['XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
            c.source_chain, String(c.source_action_index), String(c.source_contract_index),
            c.target_chain, String(c.target_contract_index), c.method, sha(c.params_json),
            String(c.gas_limit), String(c.cross_hops), String(c.effective_time)].join('|');
    }
    // EQUIV active in regtest: TAG=XCALL, ROUND_ID=sha256('XCALLROUND|'+phase+'|'+call_id), VIEW=finalizing_view.
    if (eq.isEquivHeaderActive(c.snapshot_block, c.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|' + phase + '|' + c.call_id), (c.finalizing_view != null ? c.finalizing_view : 0), raw);
    return raw;
}

// Walk an ANCHOR v0 bundle wire and return its sections' identities. The harness needs this
// in two places (modelling what a broadcast bundle puts on chain, and asserting section
// order/content), and doing it positionally here is the test's independent read of the
// field order the producer claims - not a call back into the producer.
function parseV7Sections(payload) {
    let f = String(payload).split('|');
    let count = Number(f[4]);
    let out = [], i = 5;
    for (let n = 0; n < count; n++) {
        let sigCount = Number(f[i + 12]);
        out.push({
            chain: f[i], block_index: Number(f[i + 1]),
            block_hash: f[i + 2], ledger_hash: f[i + 3], actions_hash: f[i + 4], contract_hash: f[i + 5],
            checkpoint_seq: Number(f[i + 6]), snapshot_block: Number(f[i + 7]),
            state_root: f[i + 8], state_root_version: f[i + 9],
            block_merkle_root: f[i + 10], block_merkle_version: f[i + 11],
            sigs: Array.from({ length: sigCount }, (_, k) => ({ pubkey: f[i + 13 + k * 2], sig: f[i + 14 + k * 2] }))
        });
        i += 13 + sigCount * 2;
    }
    return out;
}

// The v0 bundle publisher tail that follows the last section.
function parseV7Tail(payload) {
    let f = String(payload).split('|');
    let count = Number(f[4]), i = 5;
    for (let n = 0; n < count; n++) i += 13 + Number(f[i + 12]) * 2;
    let attestCount = Number(f[i + 1]);
    return {
        publisher: f[i], attestCount: attestCount,
        sigs: Array.from({ length: attestCount }, (_, k) => ({ pubkey: f[i + 2 + k * 2], sig: f[i + 3 + k * 2] }))
    };
}

// In-memory hub DB for the publisher's query surface.
// doQuery asks each query family below in turn; a family answers the SQL
// prefixes it owns from the arrays the db carries and returns undefined for
// any other statement, and SQL no family knows answers [].
function checkpointQuery(sql, params, s) {
    const checkpoints = s.checkpoints;
    if (sql.startsWith('SELECT sc.* FROM state_checkpoints sc JOIN')) {
        // Faithful to the SQL: eligibility is the checkpoint ORDINAL
        // (FLOOR(seq / CHECKPOINT_INTERVAL_BLOCKS)) mod N, not the raw seq. A
        // mock that kept `seq % N` would stay green on the halting predicate.
        let step   = params[0] || 1;                       // CHECKPOINT_INTERVAL_BLOCKS
        let everyN = params[1] || 1;                       // ANCHOR_CHECKPOINT_EVERY_N
        let net    = sql.includes('AND sc.network = ?') ? params[2] : null; // network scope (when configured)
        let latest = {};
        for (let r of checkpoints) {
            if (Math.floor(r.checkpoint_seq / step) % everyN !== 0) continue; // only anchor-eligible ordinals
            let k = r.chain + '|' + r.network;
            if (!latest[k] || r.checkpoint_seq > latest[k].checkpoint_seq) latest[k] = r;
        }
        return Object.values(latest).filter(r => r.anchor_txid == null && (net == null || r.network === net));
    }
    if (sql.startsWith("SELECT * FROM state_checkpoints WHERE network = ? ORDER BY (chain = 'BTC') DESC")) {
        let sorted = checkpoints.filter(r => r.network === params[0])
            .sort((x, y) => (y.chain === 'BTC') - (x.chain === 'BTC') || y.id - x.id);
        return sorted.slice(0, 1);
    }
    if (sql.startsWith("SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC")) {
        let sorted = checkpoints.slice().sort((x, y) => (y.chain === 'BTC') - (x.chain === 'BTC') || y.id - x.id);
        return sorted.slice(0, 1);
    }
    if (sql.startsWith('SELECT * FROM state_checkpoints WHERE chain = ?')) {
        // The bundle paths look a section up by its full identity, seq included;
        // the older callers pass three params and take the newest at the height.
        let hits = checkpoints.filter(r => r.chain === params[0] && r.network === params[1] && r.block_index === params[2]);
        if (sql.indexOf('AND checkpoint_seq = ?') !== -1) hits = hits.filter(r => r.checkpoint_seq === params[3]);
        else hits = hits.slice().sort((x, y) => y.checkpoint_seq - x.checkpoint_seq);
        return hits.slice(0, 1);
    }
    if (sql.startsWith('SELECT snapshot_block FROM state_checkpoints WHERE chain = ?')) {
        return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] && r.block_index === params[2])
            .sort((a, b) => b.checkpoint_seq - a.checkpoint_seq)
            .slice(0, 1).map(r => ({ snapshot_block: r.snapshot_block }));
    }
    if (sql.startsWith('UPDATE state_checkpoints SET anchor_txid')) {
        let onlyIfNull = sql.includes('anchor_txid IS NULL');
        for (let r of checkpoints)
            if (r.chain === params[1] && r.network === params[2] && r.block_index === params[3] &&
                (!onlyIfNull || r.anchor_txid == null)) r.anchor_txid = params[0];
        return [];
    }
    return undefined;
}

function matchQuery(sql, params, s) {
    const { matches, calls, rewardRows } = s;
    if (sql.startsWith('SELECT * FROM cross_chain_matches WHERE batch_seq IS NULL OR archived_status <> status')) {
        return matches.filter(r => r.batch_seq == null || r.archived_status !== r.status).slice(0, params[0]);
    }
    if (sql.startsWith('SELECT * FROM cross_chain_matches WHERE match_id = ?')) {
        return matches.filter(r => r.match_id === params[0]).slice(0, 1);
    }
    if (sql.startsWith('SELECT * FROM cross_chain_matches WHERE match_id IN')) {
        return matches.filter(r => params.includes(r.match_id) && r.status !== 'retracted');
    }
    if (sql.startsWith('SELECT COALESCE(GREATEST(')) {
        let max = -1;
        for (let r of matches)    if (r.batch_seq != null && r.batch_seq > max) max = r.batch_seq;
        for (let r of calls)      if (r.batch_seq != null && r.batch_seq > max) max = r.batch_seq;
        for (let r of rewardRows) if (r.batch_seq != null && r.batch_seq > max) max = r.batch_seq;
        return [{ next_seq: max + 1 }];
    }
    if (sql.startsWith('UPDATE cross_chain_matches SET batch_seq')) {
        let onlyEligible = sql.includes('batch_seq IS NULL OR archived_status <> status');
        for (let r of matches) if (r.match_id === params[3] &&
            (!onlyEligible || r.batch_seq == null || r.archived_status !== r.status)) {
            r.batch_seq = params[0]; r.archived_status = params[1];
            if (params[2] != null) r.anchor_txid = params[2];
        }
        return [];
    }
    return undefined;
}

function rewardQuery(sql, params, s) {
    const rewardRows = s.rewardRows;
    if (sql.startsWith('SELECT * FROM validator_rewards WHERE reward_type LIKE')) {
        return rewardRows.filter(r => /^anchor_/.test(String(r.reward_type)) && r.batch_seq == null && r.block_index != null)
            .sort((a, b) => String(a.reward_type).localeCompare(String(b.reward_type)) ||
                            a.round_number - b.round_number ||
                            String(a.validator_pubkey).localeCompare(String(b.validator_pubkey)))
            .slice(0, params[0]);
    }
    if (sql.startsWith('SELECT validator_pubkey, amount, block_index FROM validator_rewards')) {
        return rewardRows.filter(r => r.reward_type === params[0] && r.round_number === params[1]).slice(0, 1);
    }
    if (sql.startsWith('UPDATE validator_rewards SET batch_seq')) {
        let onlyPending = sql.includes('batch_seq IS NULL');
        for (let r of rewardRows)
            if (r.reward_type === params[1] && r.round_number === params[2] &&
                String(r.validator_pubkey).toLowerCase() === params[3] &&
                (!onlyPending || r.batch_seq == null)) r.batch_seq = params[0];
        return [];
    }
    return undefined;
}

function callQuery(sql, params, s) {
    const calls = s.calls;
    if (sql.startsWith('SELECT * FROM cross_chain_calls WHERE batch_seq IS NULL OR archived_status <> status')) {
        return calls.filter(r => r.batch_seq == null || r.archived_status !== r.status).slice(0, params[0]);
    }
    if (sql.startsWith('SELECT * FROM cross_chain_calls WHERE call_id = ?')) {
        return calls.filter(r => r.call_id === params[0] && r.phase === params[1]).slice(0, 1);
    }
    if (sql.startsWith('UPDATE cross_chain_calls SET batch_seq')) {
        let onlyEligible = sql.includes('batch_seq IS NULL OR archived_status <> status');
        for (let r of calls) if (r.call_id === params[3] && r.phase === params[4] &&
            (!onlyEligible || r.batch_seq == null || r.archived_status !== r.status)) {
            r.batch_seq = params[0]; r.archived_status = params[1];
            if (params[2] != null) r.anchor_txid = params[2];
        }
        return [];
    }
    return undefined;
}

function snapshotQuery(sql, params, s) {
    const snapshots = s.snapshots;
    if (sql.startsWith('SELECT snapshot_block, capability, signing_pubkey, amount FROM capability_snapshots')) {
        return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1])
            .sort((a, b) => a.signing_pubkey < b.signing_pubkey ? -1 : 1);
    }
    if (sql.startsWith('SELECT * FROM capability_snapshots WHERE snapshot_block = ?')) {
        return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1] && r.signing_pubkey === params[2]).slice(0, 1);
    }
    return undefined;
}

const QUERY_FAMILIES = [checkpointQuery, matchQuery, rewardQuery, callQuery, snapshotQuery];

function memDb() {
    let matches = [], checkpoints = [], snapshots = [], calls = [], rewardRows = [];
    const state = { matches, checkpoints, snapshots, calls, rewardRows };
    return { ...DB_METHODS,
        matches, checkpoints, snapshots, calls, rewardRows,
        async doQuery(sql, params) {
            params = params || [];
            for (const family of QUERY_FAMILIES) {
                const rows = family(sql, params, state);
                if (rows !== undefined) return rows;
            }
            return [];
        }
    };
}

module.exports = {
    CP_ROW, matchRow, matchCanonical, callRow, callCanonical, parseV7Sections, parseV7Tail, memDb
};
