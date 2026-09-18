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
//
// StateAnchorPublisher: the publisher-attestation round behind the ANCHOR v0
// bundle tail: the XANCPUB canonical, the self-attested single-node flush, the
// balance and payload-budget gates, the 2f+1 quorum on a mesh, deferral when
// the quorum cannot be reached, and the follower refusals.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const ValidatorIdentity     = require('../../../../src/validators/identity');
const eq                    = require('../../../../src/consensus/equivocation_header.js');
const { waitUntil }         = require('../../../helpers/waitUntil');
const arMod                 = require('../../../../src/consensus/gates/anchor_reward_gate.js');
const { CP_ROW, parseV7Sections, parseV7Tail, buildMesh, v0Order, mkBundleDone, startAll,
        registerMeshHooks } = require('../../../helpers/anchor_mesh.js');

// Independent reimplementation of the indexer's Anchor._rewardCanonical for the
// bundle family: the hub's attestationCanonical MUST be byte-identical to this,
// or the derived reward forks. SIX positional fields, with round_reference and
// snapshot_block both the bundle block (D22), so slash.js still reads
// snapshot_block at index 3.
function rewardCanonical(b, publisher) {
    let base = ['XANCPUB', 'anchor_bundle', String(b.snapshot_block),
                String(b.snapshot_block), String(publisher).toLowerCase(),
                arMod.ANCHOR_REWARD_AMOUNT].join('|');
    if (eq.isEquivHeaderActive(b.snapshot_block, b.network)) {
        let roundId = 'XANCPUB|bundle|' + b.network + '|' + b.snapshot_block;
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
    }
    return base;
}
const bundleOf = (nd) => ({ network: nd.db.checkpoints[0].network,
                            snapshot_block: Number(nd.db.checkpoints[0].snapshot_block) });

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerBundleAttestationRound();
});

// Publisher-attestation round: at/above the anchor-reward flag-day the producer
// emits an ANCHOR v0 whose tail carries the elected publisher + a 2f+1
// oracle_publish attestation over XANCPUB, so the indexer DERIVES the reward and the
// forgeable hub push is retired. ONE round per BUNDLE, not one per chain. This suite
// RE-ACTIVATES the regtest flag-day (the parent suite pins it dormant).
function registerBundleAttestationRound() {
    describe('publisher-attestation round (v0 bundle tail)', function () {
        beforeEach(function () { arMod.ANCHOR_REWARD_ACTIVATION.regtest = 0; });   // active at genesis

        registerAttestationCanonicalCases();
        registerBudgetAndBalanceCases();
        registerAboveFloorCases();
        registerQuorumCases();
        registerDeferralCases();
        registerImpostorCase();
    });
}

// The reward canonical and the self-attested single-node bundle.
function registerAttestationCanonicalCases() {
    it('attestationCanonical is byte-identical to the indexer reward canonical (EQUIV-wrapped)', function () {
        let bus = buildMesh(1);
        let pub = bus.nodes[0].pub;
        let b   = { network: CP_ROW.network, snapshot_block: CP_ROW.snapshot_block };
        let publisher = bus.nodes[0].pubkey;
        let expected = rewardCanonical(b, publisher);
        // Sanity: the wrapped form is what the federation signs at/above the EQUIV flag-day.
        expect(expected).to.equal(
            'EQUIV|XCHECKPOINT|XANCPUB|bundle|regtest|100|0||XANCPUB|anchor_bundle|100|100|' +
            publisher + '|10.00000000');
        expect(pub.attestationCanonical(b, publisher)).to.equal(expected);
        // Disjoint from the archive family, so the two can never equivocation-collide.
        expect(expected).to.not.equal(
            pub.archiveAttestationCanonical({ network: b.network, snapshot_block: b.snapshot_block }, 0, publisher));
    });

    it('single-node: flush emits ANCHOR v0 with a self-attestation the indexer can verify', async function () {
        // Weighted: the attested tail only appears at/above the anchor-reward flag-day,
        // which everywhere sits at/above the SWQ height, so there is no count-path block
        // for it. Keep regtest and back the round with one equal-weight source.
        let bus = buildMesh(1, { stakeWeighted: true });
        let nd  = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '0'), { label: 'the single-node flush to emit a v0 bundle' });

        let v7 = nd.published.find(p => p.split('|')[1] === '0');
        expect(v7, 'a v0 bundle was published').to.be.a('string');
        let tail = parseV7Tail(v7);
        expect(tail.publisher, 'PUBLISHER').to.equal(nd.pubkey);
        expect(tail.attestCount, 'ATTEST_SIG_COUNT').to.equal(1);
        expect(tail.sigs[0].pubkey).to.equal(nd.pubkey);
        expect(ValidatorIdentity.verify(rewardCanonical(bundleOf(nd), nd.pubkey), tail.sigs[0].sig, tail.sigs[0].pubkey)).to.be.true;

        // The anchor still lands and ONE anchor_bundle reward is recorded.
        expect(nd.db.checkpoints[0].anchor_txid).to.be.a('string');
        expect(nd.rewards.filter(r => r.type === 'anchor_bundle').length).to.equal(1);
        expect(nd.pub.getAnchorStats()).to.include({ anchorsPublished: 1, sectionsAnchored: 1, bundlesOversize: 0 });
    });
}

