'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// In-process PBFT mesh: K CrossChainDexConsensus instances share a mock gossip
// bus (broadcast fans out to every other instance's _handleMessage), each with a
// real ValidatorIdentity. Exercises the full round (PROPOSE/PREPARE/COMMIT),
// single-node fallback, Byzantine-value tolerance, leader-failover via
// view-change, and the tamper / NEW_VIEW guards — the same properties validated
// for AttestationConsensus/Consensus, which can only be checked in a mesh.

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
    function validatorsOf(bus) { return bus.nodes.map(nd => ({ pubkey: nd.pubkey, amount: '1' })); }
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

    it('does NOT finalize when 2 of 4 refuse (quorum unreachable — safety)', async function () {
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

    it('guard: a tampered-row PROPOSE (wrong canonical) is not signed', async function () {
        let bus = buildMesh(4);
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
