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
// StateAnchorPublisher: the archive publisher-attestation round behind the
// ANCHOR v1 publisher tail (canonical, single-node self-attestation, the 2f+1
// quorum, the degraded count-0 tail and the pre-flag-day tail) and the
// stake-weighted archive quorum rule quorumVerified and checkArchiveQuorum apply.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const StateAnchorPublisher  = require('../../../../../src/anchor/publisher');
const ValidatorIdentity     = require('../../../../../src/validators/identity');
const eq                    = require('../../../../../src/equivocation_header.js');
const { waitUntil }         = require('../../../../helpers/waitUntil');
const arMod                 = require('../../../../../src/anchor_reward_activation.js');
const { DB_METHODS }        = require('../../../../helpers/mockHub.js');
const { CP_ROW, buildMesh, startAll, registerMeshHooks } = require('../../../../helpers/anchor_mesh.js');

// Independent reimplementation of the indexer's Anchor._rewardCanonical (FORMAT 1):
// the hub's archiveAttestationCanonical MUST be byte-identical to this.
function archiveRewardCanonical(cp, batchSeq, publisher) {
    let base = ['XANCPUB', 'anchor_archive', String(batchSeq),
                String(cp.snapshot_block), String(publisher).toLowerCase(),
                arMod.ARCHIVE_REWARD_AMOUNT].join('|');
    if (eq.isEquivHeaderActive(cp.snapshot_block, cp.network)) {
        let roundId = 'XANCPUB|archive|' + cp.network + '|' + batchSeq + '|' + cp.snapshot_block;
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
    }
    return base;
}

const CANON = 'XANC|test|canonical';
function weightedPub() {
    return new StateAnchorPublisher({
        db: { ...DB_METHODS, async doQuery() { return []; } },
        network: 'regtest',                                   // activation = 0 → weighted on
        getPeerManager: () => ({ on() {}, removeListener() {}, broadcast() {} }),
        getIdentity: () => null,
        p2pConfig: {}
    });
}
// 4 validators, concentrated stake 70/10/10/10 over distinct sources.
function stakeSet() {
    let ids = ['70', '11', '12', '13'].map(s => new ValidatorIdentity(s.repeat(32).slice(0, 64)));
    let weights = ['70', '10', '10', '10'];
    let set = ids.map((id, i) => ({ pubkey: id.getPubkeyHex().toLowerCase(), source: 'src' + i, weight: weights[i] }));
    return { ids, set };
}
const sigsFrom = (ids) => ids.map(id => ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(CANON) }));

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerArchiveAttestationRound();
    registerStakeWeightedQuorum();
});

// Archive publisher-attestation round (the v1 publisher tail): at/above the
// archive-reward flag-day the elected archive leader emits ANCHOR v1 carrying a 2f+1
// oracle_publish attestation over the archive XANCPUB canonical, so the indexer
// DERIVES the anchor_archive reward and the last key-authenticated push rail is
// retired. The version byte no longer encodes whether the round met quorum (D4): a
// degraded round emits the SAME v1 with ATTEST_SIG_COUNT 0. This suite RE-ACTIVATES
// the archive regtest flag-day only, isolating the leg from the bundle side.
function registerArchiveAttestationRound() {
    describe('archive publisher-attestation round (v1 publisher tail)', function () {
        beforeEach(function () { arMod.ARCHIVE_REWARD_ACTIVATION.regtest = 0; });   // active at genesis

        registerArchiveCanonicalCases();
        registerArchiveQuorumCase();
        registerDegradedRoundCase();
        registerPreFlagDayCase();
    });
}

