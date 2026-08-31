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
const OracleBatchSigner = require('../../src/OracleBatchSigner');
const OracleConsensus   = require('../../src/OracleConsensus');
const ValidatorIdentity = require('../../src/ValidatorIdentity');

// The REAL canonical builder, taken off the class rather than reimplemented.
// _buildPriceBatchPayload is pure (it reads no instance state), so binding it to a
// bare object exercises the exact producer the hub signs with, without booting
// the whole PBFT engine. If it ever starts reading `this`, this line fails loudly
// rather than letting a second copy of the format creep into the tests.
const canonicalBuilder = { _buildPriceBatchPayload: OracleConsensus.prototype._buildPriceBatchPayload };

function buildCanonical(first, last, anchor, rounds) {
    return canonicalBuilder._buildPriceBatchPayload(first, last, anchor, rounds);
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
                status:          r.status || 'finalized'
            });
    return rows;
}

// In-memory stand-in for the hub Database over the ONE query the signer runs.
function memDb(rows) {
    return {
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

describe('OracleBatchSigner (XPRICEB batch-signing round)', function () {

    it('collects a quorum when the leader proposes what every peer independently re-derives', async function () {
        let mesh = buildMesh(4);
        let rounds = baseRounds();
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, rounds);
        mesh.stop();

        expect(res.met).to.equal(true);
        expect(res.firstRound).to.equal(100);
        expect(res.lastRound).to.equal(105);
        expect(res.btcBlockHeight).to.equal(5005);
        // 4 distinct sources, weight 1 each: 3*tally > 2*S needs 3 signers.
        expect(res.sigs.length).to.be.at.least(3);

        // Every returned signature verifies over the ONE canonical, and the canonical
        // is what the shared builder produces for this window.
        let canonical = buildCanonical(100, 105, 5005, rounds);
        expect(res.canonical).to.equal(canonical);
        for (let s of res.sigs) {
            expect(mesh.pubkeys).to.include(s.pubkey);
            expect(ValidatorIdentity.verify(canonical, s.sig, s.pubkey)).to.equal(true);
        }
        // No duplicate signers in the set the publisher would put on the wire.
        expect(new Set(res.sigs.map(s => s.pubkey)).size).to.equal(res.sigs.length);

        expect(mesh.nodes[0].signer.getStats().batchSignQuorums).to.equal(1);
        expect(mesh.nodes[0].signer.getStats().batchSignTimeouts).to.equal(0);
    });

    // THE POINT OF THE ROW. One altered price is enough: the honest peers rebuild
    // the canonical from their own rows, see a different string, and stay silent.
    it('refuses a dishonest leader: one altered price, no quorum, every honest peer silent', async function () {
        let mesh = buildMesh(4);
        let fabricated = clone(baseRounds());
        fabricated[3].pairs[0].price = '99999';          // a price no honest hub finalized

        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, fabricated);
        mesh.stop();

        expect(res.met).to.equal(false);
        // The leader is alone with its own signature; a quorum of 3 never forms.
        expect(res.sigs.length).to.equal(1);
        expect(res.sigs[0].pubkey).to.equal(mesh.pubkeys[0]);
        expect(mesh.nodes[0].signer.getStats().batchSignTimeouts).to.equal(1);
        expect(mesh.nodes[0].signer.getStats().batchSignQuorums).to.equal(0);

        for (let i = 1; i < mesh.nodes.length; i++) {
            let stats = mesh.nodes[i].signer.getStats();
            expect(stats.batchSignRefusals, 'peer ' + i + ' refused').to.equal(1);
            expect(stats.batchSignaturesProvided, 'peer ' + i + ' signed nothing').to.equal(0);
            // Silence, not a NACK: nothing at all went back on the wire.
            expect(mesh.nodes[i].sent).to.have.length(0);
        }
    });

    it('refuses a proposal that omits a round the peer holds', async function () {
        let mesh = buildMesh(4);
        let partial = clone(baseRounds()).filter(r => r.round !== 103);

        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, partial);
        mesh.stop();

        expect(res.met).to.equal(false);
        expect(res.sigs.length).to.equal(1);
        for (let i = 1; i < mesh.nodes.length; i++) {
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(1);
            expect(mesh.nodes[i].sent).to.have.length(0);
        }
    });

    it('refuses a proposal carrying a round the peer does not have', async function () {
        // The leader holds a seventh round; nobody else finalized it.
        let mesh = buildMesh(4, {
            perNodeRounds: (i) => {
                let rounds = baseRounds();
                if (i === 0) rounds.push({
                    round: 106, timestamp: 1700003600, btcBlockHeight: 5006,
                    pairs: [{ pair: 'BTC/USD', price: '60006' }, { pair: 'LTC/USD', price: '86' }]
                });
                return rounds;
            }
        });
        let leaderRounds = baseRounds();
        leaderRounds.push({
            round: 106, timestamp: 1700003600, btcBlockHeight: 5006,
            pairs: [{ pair: 'BTC/USD', price: '60006' }, { pair: 'LTC/USD', price: '86' }]
        });

        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 106, 5006, leaderRounds);
        mesh.stop();

        expect(res.met).to.equal(false);
        expect(res.sigs.length).to.equal(1);
        for (let i = 1; i < mesh.nodes.length; i++) {
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(1);
            expect(mesh.nodes[i].sent).to.have.length(0);
        }
    });

    it('signs a window containing a fully skipped round: legitimate absence must not block', async function () {
        // Round 102 is 'skipped' everywhere, so no honest batch contains it and the
        // canonical every node builds simply omits it.
        let withSkip = baseRounds().map(r => (r.round === 102 ? Object.assign({}, r, { status: 'skipped' }) : r));
        let mesh = buildMesh(4, { rounds: withSkip });

        let proposal = baseRounds().filter(r => r.round !== 102);
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, proposal);
        mesh.stop();

        expect(res.met).to.equal(true);
        expect(res.sigs.length).to.be.at.least(3);
        expect(res.canonical).to.equal(buildCanonical(100, 105, 5005, proposal));
        for (let i = 1; i < mesh.nodes.length; i++) {
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(0);
            expect(mesh.nodes[i].signer.getStats().batchSignaturesProvided).to.equal(1);
        }
    });

    it('refuses a round a reorg retracted (status disputed is not signable content)', async function () {
        // Every peer's round 101 was marked 'disputed' by the retraction fence; the
        // leader still holds it as finalized and proposes it.
        let mesh = buildMesh(4, {
            perNodeRounds: (i) => (i === 0 ? baseRounds()
                : baseRounds().map(r => (r.round === 101 ? Object.assign({}, r, { status: 'disputed' }) : r)))
        });

        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds());
        mesh.stop();

        expect(res.met).to.equal(false);
        for (let i = 1; i < mesh.nodes.length; i++)
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(1);
    });

    it('refuses a window straddling an armed oracle flag day', async function () {
        // mainnet STAKE_WEIGHTED_QUORUM activates at 961000; anchors 960998..961001
        // put the first and last rounds on opposite sides of it.
        let straddling = [960998, 960999, 961000, 961001].map((h, i) => ({
            round:          200 + i,
            timestamp:      1700100000 + i * 600,
            btcBlockHeight: h,
            pairs: [{ pair: 'BTC/USD', price: String(70000 + i) }]
        }));
        let mesh = buildMesh(4, { network: 'mainnet', rounds: straddling });

        let res = await mesh.nodes[0].signer.collectBatchSignatures(200, 203, 961001, straddling);
        mesh.stop();

        expect(res.met).to.equal(false);
        for (let i = 1; i < mesh.nodes.length; i++) {
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(1);
            expect(mesh.nodes[i].sent).to.have.length(0);
        }
    });

    it('counts a timeout and publishes nothing when no peer answers', async function () {
        let mesh = buildMesh(4);
        // Detach every peer: the requests go nowhere, exactly like a partitioned hub.
        for (let i = 1; i < mesh.nodes.length; i++) mesh.nodes[i].signer.stop();

        let started = Date.now();
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds());
        mesh.stop();

        expect(res.met).to.equal(false);
        expect(res.sigs.length).to.equal(1);          // the leader's own, for observability only
        expect(Date.now() - started).to.be.at.least(200);
        let stats = mesh.nodes[0].signer.getStats();
        expect(stats.batchSignTimeouts).to.equal(1);
        expect(stats.batchSignRounds).to.equal(1);
        expect(stats.batchSignQuorums).to.equal(0);
        expect(stats.batchSignTimeoutMs).to.equal(250);
    });

    it('ignores an XPRICEB_SIGN from a non-member and one carrying a bad signature', async function () {
        let mesh = buildMesh(4);
        let leader = mesh.nodes[0];
        let rounds = baseRounds();
        let canonical = buildCanonical(100, 105, 5005, rounds);

        // Detach the honest peers so only the injected messages reach the round.
        for (let i = 1; i < mesh.nodes.length; i++) mesh.nodes[i].signer.stop();

        let outsider = new ValidatorIdentity('ab'.repeat(32));
        let pending = leader.signer.collectBatchSignatures(100, 105, 5005, rounds);

        // Not in the price set at the anchor: a perfectly valid signature, ignored.
        await leader.signer._handleSign({ type: 'XPRICEB_SIGN', data: {
            first_round: 100, last_round: 105,
            pubkey: outsider.getPubkeyHex().toLowerCase(), sig: outsider.sign(canonical) } });
        // A member, but the signature is over other bytes.
        await leader.signer._handleSign({ type: 'XPRICEB_SIGN', data: {
            first_round: 100, last_round: 105,
            pubkey: mesh.pubkeys[1], sig: mesh.nodes[1].identity.sign(canonical + 'x') } });
        // A member signing a DIFFERENT window: wrong round, ignored.
        await leader.signer._handleSign({ type: 'XPRICEB_SIGN', data: {
            first_round: 100, last_round: 104,
            pubkey: mesh.pubkeys[2], sig: mesh.nodes[2].identity.sign(canonical) } });

        let res = await pending;
        mesh.stop();
        expect(res.met).to.equal(false);
        expect(res.sigs.length).to.equal(1);
    });

    it('withholds the batch when this hub does not hold `price` at the batch anchor', async function () {
        let mesh = buildMesh(4);
        let leader = mesh.nodes[0];
        // Drop the leader from the capability snapshot at the anchor.
        leader.hub.capabilitySnapshot.getWeightSnapshot = async () => ({
            validators: mesh.pubkeys.slice(1).map((pk, i) => ({ pubkey: pk, weight: '1', source: 'src' + (i + 1) }))
        });

        let res = await leader.signer.collectBatchSignatures(100, 105, 5005, baseRounds());
        mesh.stop();

        expect(res.met).to.equal(false);
        expect(res.sigs).to.have.length(0);
        // Not a timeout: the round never started, so the liveness counter stays clean.
        expect(leader.signer.getStats().batchSignTimeouts).to.equal(0);
    });
});
