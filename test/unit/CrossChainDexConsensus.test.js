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
const { waitUntil }          = require('../helpers/waitUntil');

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
                // opts.canonical simulates the EQUIV-header-active engine, whose
                // canonical folds the view (H-8 regression); default ignores view.
                _canonicalMatch: opts.canonical || canonicalMatch,
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
        await waitUntil(() => bus.nodes.every(nd => nd.finalized.length === 1), { label: 'every node to finalize the match' });

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
        await waitUntil(() => bus.nodes[0].finalized.length === 1, { label: 'the single-node round to self-finalize' });
        let ev = bus.nodes[0].finalized[0];
        expect(ev).to.exist;
        expect(ev.signatures.length).to.equal(1);
        expect(ValidatorIdentity.verify(canonicalMatch(row), ev.signatures[0].sig, ev.signatures[0].pubkey)).to.be.true;
    });

    // M-13: after a round finalizes, its id sits in the finalized ring and propose()
    // is a no-op (steady-state dedup). A reorg that RETRACTS the row then re-confirms
    // the action must be able to re-run the round; forgetFinalized drops the ring
    // entry so the next propose() finalizes a FRESH round instead of stranding the
    // call/match in 'retracted' forever.
    it('forgetFinalized lets a retracted-then-reconfirmed round re-finalize (M-13)', async function () {
        let bus = buildMesh(1);
        await startAll(bus);
        let nd = bus.nodes[0];
        let mid = 'cc'.repeat(32), row = sampleRow(mid);

        await nd.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 1 } });
        await waitUntil(() => nd.finalized.length === 1, { label: 'the first round to finalize' });
        expect(nd.finalized.length).to.equal(1);
        expect(nd.consensus.finalized.has(mid)).to.equal(true);

        // Without forgetting, a re-propose is suppressed by the finalized ring.
        await nd.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 1 } });
        // The finalized ring is consulted inside propose(), so the duplicate is already
        // suppressed here; a settle would only add dead time to a decided outcome.
        expect(nd.finalized.length).to.equal(1, 'ring must suppress a duplicate finalize');

        // Retraction clears the ring; the next propose runs a fresh round.
        expect(nd.consensus.forgetFinalized(mid)).to.equal(true);
        expect(nd.consensus.finalized.has(mid)).to.equal(false);
        await nd.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 1 } });
        await waitUntil(() => nd.finalized.length === 2, { label: 'the re-proposed round to finalize a second time' });
        expect(nd.finalized.length).to.equal(2, 're-confirmed action must re-finalize after retraction');
    });

    it('does NOT self-finalize over an EMPTY snapshot (bootstrap/mirror-lag wedge guard)', async function () {
        // quorum 0 from an empty snapshot must NOT collapse to the single-operator
        // fast path: a 1-sig match no populated-snapshot peer will ratify wedges the
        // order and forks this hub's ledger. The round must abort and stay retryable.
        let bus = buildMesh(1);
        await startAll(bus);
        let mid = 'ab'.repeat(32), row = sampleRow(mid);
        let abandoned = [];
        bus.nodes[0].consensus.on('match:abandoned', (ev) => abandoned.push(String(ev.matchId)));
        await bus.nodes[0].consensus.propose(mid, { row, snapshot: { validators: [], count: 0 } });
        // The refusal announces itself: match:abandoned is what releases the engine slot.
        await waitUntil(() => abandoned.includes(mid.toLowerCase()), { label: 'the empty-snapshot round to abandon' });
        expect(bus.nodes[0].finalized.length).to.equal(0);
        // Aborted, not left half-open: a later propose with a real snapshot can retry.
        expect(bus.nodes[0].consensus.pending.has(mid.toLowerCase())).to.be.false;
        // The refuse must emit match:abandoned so the engine releases its _inflight slot;
        // without it the engine (which added round_id to _inflight before propose) never
        // re-attempts the call/match on this hub even once the snapshot populates.
        expect(abandoned).to.include(mid.toLowerCase());
    });

    it('fails CLOSED over a TRUNCATED weighted snapshot and releases the round (SWQ-TRUNC)', async function () {
        // At/above STAKE_WEIGHTED_QUORUM (regtest = genesis) a snapshot that overflowed
        // VALIDATOR_QUERY_LIMIT under-counts summed stake S; every indexer consumer fails
        // closed on it, so the hub must refuse rather than mirror a row all indexers reject.
        let bus = buildMesh(4);
        await startAll(bus);
        let mid = 'ad'.repeat(32), row = sampleRow(mid);   // regtest snapshot_block 100 -> weighted
        let abandoned = [];
        for (let nd of bus.nodes) nd.consensus.on('match:abandoned', (ev) => abandoned.push(String(ev.matchId)));
        let snap = { validators: validatorsOf(bus), count: bus.nodes.length };
        snap.validators.truncated = true;                  // indexer hit VALIDATOR_QUERY_LIMIT
        for (let nd of bus.nodes) await nd.consensus.propose(mid, { row, snapshot: snap });
        await waitUntil(() => abandoned.filter(m => m === mid.toLowerCase()).length === bus.nodes.length, { label: 'every node to abandon the truncated weighted round' });
        expect(bus.nodes.every(nd => nd.finalized.length === 0), 'no node finalizes a truncated weighted round').to.be.true;
        expect(bus.nodes.every(nd => nd.consensus.pending.has(mid.toLowerCase()) === false), 'round released, retryable').to.be.true;
        expect(abandoned.filter(m => m === mid.toLowerCase()).length).to.equal(bus.nodes.length, 'each node releases its inflight slot');
    });

    it('a TRUNCATED count snapshot (below STAKE_WEIGHTED_QUORUM) still finalizes (deterministic cap)', async function () {
        // The count path is proceed-on-truncation: the cap is cross-hub deterministic, so
        // quorum stays consistent fleet-wide (CapabilitySnapshot.getQuorum). Only the
        // weighted path fails closed.
        let bus = buildMesh(4);
        await startAll(bus);
        let mid = 'ae'.repeat(32), row = sampleRow(mid);
        row.network = 'mainnet'; row.snapshot_block = 100;   // below 961000 -> count path
        let snap = { validators: validatorsOf(bus), count: bus.nodes.length };
        snap.validators.truncated = true;
        for (let nd of bus.nodes) await nd.consensus.propose(mid, { row, snapshot: snap });
        await waitUntil(() => bus.nodes.every(nd => nd.finalized.length === 1), { label: 'the count path to finalize on every node' });
        expect(bus.nodes.every(nd => nd.finalized.length === 1), 'count path proceeds on a deterministic truncation cap').to.be.true;
    });

    it('does NOT self-finalize when the sole snapshot validator is someone else', async function () {
        let bus = buildMesh(1);
        await startAll(bus);
        let mid = 'ac'.repeat(32), row = sampleRow(mid);
        let stranger = ValidatorIdentity.generate().pubkeyHex.toLowerCase();
        await bus.nodes[0].consensus.propose(mid, {
            row, snapshot: { validators: [{ pubkey: stranger, source: 'src:' + stranger, weight: '1', amount: '1' }], count: 1 }
        });
        // propose() resolves the elected-signer check inline, so the refusal is decided
        // by the time it returns.
        expect(bus.nodes[0].finalized.length).to.equal(0);
    });

    it('tolerates 1 of 4 refusing to validate (honest majority still finalizes)', async function () {
        let bus = buildMesh(4, { validate: (self) => self.i !== 2 });   // node 2 refuses
        await startAll(bus);
        let mid = 'cc'.repeat(32), row = sampleRow(mid);
        await proposeAll(bus, mid, row);
        await waitUntil(() => [0, 1, 3].every(i => bus.nodes[i].finalized.length === 1), { label: 'the honest majority to finalize' });
        expect([0, 1, 3].every(i => bus.nodes[i].finalized.length === 1)).to.be.true;
    });

    it('does NOT finalize when 2 of 4 refuse (quorum unreachable, safety)', async function () {
        let bus = buildMesh(4, { validate: (self) => !(self.i === 2 || self.i === 3) });
        await startAll(bus);
        let mid = 'dd'.repeat(32), row = sampleRow(mid);
        await proposeAll(bus, mid, row);
        // Quorum is unreachable, so wait on the stall point instead: both validating
        // nodes have collected each other's signature and can collect no more.
        await waitUntil(() => [0, 1].every(i => { let p = bus.nodes[i].consensus.pending.get(mid); return p && p.signatures.size >= 2; }), { label: 'both honest nodes to collect the 2 available signatures' });
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
        await waitUntil(() => bus.nodes.filter(nd => !nd.crashed && nd.finalized.length === 1).length === 3,
            { timeoutMs: 4000, label: 'the view-change rotation to finalize on every live node' });
        expect(bus.nodes.filter(nd => !nd.crashed && nd.finalized.length === 1).length).to.equal(3);
    });

    it('leader failover finalizes when the canonical folds the view (EQUIV header active; H-8 regression)', async function () {
        // With the EQUIV header active, _canonicalMatch(row, view) moves with the
        // view, so a new-view leader that re-signs the view-0 canonical produces a
        // PROPOSE no follower verifies (they recompute at d.view) and failover is
        // dead. This pins the fix: the rotated leader rebuilds + re-signs the
        // canonical for the current view, followers (including any that already
        // sent COMMIT in the old view) re-adopt the value-identical new-view
        // canonical, and the round finalizes with signatures that verify under
        // the FINAL view's canonical, not view 0's.
        this.timeout(5000);
        const equivCanonical = (r, view) => canonicalMatch(r) + '|EQ|' + Number(view || 0);
        let mid = 'ee'.repeat(32);
        let bus = buildMesh(4, { roundTimeoutMs: 80, canonical: equivCanonical });
        let crashed = bus.nodes.find(nd => nd.pubkey === leaderPubkey(bus, mid, 0));
        crashed.crashed = true;                                         // never participates
        await startAll(bus);
        await proposeAll(bus, mid, sampleRow(mid));
        await waitUntil(() => bus.nodes.filter(nd => !nd.crashed && nd.finalized.length === 1).length === 3,
            { timeoutMs: 4000, label: 'the view-folding rotation to finalize on every live node' });

        let live = bus.nodes.filter(nd => !nd.crashed);
        expect(live.filter(nd => nd.finalized.length === 1).length, 'all live nodes finalize').to.equal(3);
        let ev = live[0].finalized[0];
        expect(ev.view, 'the round finalized under a post-failover view').to.be.at.least(1);
        let finalCanon = equivCanonical(ev.row, ev.view);
        expect(ev.signatures.length).to.be.at.least(3);
        expect(ev.signatures.every(s => ValidatorIdentity.verify(finalCanon, s.sig, s.pubkey)),
            'every quorum signature verifies under the final view canonical').to.be.true;
        expect(ev.signatures.some(s => ValidatorIdentity.verify(equivCanonical(ev.row, 0), s.sig, s.pubkey)),
            'no stale view-0 signature survives into the quorum set').to.be.false;
    });

    it('abandons a stale round past its max lifetime and emits match:abandoned (so the engine re-proposes)', async function () {
        // Sustained message loss (e.g. P2P rate-limit drops during a burst) keeps a
        // round view-changing without ever reaching quorum. Model it by dropping ALL
        // gossip: the proposer never collects PREPAREs/COMMITs, so the round can only
        // time out. Past roundMaxLifetimeMs it must be ABANDONED (pending released +
        // event) rather than leaking forever, which is what previously wedged calls
        // until a process restart.
        this.timeout(5000);
        let bus = buildMesh(4, { roundTimeoutMs: 40, drop: () => true });   // drop every gossip message
        let victim = bus.nodes[0];
        victim.consensus.roundMaxLifetimeMs = 150;                          // abandon after ~150ms of churn
        let abandoned = [];
        victim.consensus.on('match:abandoned', (ev) => abandoned.push(ev.matchId));
        await startAll(bus);
        let mid = 'ab'.repeat(32);
        await victim.consensus.propose(mid, { row: sampleRow(mid), snapshot: { validators: validatorsOf(bus), count: 4 } });
        expect(victim.consensus.pending.has(mid), 'round is live before abandon').to.be.true;
        await waitUntil(() => abandoned.length > 0, { timeoutMs: 4000, label: 'the round to exceed its max lifetime and abandon' });
        expect(abandoned, 'emitted match:abandoned for exactly this round').to.deep.equal([mid]);
        expect(victim.consensus.pending.has(mid), 'pending released so propose() can re-run').to.be.false;
        expect(victim.finalized.length, 'never finalized').to.equal(0);
    });

    it('does not abandon a round that finalizes within its max lifetime', async function () {
        // Healthy mesh: the round finalizes normally and must NOT emit match:abandoned
        // even though the lifetime budget is short.
        this.timeout(5000);
        let bus = buildMesh(4, { roundTimeoutMs: 40 });
        bus.nodes.forEach(nd => { nd.consensus.roundMaxLifetimeMs = 150; nd._abandoned = []; nd.consensus.on('match:abandoned', (ev) => nd._abandoned.push(ev.matchId)); });
        await startAll(bus);
        let mid = 'cd'.repeat(32);
        await proposeAll(bus, mid, sampleRow(mid));
        await waitUntil(() => bus.nodes.filter(nd => nd.finalized.length === 1).length === 4, { timeoutMs: 4000, label: 'every node to finalize inside the lifetime budget' });
        expect(bus.nodes.filter(nd => nd.finalized.length === 1).length, 'all finalized').to.equal(4);
        expect(bus.nodes.every(nd => nd._abandoned.length === 0), 'none abandoned').to.be.true;
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
        // _handleMessage fires the PROPOSE branch and forgets it, so drive the async
        // handler directly: its completion IS the verdict, with nothing left to settle.
        await victim.consensus._handlePropose({ type: 'XDEX_MATCH_PROPOSE', sender: leaderPk,
            data: { matchId: mid, view: 0, row: badRow, sig_pubkey: leaderPk, sig: badSig } });
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
        await waitUntil(() => bus.nodes.every(nd => nd.finalized.length === 1), { label: 'every node to finalize on the leader canonical' });

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
        await waitUntil(() => [1, 2, 3].every(i => bus.nodes[i].finalized.length === 1), { timeoutMs: 4000, label: 'the three connected nodes to finalize without the straggler' });

        // nodes 1-3 finalized without node 0
        expect([1, 2, 3].every(i => bus.nodes[i].finalized.length === 1)).to.be.true;
        expect(bus.nodes[0].finalized.length).to.equal(0);

        // heal the partition; node 0's view-change timer fires and a finalized
        // peer answers with FINAL_SYNC
        partitioned = false;
        await waitUntil(() => bus.nodes[0].finalized.length === 1, { timeoutMs: 4000, label: 'the healed straggler to catch up via FINAL_SYNC' });

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
        // FINAL_SYNC is handled synchronously, so the verdict is already in.
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
        // COMMIT is handled synchronously, so every fed vote is already tallied (or not).
        expect(victim.finalized.length).to.equal(0);
        expect(victim.consensus.pending.get(mid).commits.size).to.equal(0);
    });

    it('guard: a replayed PREPARE (valid canonical sig, no commit_sig) never counts as a COMMIT vote ', async function () {
        // A-F6: PREPARE and COMMIT signatures were interchangeable (a COMMIT
        // re-sends the prepare sig verbatim), so one Byzantine member could
        // replay everyone's PREPAREs as COMMITs and finalize a round no honest
        // peer had committed. The phase-bound commit_sig closes that: genuine
        // canonical sigs without it collect as artifact signatures but must not
        // tally as commit votes.
        let bus = buildMesh(4, { drop: () => true });   // isolate: no real gossip
        await startAll(bus);
        let mid = 'c3'.repeat(32), row = sampleRow(mid);
        let victim = bus.nodes[0];
        await victim.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 4 } });
        let canon = canonicalMatch(row);
        for (let nd of bus.nodes) {
            if (nd === victim) continue;
            let prepareSig = nd.identity.sign(canon);   // exactly what a PREPARE carries
            victim.consensus._handleMessage({ type: 'XDEX_MATCH_COMMIT', sender: nd.pubkey,
                data: { matchId: mid, view: 0, sig_pubkey: nd.pubkey, sig: prepareSig } });
            // A commit_sig phase-tagged for a DIFFERENT engine (the XCALL relay
            // twin) must not verify against this engine's COMMIT payload either.
            victim.consensus._handleMessage({ type: 'XDEX_MATCH_COMMIT', sender: nd.pubkey,
                data: { matchId: mid, view: 0, sig_pubkey: nd.pubkey, sig: prepareSig,
                        commit_sig: nd.identity.sign('XCALL_RELAY_COMMIT|PHASEV1|' + canon) } });
        }
        // COMMIT is handled synchronously, so every replayed PREPARE is already judged.
        expect(victim.finalized.length).to.equal(0);
        let p = victim.consensus.pending.get(mid);
        expect(p.commits.size).to.equal(0);                    // no replayed vote tallied
        expect(p.signatures.size).to.be.at.least(3);           // artifact sigs still collected
    });

    it('phase-bound COMMIT votes with a verifying commit_sig finalize the round ', async function () {
        let bus = buildMesh(4, { drop: () => true });   // isolate: no real gossip
        await startAll(bus);
        let mid = 'c4'.repeat(32), row = sampleRow(mid);
        let victim = bus.nodes[0];
        await victim.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 4 } });
        let canon = canonicalMatch(row);
        for (let nd of bus.nodes) {
            if (nd === victim) continue;
            victim.consensus._handleMessage({ type: 'XDEX_MATCH_COMMIT', sender: nd.pubkey,
                data: { matchId: mid, view: 0, sig_pubkey: nd.pubkey, sig: nd.identity.sign(canon),
                        commit_sig: nd.identity.sign('XDEX_MATCH_COMMIT|PHASEV1|' + canon) } });
        }
        await waitUntil(() => victim.finalized.length === 1, { label: 'the phase-bound commit quorum to finalize the round' });
        expect(victim.finalized.length).to.equal(1);
        expect(victim.finalized[0].signatures.length).to.be.at.least(3);
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

    it('A-F3: NEW_VIEW does not advance the view without a local view-change quorum', async function () {
        let bus = buildMesh(4);
        await startAll(bus);
        let mid = 'ac'.repeat(32), row = sampleRow(mid);
        let victim = bus.nodes[0];
        await victim.consensus.propose(mid, { row, snapshot: { validators: validatorsOf(bus), count: 4 } });
        let p = victim.consensus.pending.get(mid);
        let nextView = p.view + 1;
        let ldPk   = leaderPubkey(bus, mid, nextView);
        let ldNode = bus.nodes.find(nd => nd.pubkey === ldPk);
        let nv = { type: 'XDEX_MATCH_NEW_VIEW', sender: ldPk,
            data: { matchId: mid, view: nextView, sig_pubkey: ldPk,
                    sig: ldNode.identity.sign('XDEXNV|' + mid + '|' + nextView) } };

        // Valid leader signature but NO view-change votes collected locally: must
        // not drag the view forward (this is the A-F3 griefing vector).
        victim.consensus._handleMessage(nv);
        expect(victim.consensus.pending.get(mid).view).to.equal(p.view);

        // With a real 2f+1 view-change quorum present locally, the same NEW_VIEW
        // legitimately advances.
        let voters = new Set(bus.nodes.slice(0, 3).map(nd => nd.pubkey));
        victim.consensus.pending.get(mid).viewChanges.set(nextView, voters);
        victim.consensus._handleMessage(nv);
        expect(victim.consensus.pending.get(mid).view).to.equal(nextView);
    });

    it('A-F5: _bufferEarlyMessage caps distinct ids (FIFO) and drops oversized envelopes', function () {
        let bus = buildMesh(1);
        let c = bus.nodes[0].consensus;
        c.earlyMessageMaxDistinctIds = 4;
        for (let i = 0; i < 10; i++) c._bufferEarlyMessage('id' + i, { type: 'X', data: { n: i } });
        expect(c.earlyMessages.size).to.equal(4);
        expect(c.earlyMessages.has('id0')).to.be.false;   // oldest distinct id evicted
        expect(c.earlyMessages.has('id9')).to.be.true;    // newest retained

        c.earlyMessageMaxBytes = 50;
        c._bufferEarlyMessage('big', { type: 'X', data: { row: 'x'.repeat(500) } });
        expect(c.earlyMessages.has('big')).to.be.false;   // oversized -> not buffered
    });
});