// The archive reward canonical and the self-attested single-node archive.
function registerArchiveCanonicalCases() {
    it('archiveAttestationCanonical is byte-identical to the indexer archive reward canonical (EQUIV-wrapped)', function () {
        let bus = buildMesh(1);
        let pub = bus.nodes[0].pub;
        let cp  = pub.cpFromRow(Object.assign({}, CP_ROW));
        let publisher = bus.nodes[0].pubkey;
        let expected = archiveRewardCanonical(cp, 0, publisher);
        // Sanity: the wrapped form is what the federation signs at/above the EQUIV
        // flag-day, with the 'archive' round-id family disjoint from every per-chain one.
        expect(expected).to.equal(
            'EQUIV|XCHECKPOINT|XANCPUB|archive|regtest|0|100|0||XANCPUB|anchor_archive|0|100|' +
            publisher + '|10.00000000');
        expect(pub.archiveAttestationCanonical(cp, 0, publisher)).to.equal(expected);
    });

    it('single-node: flush emits ANCHOR v1 with a self-attestation the indexer can verify', async function () {
        // Weighted: the attestation tail only fills at/above the archive-reward flag-day
        // (>= SWQ height), so keep regtest (flag-day active here) and self-attest one
        // equal-weight source.
        let bus = buildMesh(1, { stakeWeighted: true });
        let nd  = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the single-node flush to emit a v1 archive anchor' });

        let v6 = nd.published.find(p => p.split('|')[1] === '1');
        expect(v6, 'a v1 archive anchor was published').to.be.a('string');
        let parts = v6.split('|');
        expect(parts[11], 'MATCH_BATCH_SEQ').to.equal('0');
        expect(parts[14], 'TOTAL_CHUNKS').to.equal('1');
        let sigCount = Number(parts[16]);                              // wrapper SIG_COUNT (v1 sigBase)
        let pubBase  = 17 + 2 * sigCount;
        expect(parts[pubBase], 'PUBLISHER').to.equal(nd.pubkey);
        expect(Number(parts[pubBase + 1]), 'ATTEST_SIG_COUNT').to.equal(1);
        let aPub = parts[pubBase + 2], aSig = parts[pubBase + 3];
        expect(aPub).to.equal(nd.pubkey);
        let cp = nd.pub.cpFromRow(nd.db.checkpoints[0]);
        expect(ValidatorIdentity.verify(archiveRewardCanonical(cp, 0, nd.pubkey), aSig, aPub)).to.be.true;

        // The wrapper signature still verifies over the UNCHANGED v1 archive canonical.
        let canonical = nd.pub.archiveCanonical(cp, 0, 1, parts[13], 1);
        expect(ValidatorIdentity.verify(canonical, parts[18], parts[17])).to.be.true;

        // The archive lands, rows back-fill, and the anchor_archive reward is recorded.
        expect(nd.db.matches[0].batch_seq).to.equal(0);
        expect(nd.rewards.filter(r => r.type === 'anchor_archive').length).to.equal(1);
    });
}

// N=4: the elected archive leader collects a 2f+1 archive attestation quorum.
function registerArchiveQuorumCase() {
    it('N=4: the elected archive leader collects a 2f+1 archive attestation quorum and emits v1', async function () {
        // The tail requires the archive-reward flag-day active (>= SWQ height everywhere), so
        // the archive signing + attestation rounds run weighted; equal source-weights make
        // the 2/3-stake bar coincide with 2f+1 (3-of-4), keeping the assertions unchanged.
        let bus = buildMesh(4, { btcBlock: 100, stakeWeighted: true });
        await startAll(bus);
        for (let nd of bus.nodes) await nd.pub.flush();
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'the elected archive leader to emit a v1' });

        let leader = bus.nodes.find(nd => nd.published.some(p => p.split('|')[1] === '1'));
        expect(leader, 'an elected leader emitted a v1').to.exist;
        let parts = leader.published.find(p => p.split('|')[1] === '1').split('|');
        let sigCount = Number(parts[16]);
        let pubBase  = 17 + 2 * sigCount;
        expect(parts[pubBase], 'PUBLISHER is the leader').to.equal(leader.pubkey);
        let attestCount = Number(parts[pubBase + 1]);
        expect(attestCount, '2f+1 attestation quorum').to.be.at.least(3);

        let cp = leader.pub.cpFromRow(leader.db.checkpoints[0]);
        let canonical = archiveRewardCanonical(cp, Number(parts[11]), leader.pubkey);
        let setPubkeys = new Set(bus.nodes.map(n => n.pubkey));
        let signers = [];
        for (let i = 0; i < attestCount; i++) {
            let aPub = parts[pubBase + 2 + 2 * i], aSig = parts[pubBase + 2 + 2 * i + 1];
            expect(setPubkeys.has(aPub), 'attester in oracle_publish set').to.be.true;
            expect(ValidatorIdentity.verify(canonical, aSig, aPub)).to.be.true;
            signers.push(aPub);
        }
        expect(signers).to.include(leader.pubkey);
    });
}