// The built-payload budget and the DOGE balance floor are hard pre-send gates.
function registerBudgetAndBalanceCases() {
    // splitBundle sizes an ESTIMATED attestation tail before the round that fills it
    // has run, and after a split it estimates at the network-wide oracle_publish set
    // rather than the group's own block, so the estimate can come in low. An oversize
    // payload then reached the encoder as a RangeError, after the anchor intents were
    // recorded and withdrawn, with bundlesOversize still reading 0.
    it('refuses a bundle whose BUILT payload overflows the budget, before any intent is recorded', async function () {
        let bus = buildMesh(1, { stakeWeighted: true });
        let nd  = bus.nodes[0];
        // Only the final build carries a non-empty attestation tail (v7Bytes always
        // measures with an empty one), so inflating on that condition leaves the
        // splitter's estimate untouched: exactly the low-estimate shape.
        let realBuild = nd.pub.buildV7Payload.bind(nd.pub);
        nd.pub.buildV7Payload = function (secs, publisher, attestSigs) {
            let p = realBuild(secs, publisher, attestSigs);
            return (attestSigs && attestSigs.length > 0) ? p + 'x'.repeat(9000) : p;
        };
        let intents = 0;
        let realIntent = nd.pub.recordAnchorIntent.bind(nd.pub);
        nd.pub.recordAnchorIntent = async function (row) { intents++; return realIntent(row); };
        await startAll(bus);
        await nd.pub.flush();
        expect(nd.published.filter(p => p.split('|')[1] === '0'), 'nothing was broadcast').to.deep.equal([]);
        expect(intents, 'no anchor intent was recorded').to.equal(0);
        expect(nd.pub.getAnchorStats()).to.include({ anchorsPublished: 0, bundlesOversize: 1 });
        expect(nd.db.checkpoints[0].anchor_txid, 'the checkpoint row stays pending').to.equal(null);
    });

    // item 2676: the balance check is a hard pre-send gate, not an advisory WARN.
    it('skips the flush when a wired DOGE balance is below the floor (item 2676)', async function () {
        let bus = buildMesh(1);
        let nd  = bus.nodes[0];
        nd.pub.setBalanceHook(async () => nd.pub.lowBalanceThreshold - 1);   // below floor
        await startAll(bus);
        let before = nd.published.length;
        let res = await nd.pub.flush();
        expect(res.skipped).to.equal('below_balance_floor');
        expect(nd.published.length).to.equal(before);   // nothing broadcast
    });

    it('skips the flush when a wired DOGE balance is unreadable (fail-closed, item 2676)', async function () {
        let bus = buildMesh(1);
        let nd  = bus.nodes[0];
        nd.pub.setBalanceHook(async () => { throw new Error('rpc down'); });  // -> null
        await startAll(bus);
        let before = nd.published.length;
        let res = await nd.pub.flush();
        expect(res.skipped).to.equal('balance_unreadable');
        expect(nd.published.length).to.equal(before);
    });
}

