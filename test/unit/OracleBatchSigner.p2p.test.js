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

// OracleBatchSigner over the REAL P2P layer.
//
// OracleBatchSigner.test.js proves the signing RULES against an in-memory bus.
// This file proves the WIRING: three real PeerManagers, real signed envelopes
// over loopback WebSockets, and XPRICEB_SIGN_REQ / XPRICEB_SIGN routing through
// the same type-agnostic `message` event every other engine subscribes to
// (PeerManager carries no per-type registry; StateAnchorPublisher's XANCPUB pair
// is wired exactly this way).
//
// No database: PeerManager's only DB use is the fire-and-forget p2p_peers
// upsert, which no-ops on a null db.

const net               = require('net');
const { expect }        = require('chai');
const PeerManager       = require('../../src/PeerManager');
const OracleBatchSigner = require('../../src/OracleBatchSigner');
const OracleConsensus   = require('../../src/OracleConsensus');
const ValidatorIdentity = require('../../src/ValidatorIdentity');
const { waitUntil }     = require('../helpers/waitUntil');

const canonicalBuilder = { _buildPriceBatchPayload: OracleConsensus.prototype._buildPriceBatchPayload };

function baseRounds() {
    let out = [];
    for (let i = 0; i < 6; i++) {
        out.push({
            round:          300 + i,
            timestamp:      1700200000 + i * 600,
            btcBlockHeight: 6000 + i,
            pairs: [{ pair: 'BTC/USD', price: String(61000 + i) },
                    { pair: 'DOGE/USD', price: String(0.1 + i) }]
        });
    }
    return out;
}

function snapshotRows(rounds) {
    let rows = [];
    for (let r of rounds)
        for (let p of r.pairs)
            rows.push({ round_number: r.round, coin_pair: p.pair, price: String(p.price),
                        reference_block: r.btcBlockHeight, block_timestamp: r.timestamp,
                        status: 'finalized' });
    return rows;
}

function memDb(rows) {
    return {
        async doQuery(sql, params) {
            let [first, last, status] = params;
            return rows.filter(r => r.round_number >= first && r.round_number <= last && r.status === status)
                       .map(r => Object.assign({}, r));
        }
    };
}

// Reserve a loopback port by binding and releasing it, so SEED_NODES can be
// written before any PeerManager starts listening.
function freePort() {
    return new Promise((resolve, reject) => {
        let srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            let port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

describe('OracleBatchSigner over real P2P transport', function () {
    this.timeout(20000);

    let managers = [];
    let signers  = [];

    async function bootMesh(n, perNodeRounds) {
        let ports = [];
        for (let i = 0; i < n; i++) ports.push(await freePort());
        let addrs = ports.map(p => 'ws://127.0.0.1:' + p);
        let identities = [];
        for (let i = 0; i < n; i++) identities.push(new ValidatorIdentity(String(20 + i).repeat(32).slice(0, 64)));
        let pubkeys = identities.map(id => id.getPubkeyHex().toLowerCase());
        let weighted = pubkeys.map((pk, i) => ({ pubkey: pk, weight: '1', source: 'src' + i }));

        for (let i = 0; i < n; i++) {
            let pm = new PeerManager({
                P2P_VALIDATOR_ADDR:     addrs[i],
                P2P_PORT:               ports[i],
                P2P_HOST:               '127.0.0.1',
                SEED_NODES:             addrs.filter((_, j) => j !== i),
                REQUIRE_SIGNATURES:     true,
                P2P_HEARTBEAT_INTERVAL: 600000,
                P2P_RECONNECT_BASE:     50,
                P2P_PING_INTERVAL:      600000,
                P2P_MSG_DEDUP_TTL:      60000
            }, null);
            pm.setIdentity(identities[i]);
            // Option A transport auth: every mesh key is chain-effective here, which is
            // what a live federation's snapshot refresh installs.
            pm.setEffectiveSignerSet(new Set(pubkeys));
            await pm.start();
            managers.push(pm);

            let hub = {
                db: memDb(snapshotRows(perNodeRounds ? perNodeRounds(i) : baseRounds())),
                network: 'regtest',
                p2pConfig: { ORACLE_BATCH_SIGN_TIMEOUT_MS: '1500' },
                capabilitySnapshot: {
                    async getWeightSnapshot() { return { validators: weighted }; },
                    async getSnapshot()       { return { validators: weighted }; }
                },
                getPeerManager: () => pm,
                getIdentity:    () => identities[i],
                oracleConsensus: canonicalBuilder
            };
            let signer = new OracleBatchSigner(hub);
            signer.start();
            signers.push(signer);
        }

        // Every node must see n-1 open peers before a broadcast can reach quorum.
        await waitUntil(() => managers.every(pm =>
            pm.getPeerStatus().filter(p => p.state === 'open').length >= n - 1),
            { timeoutMs: 10000, label: 'the ' + n + '-node mesh to fully connect' });

        return { pubkeys, identities };
    }

    afterEach(async function () {
        for (let s of signers) s.stop();
        // Stop every manager CONCURRENTLY. PeerManager.stop() awaits
        // httpServer.close(), which does not resolve while another still-running
        // node holds an inbound socket, so a sequential teardown deadlocks.
        let stopping = managers.map(pm => pm.stop());
        for (let pm of managers)
            if (pm.httpServer && pm.httpServer.closeAllConnections) pm.httpServer.closeAllConnections();
        await Promise.all(stopping);
        managers = []; signers = [];
    });

    it('routes XPRICEB_SIGN_REQ/XPRICEB_SIGN through the real gossip layer to a quorum', async function () {
        let { pubkeys } = await bootMesh(3);
        let rounds = baseRounds();

        let res = await signers[0].collectBatchSignatures(300, 305, 6005, rounds);

        expect(res.met).to.equal(true);
        expect(res.sigs.length).to.be.at.least(2);
        let canonical = canonicalBuilder._buildPriceBatchPayload(300, 305, 6005, rounds);
        expect(res.canonical).to.equal(canonical);
        for (let s of res.sigs) {
            expect(pubkeys).to.include(s.pubkey);
            expect(ValidatorIdentity.verify(canonical, s.sig, s.pubkey)).to.equal(true);
        }
    });

    it('gives a dishonest leader no quorum across the real transport', async function () {
        await bootMesh(3);
        let fabricated = baseRounds();
        fabricated[2].pairs[0].price = '1';        // a price no peer finalized

        let res = await signers[0].collectBatchSignatures(300, 305, 6005, fabricated);

        expect(res.met).to.equal(false);
        expect(res.sigs.length).to.equal(1);
        expect(signers[0].getStats().batchSignTimeouts).to.equal(1);
        for (let i = 1; i < signers.length; i++) {
            expect(signers[i].getStats().batchSignRefusals).to.equal(1);
            expect(signers[i].getStats().batchSignaturesProvided).to.equal(0);
        }
    });
});