// A degraded round still emits v1, with an EMPTY attestation list.
function registerDegradedRoundCase() {
    it('liveness fallback: a degraded round still emits v1, with an EMPTY attestation list', async function () {
        // Degraded federation: the elected archive leader is the ONLY started node
        // in a 4-member snapshot, so no peer co-signs the archive XANCPUB. The
        // bounded round times out and the leader emits the SAME v1 wire with
        // ATTEST_SIG_COUNT 0 (D4) rather than a second, tail-less shape: one archive
        // head version, one parser branch, and the count field carries the degradation.
        // The anchor_archive reward is still withheld, because at/above the flag-day
        // no live indexer derives a reward from a count-0 tail, so recording one would
        // strand it in hub/archive bookkeeping and fork a recovered ledger.
        // Weighted (the tail needs the archive-reward flag-day, >= SWQ height): the
        // archive SIGNING round must still reach the stake-weighted quorum so a head
        // publishes, while the severed attestation round times out.
        let bus = buildMesh(4, { btcBlock: 100, stakeWeighted: true, cfg: { ANCHOR_ROUND_TIMEOUT_MS: '40' } });
        await startAll(bus);
        // Sever ONLY the archive-attestation gossip: the archive SIGNING round must
        // still reach quorum (or no archive head publishes at all), but no attest
        // co-sign ever arrives, so the attestation round times out.
        for (let nd of bus.nodes) {
            let orig = nd.handler;
            nd.handler = (env) => { if (String(env.type).startsWith('XANCARCHPUB')) return; orig(env); };
        }
        for (let nd of bus.nodes) await nd.pub.flush();
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'an archive head to be published' });

        let archiveHeads = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(archiveHeads.length, 'an archive head was still published').to.be.at.least(1);
        let leader = bus.nodes.find(nd => nd.published.some(p => p.split('|')[1] === '1'));
        // NOTHING but the count degrades: the publisher tail is still on the wire, so
        // the indexer parses the same v1 layout on the degraded and the attested round.
        for (let head of archiveHeads) {
            let parts    = head.split('|');
            let sigCount = Number(parts[16]);                       // wrapper SIG_COUNT
            let pubBase  = 17 + 2 * sigCount;
            expect(parts[pubBase], 'PUBLISHER is still appended on a degraded round')
                .to.match(/^[0-9a-f]{64}$/);
            expect(parts[pubBase + 1], 'ATTEST_SIG_COUNT is the literal 0').to.equal('0');
            expect(parts.length, 'no (APUBKEY,ASIG) pair follows a count of 0')
                .to.equal(pubBase + 2);
        }
        expect(leader.rewards.filter(r => r.type === 'anchor_archive').length,
            'no anchor_archive reward on a count-0 tail').to.equal(0);
    });
}

// Below the archive-reward flag-day the tail is still appended, with count 0.
function registerPreFlagDayCase() {
    it('below the archive-reward flag-day the tail is still appended, with count 0', async function () {
        // The other way into an empty attestation list: no round runs at all. The wire
        // shape must not fork on the flag-day either, or an indexer at a pre-flag-day
        // height would need a second parser branch for a tail-less v1 (which is exactly
        // the legacy shape this spec deleted).
        // Mainnet at the fixture's snapshot_block 100 is far below
        // ARCHIVE_REWARD_ACTIVATION.mainnet (963000), so no attestation round runs at
        // all. It is also below the 961000 SWQ activation, which is the count-path
        // archive setup the single-node round-trip case already proves out.
        let bus = buildMesh(1, { network: 'mainnet' });
        let nd  = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the pre-flag-day archive head' });

        let parts    = nd.published.find(p => p.split('|')[1] === '1').split('|');
        let sigCount = Number(parts[16]);
        let pubBase  = 17 + 2 * sigCount;
        expect(parts[1], 'still a v1, not a second tail-less wire').to.equal('1');
        expect(parts[pubBase], 'PUBLISHER').to.equal(nd.pubkey);
        expect(parts[pubBase + 1], 'ATTEST_SIG_COUNT').to.equal('0');
        expect(parts.length, 'the wire ends at the count').to.equal(pubBase + 2);
        // Below the flag-day the push rail is NOT retired, so the reward is recorded.
        expect(nd.rewards.filter(r => r.type === 'anchor_archive').length).to.equal(1);
    });
}

// ── STAKE_WEIGHTED_QUORUM (WI-1, finding #4120): the publisher's archive
//    quorum + on-chain VALIDITY gate must apply the SAME stake-weighted rule
//    the indexer (anchor.js) and full-parse recovery verify against. Pre-fix it
//    was count-only, so a count-met-but-stake-short batch was published+dequeued
//    while every indexer rejected it - stranding settled state in an
//    unrecoverable hole. (The mesh tests above run with hub.network undefined →
//    legacy count; here the drive is network='regtest', activation=0 → weighted.)
function registerStakeWeightedQuorum() {
    describe('stake-weighted archive quorum', function () {
        registerQuorumVerifiedCases();
        registerCheckArchiveQuorumCase();
    });
}