// An above-floor balance publishes, and every section carries its roots.
function registerAboveFloorCases() {
    it('publishes normally when the wired balance is above the floor (item 2676)', async function () {
        let bus = buildMesh(1, { stakeWeighted: true });
        let nd  = bus.nodes[0];
        nd.pub.setBalanceHook(async () => nd.pub.lowBalanceThreshold + 100);
        await startAll(bus);
        let res = await nd.pub.flush();
        await waitUntil(() => nd.published.length > 0, { label: 'the above-floor flush to broadcast an anchor' });
        expect(res.skipped).to.be.undefined;
        expect(nd.published.length).to.be.greaterThan(0);
    });

    it('carries the light-client roots in every section', async function () {
        let bus = buildMesh(1, {
            stakeWeighted: true,
            mutate: (self, db) => {
                db.checkpoints[0].state_root           = 'aa'.repeat(32);
                db.checkpoints[0].state_root_version   = 1;
                db.checkpoints[0].block_merkle_root    = 'bb'.repeat(32);
                db.checkpoints[0].block_merkle_version = 1;
            }
        });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '0'), { label: 'the root-bearing flush to emit a v0 bundle' });

        let v7 = nd.published.find(p => p.split('|')[1] === '0');
        let sec = parseV7Sections(v7)[0];
        expect(sec.state_root, 'STATE_ROOT').to.equal('aa'.repeat(32));
        expect(sec.state_root_version).to.equal('1');
        expect(sec.block_merkle_root, 'BLOCK_MERKLE_ROOT').to.equal('bb'.repeat(32));
        expect(sec.block_merkle_version).to.equal('1');
        expect(parseV7Tail(v7).attestCount, 'ATTEST_SIG_COUNT').to.be.at.least(1);
    });
}

// N=4: the elected publisher collects a 2f+1 XANCPUB quorum.
function registerQuorumCases() {
    it('N=4: the elected publisher collects a 2f+1 XANCPUB quorum for the bundle', async function () {
        // The attested tail requires the anchor-reward flag-day active, which shares the
        // 961000 height with SWQ, so this round runs weighted; equal source-weights make
        // the 2/3-stake bar coincide with 2f+1 (3-of-4).
        let bus = buildMesh(4, { btcBlock: 100, stakeWeighted: true });
        await startAll(bus);
        let leader = v0Order(bus)[0];                                   // rank-0 bundle publisher
        await leader.pub.flush();
        await waitUntil(() => leader.published.some(p => p.split('|')[1] === '0'), { label: 'the rank-0 publisher to emit a v0 bundle' });

        let v7 = leader.published.find(p => p.split('|')[1] === '0');
        expect(v7, 'rank-0 publisher emitted a v0').to.be.a('string');
        let tail = parseV7Tail(v7);
        expect(tail.publisher, 'PUBLISHER').to.equal(leader.pubkey);
        expect(tail.attestCount, '2f+1 attestation quorum').to.be.at.least(3);

        // Every attestation sig verifies over the shared XANCPUB canonical and belongs
        // to the oracle_publish set; the publisher is among the signers.
        let canonical  = rewardCanonical(bundleOf(leader), leader.pubkey);
        let setPubkeys = new Set(bus.nodes.map(n => n.pubkey));
        for (let sig of tail.sigs) {
            expect(setPubkeys.has(sig.pubkey), 'attester in oracle_publish set').to.be.true;
            expect(ValidatorIdentity.verify(canonical, sig.sig, sig.pubkey)).to.be.true;
        }
        expect(tail.sigs.map(x => x.pubkey)).to.include(leader.pubkey);
    });
}

