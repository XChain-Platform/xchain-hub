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

// OracleBatchSigner: the XPRICEB batch-signing round.
//
// The load-bearing test in this file is "a dishonest leader cannot buy a
// quorum": every honest peer re-derives the batch from its OWN finalized
// price_snapshots and signs only on byte-equality, so a single altered price
// leaves the leader alone with its own signature until the round times out.
// The rest of the file pins the window-shape refusals around it (missing round,
// extra round, retracted round, straddling window) and the legitimate-absence
// case that must NOT refuse (a fully skipped round inside the window).
//
// Mesh harness mirrors StateAnchorPublisher.test.js's buildMesh: real Ed25519
// identities, an in-memory bus, an in-memory price_snapshots table per node.

const { expect }        = require('chai');
const OracleBatchSigner = require('../../../src/oracle/batch_signer');
const OracleConsensus   = require('../../../src/oracle/consensus');
const ValidatorIdentity = require('../../../src/validators/identity');
const { DB_METHODS } = require('../../helpers/mockHub.js');

// The REAL canonical builder, taken off the class rather than reimplemented.
// buildPriceBatchPayload is pure (it reads no instance state), so binding it to a
// bare object exercises the exact producer the hub signs with, without booting
// the whole PBFT engine. If it ever starts reading `this`, this line fails loudly
// rather than letting a second copy of the format creep into the tests.
const canonicalBuilder = { buildPriceBatchPayload: OracleConsensus.prototype.buildPriceBatchPayload };

function buildCanonical(first, last, anchor, rounds) {
    return canonicalBuilder.buildPriceBatchPayload(first, last, anchor, rounds);
}

// Six rounds, 100..105, one BTC anchor and timestamp each, two pairs each.
function baseRounds() {
    let out = [];
    for (let i = 0; i < 6; i++) {
        out.push({
            round:          100 + i,
            timestamp:      1700000000 + i * 600,
            btcBlockHeight: 5000 + i,
            pairs: [
                { pair: 'BTC/USD', price: String(60000 + i) },
                { pair: 'LTC/USD', price: String(80 + i) }
            ]
        });
    }
    return out;
}

function clone(rounds) {
    return JSON.parse(JSON.stringify(rounds));
}

// Flatten the canonical-builder round shape into price_snapshots rows.
function snapshotRows(rounds) {
    let rows = [];
    for (let r of rounds)
        for (let p of r.pairs)
            rows.push({
                round_number:    r.round,
                coin_pair:       p.pair,
                price:           p.price,
                reference_block: r.btcBlockHeight,
                block_timestamp: r.timestamp,
                status:          r.status || 'finalized',
                // What LEFT(consensus_proof, 8) returns. A v0-finalized round's proof
                // is a bare signature ARRAY; a round ingested from a landed batch
                // carries the {"batch":...} object of D23.
                proof_head:      r.batchSourced ? '{"batch"' : '[{"pubk'
            });
    return rows;
}

// In-memory stand-in for the hub Database over the ONE query the signer runs.
function memDb(rows) {
    return { ...DB_METHODS,
        rows: rows,
        queries: 0,
        async doQuery(sql, params) {
            this.queries++;
            if (!/FROM price_snapshots/.test(sql)) throw new Error('unexpected query: ' + sql);
            let [first, last, status] = params;
            return this.rows
                .filter(r => r.round_number >= first && r.round_number <= last && r.status === status)
                .map(r => Object.assign({}, r))
                .sort((a, b) => (a.round_number - b.round_number) ||
                                (a.coin_pair < b.coin_pair ? -1 : a.coin_pair > b.coin_pair ? 1 : 0));
        }
    };
}

// n meshed price validators, each holding its own copy of the window.
// opts.network     : 'regtest' (default) or 'mainnet' for the flag-day tests
// opts.rounds      : the window every node holds (default baseRounds())
// opts.perNodeRounds(i) : per-node override, for divergence tests
// opts.timeoutMs   : ORACLE_BATCH_SIGN_TIMEOUT_MS
function buildMesh(n, opts) {
    opts = opts || {};
    let network  = opts.network || 'regtest';
    let bus      = { nodes: [] };
    let identities = [];
    for (let i = 0; i < n; i++) identities.push(new ValidatorIdentity(String(10 + i).repeat(32).slice(0, 64)));
    let pubkeys  = identities.map(id => id.getPubkeyHex().toLowerCase());
    // One distinct staking SOURCE per validator, weight 1: meetsStakeThreshold
    // dedupes by source and fails closed on a blank one, so a shared source would
    // collapse the whole set into a 1-of-N quorum.
    let weighted = pubkeys.map((pk, i) => ({ pubkey: pk, weight: '1', source: 'src' + i }));
    let counted  = pubkeys.map(pk => ({ pubkey: pk, amount: '1' }));

    for (let i = 0; i < n; i++) {
        let identity = identities[i];
        let self = { i, identity, pubkey: pubkeys[i], handler: null, sent: [] };
        let peerManager = {
            on(evt, h) { if (evt === 'message') self.handler = h; },
            removeListener(evt) { if (evt === 'message') self.handler = null; },
            broadcast(type, data) {
                self.sent.push({ type, data });
                let env = { type, sender: self.pubkey, sig_pubkey: self.pubkey, data };
                for (let other of bus.nodes) {
                    if (other === self) continue;
                    if (other.handler) other.handler(env);
                }
            }
        };
        let rounds = opts.perNodeRounds ? opts.perNodeRounds(i) : (opts.rounds || baseRounds());
        let db = memDb(snapshotRows(rounds));
        let hub = {
            db,
            network,
            p2pConfig: { ORACLE_BATCH_SIGN_TIMEOUT_MS: String(opts.timeoutMs || 250) },
            capabilitySnapshot: {
                async getWeightSnapshot() { return { validators: weighted }; },
                async getSnapshot()       { return { validators: counted }; }
            },
            getPeerManager: () => peerManager,
            getIdentity:    () => identity,
            oracleConsensus: canonicalBuilder
        };
        self.hub    = hub;
        self.db     = db;
        self.signer = new OracleBatchSigner(hub);
        self.signer.start();
        bus.nodes.push(self);
    }
    bus.pubkeys = pubkeys;
    bus.stop = () => { for (let node of bus.nodes) node.signer.stop(); };
    return bus;
}

module.exports = {
    expect,
    OracleBatchSigner,
    OracleConsensus,
    ValidatorIdentity,
    DB_METHODS,
    canonicalBuilder,
    buildCanonical,
    baseRounds,
    clone,
    snapshotRows,
    memDb,
    buildMesh
};
