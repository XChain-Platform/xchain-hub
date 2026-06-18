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

// In-process PBFT mesh: K CrossChainDexConsensus instances share a mock gossip
// bus (broadcast fans out to every other instance's _handleMessage), each with a
// real ValidatorIdentity. Exercises the full round (PROPOSE/PREPARE/COMMIT),
// single-node fallback, Byzantine-value tolerance, leader-failover via
// view-change, and the tamper / NEW_VIEW guards. The same properties validated
// for AttestationConsensus/Consensus can only be checked in a mesh.

const { expect }             = require('chai');
const CrossChainDexConsensus = require('../../src/CrossChainDexConsensus');
const ValidatorIdentity      = require('../../src/ValidatorIdentity');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Canonical format byte-identical to the indexer verifier (cross_settle._canonical).
function canonicalMatch(r) {
    return ['XMATCH', r.match_id, String(r.snapshot_block),
        r.a_chain, String(r.a_action_index), r.a_tick || '', String(r.a_amount), String(r.a_ownership), r.a_payout_addr,
        r.b_chain, String(r.b_action_index), r.b_tick || '', String(r.b_amount), String(r.b_ownership), r.b_payout_addr,
        String(r.effective_time), r.network || ''].join('|');
}
function sampleRow(matchId) {
    return { match_id: matchId, snapshot_block: 100, network: 'regtest',
        a_chain: 'LTC', a_action_index: 5, a_tick: 'TOKA', a_amount: '1000', a_ownership: 0, a_payout_addr: 'Lpay',
        b_chain: 'DOGE', b_action_index: 8, b_tick: 'TOKB', b_amount: '2000', b_ownership: 0, b_payout_addr: 'Dpay',
        effective_time: 1700000000 };
}