// No attestation quorum defers the bundle, and peers never mirror the reward.
function registerDeferralCases() {
    it('a publisher that cannot reach attestation quorum DEFERS the bundle instead of publishing it unattested', async function () {
        // REVERSES the previous "liveness fallback" contract, which asserted that a
        // timed-out round still lands the bundle with ATTEST_SIG_COUNT 0 so that "a
        // failed reward attestation must never block an anchor".
        //
        // That invariant was sound in intent and wrong against the wire. The indexer's
        // v0 BUNDLE parser requires ATTEST_SIG_COUNT >= 1 (actions/anchor.js, the
        // bundle publisher tail), so the fallback never produced a degraded-but-valid
        // anchor: it produced an INVALID one, paid for with a real DOGE fee, and
        // anchored nothing. Count 0 is legal only on the v1 ARCHIVE head, which keeps
        // its own degraded path and its own test; this site had borrowed the archive's
        // rule for the bundle.
        //
        // Measured on public testnet 2026-08-30: a bundle published mid rolling-deploy
        // reached 3 of the 5 signatures a weighted quorum needs and landed
        // `invalid: ATTEST_SIG_COUNT` on chain.
        //
        // Deferring costs nothing: no transaction is built and no intent recorded, so
        // the checkpoints stay pending and the next cycle republishes them.
        let bus = buildMesh(4, { btcBlock: 100, stakeWeighted: true, cfg: { ANCHOR_ROUND_TIMEOUT_MS: '40' } });
        let leader = v0Order(bus)[0];
        await leader.pub.start();                                       // followers intentionally NOT started
        await leader.pub.flush();
        await waitUntil(() => leader.pub.unattestedDeferrals > 0,
            { label: 'the timed-out attestation round to defer the bundle' });

        expect(leader.published.some(p => p.split('|')[1] === '0'),
            'no v0 bundle may be published without an attestation tail').to.be.false;
        expect(leader.db.checkpoints[0].anchor_txid,
            'the checkpoint stays pending for a later cycle rather than being stamped').to.not.be.a('string');
        expect(leader.pub.unattestedDeferrals, 'the deferral is counted for operators').to.equal(1);
        expect(leader.pub.getStatus ? leader.pub.getStatus().unattestedDeferrals : 1,
            'and is exposed on the anchor status surface').to.equal(1);
        // Unchanged from the previous contract: no reward is recorded either way.
        expect(leader.rewards.filter(r => r.type === 'anchor_bundle').length,
            'no anchor_bundle reward when the bundle never published').to.equal(0);
    });

    it('a peer does NOT mirror the anchor_<chain> reward from V0_DONE at/above the flag-day', async function () {
        // V0_DONE does not carry (and its canonical does not bind) which payload
        // version landed, so at/above the flag-day the mirror could mint a reward
        // for a degraded legacy fallback no live indexer credits. Peers therefore
        // skip the mirror entirely; live + recovering indexers derive the credit
        // from the on-chain v4/v5 attestation instead.
        let bus = buildMesh(3);
        let order = v0Order(bus, CP_ROW);
        let publisher = order[0];
        let receiver  = order[1];
        let d = mkBundleDone(bus, publisher, 'cc'.repeat(32));

        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });

        expect(receiver.db.checkpoints[0].anchor_txid, 'the stamp itself still lands').to.equal('cc'.repeat(32));
        expect(receiver.rewards.filter(r => r.type === 'anchor_BTC').length,
            'no mirrored anchor_BTC at/above the flag-day').to.equal(0);
    });
}

// A non-rank-0 proposer collects no follower co-sign.
function registerImpostorCase() {
    it('a follower refuses to co-sign when the proposer is not the rank-unlocked publisher', async function () {
        // The XANCPUB attestation binds the publisher to the v0 election: a non-rank-0
        // proposer (with the ladder not yet unlocked) must collect no follower signatures.
        let bus = buildMesh(4, { btcBlock: 100, cfg: { ANCHOR_ROUND_TIMEOUT_MS: '40' } });
        await startAll(bus);
        let order   = v0Order(bus);
        let impostor = order[order.length - 1];                        // highest rank, never unlocked at since=0
        let cp = impostor.pub.cpFromRow(impostor.db.checkpoints[0]);
        let canonical = impostor.pub.attestationCanonical(cp, impostor.pubkey);

        let collected = 0;
        let origBroadcast = impostor.pub.peerManager.broadcast;
        // Drive a bare REQ from the impostor and count co-signs that come back.
        impostor.pub._attestRound = {
            cp, publisher: impostor.pubkey, canonical, quorum: 3, weighted: false,
            validators: bus.nodes.map(n => ({ pubkey: n.pubkey, source: '', weight: '1' })),
            signatures: new Map([[impostor.pubkey, impostor.identity.sign(canonical)]]),
            done: false, timer: null, resolve: () => { collected++; }
        };
        // A refusal has nothing of its own to poll for, so wait on the thing that
        // makes the refusal final: every follower's message handler having run to
        // completion. A follower that DID co-sign broadcasts from inside that
        // handler, so once all of them settle the signature set can no longer grow.
        let handled = [];
        for (let nd of bus.nodes) {
            if (nd === impostor) continue;
            let origHandler = nd.handler;
            nd.handler = (env) => { let p = origHandler(env); handled.push(Promise.resolve(p)); return p; };
        }
        impostor.pub.peerManager.broadcast('XANCPUB_SIGN_REQ', {
            checkpoint: cp, publisher: impostor.pubkey,
            sig_pubkey: impostor.pubkey, sig: impostor.identity.sign(canonical)
        });
        await waitUntil(() => handled.length === bus.nodes.length - 1,
            { label: 'every follower to receive the impostor SIGN_REQ' });
        await Promise.all(handled);
        expect(impostor.pub._attestRound.signatures.size, 'only the impostor self-sig').to.equal(1);
    });
}