// quorumVerified under the count and the stake regimes.
function registerQuorumVerifiedCases() {
    it('quorumVerified: the three 10% holders meet 2f+1 COUNT but NOT 2/3 STAKE', function () {
        let pub = weightedPub();
        let { ids, set } = stakeSet();
        let minority = sigsFrom(ids.slice(1));                    // 3×10% = 30 of 100
        // Count regime would ACCEPT (3 of 4 ≥ 2f+1) - exactly the pre-fix producer bug.
        expect(pub.quorumVerified(CANON, minority, set, false)).to.equal(true);
        // Stake regime REJECTS (3·30 = 90 ≤ 2·100 = 200) - matches the indexer/recovery verdict.
        expect(pub.quorumVerified(CANON, minority, set, true)).to.equal(false);
    });

    it('quorumVerified: adding the 70% holder clears the stake threshold', function () {
        let pub = weightedPub();
        let { ids, set } = stakeSet();
        let majority = sigsFrom([ids[0], ids[1]]);               // 70 + 10 = 80 of 100
        expect(pub.quorumVerified(CANON, majority, set, true)).to.equal(true);    // 3·80 = 240 > 200
    });

    it('quorumVerified: a TRUNCATED weighted set fails CLOSED regardless of stake (XHUB-TRUNC-2)', function () {
        // An over-cap snapshot under-counts S; a stake-evicted minority could otherwise
        // authenticate a fabricated archived match/call. Mirrors the DEX/Call consensus
        // refuse and meetsStakeThreshold's own fail-closed.
        let pub = weightedPub();
        let { ids, set } = stakeSet();
        set.truncated = true;                                    // resolved set overflowed VALIDATOR_QUERY_LIMIT
        let all = sigsFrom(ids);                                 // 100% of stake WOULD clear the 2/3 bar
        expect(pub.quorumVerified(CANON, all, set, true)).to.equal(false);   // ...but truncated -> fail closed
        // COUNT path is proceed-on-truncation (deterministic cap; matches getQuorum).
        let three = sigsFrom(ids.slice(1));                      // 3 of 4 >= 2f+1
        expect(pub.quorumVerified(CANON, three, set, false)).to.equal(true);
    });

    it('quorumVerified: duplicate pubkey with garbage sig FIRST still counts the later valid sig', function () {
        // seen-before-verify was an order-dependent under-count: the garbage
        // entry consumed the pubkey's seen slot and the real signature was
        // skipped, diverging from the indexer recovery twin (verify-first).
        let pub = weightedPub();
        let { ids, set } = stakeSet();
        let valid = sigsFrom([ids[0], ids[1]]);                  // 70 + 10 = 80 of 100, clears stake bar
        let poisoned = [{ pubkey: ids[0].getPubkeyHex().toLowerCase(), sig: '00'.repeat(64) }, ...valid];
        expect(pub.quorumVerified(CANON, poisoned, set, true)).to.equal(true);
    });

    it('quorumVerified: a pubkey with ONLY invalid sigs is not counted and blocks nothing', function () {
        let pub = weightedPub();
        let { ids, set } = stakeSet();
        let garbageOnly = [{ pubkey: ids[0].getPubkeyHex().toLowerCase(), sig: '00'.repeat(64) },
                           ...sigsFrom(ids.slice(1))];           // 3×10% real = stake-short
        expect(pub.quorumVerified(CANON, garbageOnly, set, true)).to.equal(false);
    });
}

// checkArchiveQuorum publishes on the regime, not the signature count.
function registerCheckArchiveQuorumCase() {
    it('checkArchiveQuorum: a count-met-but-stake-short round does NOT publish/dequeue', async function () {
        let pub = weightedPub();
        let { ids, set } = stakeSet();
        let published = false;
        pub.publishArchive = async () => { published = true; };  // observe the dequeue decision
        pub._archiveRound = {
            done: false, weighted: true, quorum: 3, validators: set,
            signatures: new Map(sigsFrom(ids.slice(1)).map(s => [s.pubkey, s.sig])),   // 3×10%
            timer: null
        };
        await pub.checkArchiveQuorum();
        expect(published, 'sub-stake archive must not publish').to.equal(false);
        expect(pub._archiveRound, 'round stays open for more sigs').to.not.equal(null);

        // The SAME 3 sigs WOULD fire under legacy count - proving the regime, not
        // the signature count, is what now gates the dequeue.
        pub._archiveRound.weighted = false;
        await pub.checkArchiveQuorum();
        expect(published, 'count regime fires on 3 ≥ quorum').to.equal(true);
    });
}