describe('CrossChainDexConsensus (PBFT mesh)', function () {

    let buses = [];

    afterEach(async function () {
        for (let bus of buses) { for (let nd of bus.nodes) await nd.consensus.stop(); }
        buses = [];
    });

    // Build n consensus instances over a shared in-memory gossip bus.
    // opts.validate(self) → bool (default true); opts.drop(self,other,type,data) → bool;
    // opts.roundTimeoutMs → view-change timeout.
    function buildMesh(n, opts) {
        opts = opts || {};
        let bus = { nodes: [] };
        for (let i = 0; i < n; i++) {
            let identity = new ValidatorIdentity(String(10 + i).repeat(32).slice(0, 64));
            let self = { i, identity, pubkey: identity.getPubkeyHex().toLowerCase(), handler: null, crashed: false };
            let peerManager = {
                validatorAddr: self.pubkey,
                on(evt, h) { if (evt === 'message') self.handler = h; },
                removeListener(evt) { if (evt === 'message') self.handler = null; },
                broadcast(type, data) {
                    let env = { type, sender: self.pubkey, data };
                    for (let other of bus.nodes) {
                        if (other === self || other.crashed) continue;
                        if (opts.drop && opts.drop(self, other, type, data)) continue;
                        if (other.handler) other.handler(env);
                    }
                }
            };
            let engine = {
                hub: { p2pConfig: { XDEX_ROUND_TIMEOUT_MS: opts.roundTimeoutMs || 120000 } },
                peerManager, identity, capSnapshot: null,
                _canonicalMatch: canonicalMatch,
                _persistCapabilitySnapshot: async () => {},
                validateProposedMatch: async () => (opts.validate ? opts.validate(self) : true)
            };
            self.consensus = new CrossChainDexConsensus(engine);
            self.finalized = [];
            self.consensus.on('match:finalized', (ev) => self.finalized.push(ev));
            bus.nodes.push(self);
        }
        buses.push(bus);
        return bus;
    }
    // STAKE_WEIGHTED_QUORUM (WI-1) is active at regtest snapshot_block 0+, so the
    // round finalizes on summed signer STAKE (source-deduped, 3·Σweight > 2·S) rather
    // than signer count. Each node is its OWN distinct staking source with weight 1,
    // so the equal-stake mesh reduces to the same 2f+1 threshold the count rule gave:
    // a blank/missing source fails closed in meetsStakeThreshold (never finalizes).
    function validatorsOf(bus) { return bus.nodes.map(nd => ({ pubkey: nd.pubkey, source: 'src:' + nd.pubkey, weight: '1', amount: '1' })); }
    async function startAll(bus) { for (let nd of bus.nodes) await nd.consensus.start(); }
    function leaderPubkey(bus, matchId, view) {
        let sorted = bus.nodes.map(nd => nd.pubkey).sort();
        return sorted[(parseInt(matchId.slice(0, 8), 16) + (view || 0)) % sorted.length];
    }
    async function proposeAll(bus, mid, row) {
        let snap = { validators: validatorsOf(bus), count: bus.nodes.length };
        for (let nd of bus.nodes) if (!nd.crashed) await nd.consensus.propose(mid, { row, snapshot: snap });
    }

    it('N=4: reaches 2f+1 and every node finalizes the same match with verifying sigs', async function () {
        let bus = buildMesh(4);
        await startAll(bus);
        let mid = 'aa'.repeat(32), row = sampleRow(mid);
        await proposeAll(bus, mid, row);
        await sleep(150);

        expect(bus.nodes.every(nd => nd.finalized.length === 1)).to.be.true;
        let ev = bus.nodes[0].finalized[0];
        expect(ev.signatures.length).to.be.at.least(3);                 // quorum 2f+1 = 3
        let canon = canonicalMatch(row);
        expect(ev.signatures.every(s => ValidatorIdentity.verify(canon, s.sig, s.pubkey))).to.be.true;
        expect(bus.nodes.every(nd => nd.finalized[0].matchId === mid)).to.be.true;
    });

    it('N=1: quorum 0 collapses to immediate self-sign + finalize', async function () {
        let bus = buildMesh(1);
        await startAll(bus);
        let mid = 'bb'.repeat(32), row = sampleRow(mid);
        await proposeAll(bus, mid, row);
        await sleep(20);
        let ev = bus.nodes[0].finalized[0];
        expect(ev).to.exist;
        expect(ev.signatures.length).to.equal(1);
        expect(ValidatorIdentity.verify(canonicalMatch(row), ev.signatures[0].sig, ev.signatures[0].pubkey)).to.be.true;
    });

    it('tolerates 1 of 4 refusing to validate (honest majority still finalizes)', async function () {
        let bus = buildMesh(4, { validate: (self) => self.i !== 2 });   // node 2 refuses
        await startAll(bus);
        let mid = 'cc'.repeat(32), row = sampleRow(mid);
        await proposeAll(bus, mid, row);
        await sleep(150);
        expect([0, 1, 3].every(i => bus.nodes[i].finalized.length === 1)).to.be.true;
    });

    it('does NOT finalize when 2 of 4 refuse (quorum unreachable, safety)', async function () {
        let bus = buildMesh(4, { validate: (self) => !(self.i === 2 || self.i === 3) });
        await startAll(bus);
        let mid = 'dd'.repeat(32), row = sampleRow(mid);
        await proposeAll(bus, mid, row);
        await sleep(150);
        expect(bus.nodes.some(nd => nd.finalized.length > 0)).to.be.false;
    });

    it('leader failover: a crashed leader is rotated out via view-change and the round finalizes', async function () {
        this.timeout(5000);
        let mid = 'ee'.repeat(32);
        let bus = buildMesh(4, { roundTimeoutMs: 80 });
        let crashed = bus.nodes.find(nd => nd.pubkey === leaderPubkey(bus, mid, 0));
        crashed.crashed = true;                                         // never participates
        await startAll(bus);
        await proposeAll(bus, mid, sampleRow(mid));
        await sleep(1300);                                              // a few 80ms view-change rounds
        expect(bus.nodes.filter(nd => !nd.crashed && nd.finalized.length === 1).length).to.equal(3);
    });

    it('guard: a tampered-row PROPOSE (fails independent validation) is not signed', async function () {
        // Followers no longer require byte-equality with their locally pre-built
        // canonical (leader-choice fields legitimately differ); independent
        // validation is the gate. Model an engine that, like the real ones,
        // verifies business fields against its own data.
        let bus = buildMesh(4, { validate: () => true });
        bus.nodes.forEach(nd => {
            nd.consensus.engine.validateProposedMatch = async (row) => String(row.a_amount) === '1000';
        });
        await startAll(bus);
        let mid = 'ff'.repeat(32), row = sampleRow(mid);
        let victim = bus.nodes[0];
        await victim.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 4 } });
        let leaderPk = leaderPubkey(bus, mid, 0);
        let leaderNode = bus.nodes.find(nd => nd.pubkey === leaderPk);
        let badRow = Object.assign({}, row, { a_amount: '999999' });
        let badSig = leaderNode.identity.sign(canonicalMatch(badRow));
        let before = victim.consensus.pending.get(mid).signatures.size;
        victim.consensus._handleMessage({ type: 'XDEX_MATCH_PROPOSE', sender: leaderPk,
            data: { matchId: mid, view: 0, row: badRow, sig_pubkey: leaderPk, sig: badSig } });
        await sleep(30);
        expect(victim.consensus.pending.get(mid).signatures.size).to.equal(before);
        expect(victim.consensus.pending.get(mid).canonical).to.equal(canonicalMatch(row)); // no adoption either
    });

    it('followers ADOPT a validated leader canonical whose leader-choice fields differ (regression: per-hub effective_time deadlock)', async function () {
        // Every hub pre-builds its row at discovery with its OWN clock second and
        // chain-tip view. Byte-equality used to silently drop the leader's
        // PROPOSE, deadlocking the round (live finding: 3-hub XCALL relay,
        // 2026-06-11). Each node here proposes a row with a different
        // effective_time; the round must still finalize on the LEADER's
        // canonical with quorum verifying sigs on every node.
        let bus = buildMesh(4);
        await startAll(bus);
        let mid = 'a1'.repeat(32);
        let snap = { validators: validatorsOf(bus), count: 4 };
        for (let k = 0; k < bus.nodes.length; k++) {
            let row = Object.assign(sampleRow(mid), { effective_time: 1700000000 + k });
            await bus.nodes[k].consensus.propose(mid, { row, snapshot: snap });
        }
        await sleep(200);

        expect(bus.nodes.every(nd => nd.finalized.length === 1),
               'every node finalizes').to.be.true;
        // All nodes converged on ONE canonical (the leader's), and every
        // emitted signature verifies against it (no empty-signature rows).
        let leaderPk = leaderPubkey(bus, mid, 0);
        let leaderIdx = bus.nodes.findIndex(nd => nd.pubkey === leaderPk);
        let leaderCanon = canonicalMatch(Object.assign(sampleRow(mid), { effective_time: 1700000000 + leaderIdx }));
        for (let nd of bus.nodes) {
            let ev = nd.finalized[0];
            expect(canonicalMatch(ev.row)).to.equal(leaderCanon);
            expect(ev.signatures.length, 'collected sigs on node ' + nd.i).to.be.at.least(3);
            expect(ev.signatures.every(s => ValidatorIdentity.verify(leaderCanon, s.sig, s.pubkey))).to.be.true;
        }
    });

    it('FINAL_SYNC: a straggler that missed a finalized round catches up via state transfer (regression: lost callback)', async function () {
        // Live finding: one hub missed a result round (validation raced the
        // confirmation depth); the others finalized and thereafter ignored the
        // round, so the straggler's mirror NEVER got the row. Its VIEW_CHANGE
        // heartbeat must now elicit a FINAL_SYNC carrying the row + quorum
        // signatures, which it verifies and finalizes from.
        this.timeout(5000);
        let partitioned = true;
        let bus = buildMesh(4, {
            roundTimeoutMs: 150,
            drop: (self, other) => partitioned && (self.i === 0 || other.i === 0)
        });
        await startAll(bus);
        let mid = 'c3'.repeat(32), row = sampleRow(mid);
        await proposeAll(bus, mid, row);
        await sleep(100);

        // nodes 1-3 finalized without node 0
        expect([1, 2, 3].every(i => bus.nodes[i].finalized.length === 1)).to.be.true;
        expect(bus.nodes[0].finalized.length).to.equal(0);

        // heal the partition; node 0's view-change timer fires and a finalized
        // peer answers with FINAL_SYNC
        partitioned = false;
        await sleep(400);

        expect(bus.nodes[0].finalized.length, 'straggler caught up').to.equal(1);
        let ev = bus.nodes[0].finalized[0];
        expect(ev.signatures.length).to.be.at.least(3);                  // the round's quorum proof
        let canon = canonicalMatch(ev.row);
        expect(ev.signatures.every(s => ValidatorIdentity.verify(canon, s.sig, s.pubkey))).to.be.true;
    });

    it('guard: a FINAL_SYNC without a quorum of verifying signatures is ignored', async function () {
        let bus = buildMesh(4, { drop: () => true });                     // isolated victim
        await startAll(bus);
        let mid = 'd4'.repeat(32), row = sampleRow(mid);
        let victim = bus.nodes[0];
        await victim.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 4 } });

        // one real signature (below quorum 3) + one garbage signature
        let signer = bus.nodes[1];
        victim.consensus._handleMessage({ type: 'XDEX_MATCH_FINAL_SYNC', sender: signer.pubkey,
            data: { matchId: mid, row, signatures: [
                { pubkey: signer.pubkey, sig: signer.identity.sign(canonicalMatch(row)) },
                { pubkey: bus.nodes[2].pubkey, sig: 'ab'.repeat(64) }
            ] } });
        await sleep(30);
        expect(victim.finalized.length).to.equal(0);
        expect(victim.consensus.pending.get(mid).finalized).to.equal(false);
    });

    it('guard: COMMIT votes without a verifying signature never count toward quorum', async function () {
        // Counting unverified commits let a node whose canonical diverged
        // "finalize" with zero collected signatures (live finding: hub1 wrote a
        // 0-sig mirror row). Feed a victim commits with garbage sigs; the round
        // must NOT finalize.
        let bus = buildMesh(4, { drop: () => true });   // isolate: no real gossip
        await startAll(bus);
        let mid = 'b2'.repeat(32), row = sampleRow(mid);
        let victim = bus.nodes[0];
        await victim.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 4 } });
        for (let nd of bus.nodes) {
            if (nd === victim) continue;
            victim.consensus._handleMessage({ type: 'XDEX_MATCH_COMMIT', sender: nd.pubkey,
                data: { matchId: mid, view: 0, sig_pubkey: nd.pubkey, sig: 'de'.repeat(64) } });
            victim.consensus._handleMessage({ type: 'XDEX_MATCH_COMMIT', sender: nd.pubkey,
                data: { matchId: mid, view: 0, sig_pubkey: nd.pubkey, sig: null } });
        }
        await sleep(50);
        expect(victim.finalized.length).to.equal(0);
        expect(victim.consensus.pending.get(mid).commits.size).to.equal(0);
    });

    it('guard: NEW_VIEW from a non-leader, and view-rewind, are ignored', async function () {
        let bus = buildMesh(4);
        await startAll(bus);
        let mid = 'ab'.repeat(32), row = sampleRow(mid);
        let victim = bus.nodes[0];
        await victim.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 4 } });
        let p = victim.consensus.pending.get(mid);
        let startView = p.view;

        // NEW_VIEW for the next view from a node that is NOT its designated leader → ignored.
        let nextView = startView + 1;
        let nonLeader = bus.nodes.find(nd => nd.pubkey !== leaderPubkey(bus, mid, nextView));
        victim.consensus._handleMessage({ type: 'XDEX_MATCH_NEW_VIEW', sender: nonLeader.pubkey,
            data: { matchId: mid, view: nextView, sig_pubkey: nonLeader.pubkey,
                    sig: nonLeader.identity.sign('XDEXNV|' + mid + '|' + nextView) } });
        expect(victim.consensus.pending.get(mid).view).to.equal(startView);

        // A NEW_VIEW that would rewind the view (even from the right leader) is ignored.
        victim.consensus.pending.get(mid).view = 3;
        let ldPk = leaderPubkey(bus, mid, 2);
        let ldNode = bus.nodes.find(nd => nd.pubkey === ldPk);
        victim.consensus._handleMessage({ type: 'XDEX_MATCH_NEW_VIEW', sender: ldPk,
            data: { matchId: mid, view: 2, sig_pubkey: ldPk, sig: ldNode.identity.sign('XDEXNV|' + mid + '|2') } });
        expect(victim.consensus.pending.get(mid).view).to.equal(3);
    });
});
