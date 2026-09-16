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
// StateAnchorPublisher: pending anchor reward rows riding the archive rail
// with a pinned source, deferral of an unresolvable source, the empty-archive
// skip, follower re-derivation of forged reward rows, the batch seq span and
// per-hub mirror ids.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const zlib                  = require('zlib');
const { waitUntil }         = require('../../../../helpers/waitUntil');
const { buildMesh, archiveLeader, startAll, flushAll, pkOf, srcOf, rewardRow, registerMeshHooks } = require('../../../../helpers/anchor_mesh.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerRewardRideCases();
    registerRewardRederivationCases();
    registerRewardBookkeepingCases();
});

// ── anchor-reward archive rail (F10) ────────────────────────────────────
// Anchor-publish rewards are hub-pushed rows the indexer can never re-derive
// from a chain parse - the archive is their recovery transport. Rows carry
// no per-row signatures, so followers verify them by RE-DERIVATION.
// Rewards ride the archive with a pinned source; an unresolvable one is deferred.
function registerRewardRideCases() {
    it('N=4: pending anchor rewards ride the archive with a pinned source and back-fill batch_seq on every hub', async function () {
        let pk0 = pkOf(0);
        let bus = buildMesh(4, { btcBlock: 101, network: 'mainnet', matches: [], rewards: [rewardRow(pk0)] });   // count-path
        let leader = archiveLeader(bus);
        await startAll(bus);
        await flushAll(bus);
        await waitUntil(() => bus.nodes.every(nd => nd.db.rewardRows[0].batch_seq === 0), { label: 'the archive batch_seq to back-fill on every hub' });

        // Rewards-only batches publish (the empty-check includes rewards) with a
        // real co-sign quorum - followers re-derived every archived field.
        let v1Nodes = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '1'));
        expect(v1Nodes.length).to.equal(1);
        expect(v1Nodes[0]).to.equal(leader);
        let v1 = leader.published.find(p => p.split('|')[1] === '1').split('|');
        expect(Number(v1[16]), 'sig count').to.be.at.least(3);
        expect(v1[12], 'MATCH_COUNT counts matches only').to.equal('0');

        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(v1[15], 'base64url')).toString('utf8'));
        expect(archive.matches.length).to.equal(0);
        // serializeReward fixed shape, earn-time source pinned by the leader.
        expect(archive.rewards).to.deep.equal([{
            validator_pubkey: pk0, source: srcOf(pk0), round_number: 7,
            reward_type: 'anchor_BTC', amount: '10.00000000', block_index: 100
        }]);
        // oracle_publish set archived at the reward's earn block (recovery
        // re-checks the rewarded pubkey was an eligible publisher).
        expect(archive.capability_snapshots.filter(s =>
            s.capability === 'oracle_publish' && s.snapshot_block === 100).length).to.equal(4);

        // batch_seq back-filled on the leader directly and on followers via
        // XANC_FINALIZED - the row leaves the pending set federation-wide.
        for (let nd of bus.nodes)
            expect(nd.db.rewardRows[0].batch_seq, 'node ' + nd.i).to.equal(0);
    });

    it('a reward whose source cannot be resolved is deferred, not archived as a hole', async function () {
        let bus = buildMesh(1, { network: 'mainnet', rewards: [rewardRow(pkOf(0))], sourceResolver: () => null });   // count-path (SWQ off below 961000)
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the v1 archive to be broadcast' });

        let v1 = nd.published.find(p => p.split('|')[1] === '1').split('|');
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(v1[15], 'base64url')).toString('utf8'));
        expect(archive.matches.length).to.equal(1);                    // the default match still archives
        expect(archive.rewards).to.deep.equal([]);                     // the reward did not
        expect(nd.db.rewardRows[0].batch_seq).to.equal(null);          // stays pending for a later batch
    });
}

// Only-unresolvable rewards publish nothing, and forged rows fail re-derivation.
function registerRewardRederivationCases() {
    it('no matches/calls + only unresolvable rewards publishes NOTHING (empty-archive DOGE-burn fix)', async function () {
        // Live prod regression: an unstaked single-validator hub anchoring its
        // own checkpoints records anchor rewards whose pubkey resolves to no
        // stake source. Pre-fix the archive round counted them as pending and
        // broadcast an empty 0/0/0 archive to DOGE every cycle. With nothing
        // archivable after source resolution the round must publish nothing.
        let bus = buildMesh(1, { matches: [], calls: [], rewards: [rewardRow(pkOf(0))], sourceResolver: () => null });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        // Nothing to poll on the negative claim, so gate it on the round it belongs to:
        // the v0 checkpoint anchor still goes out, and the archive must not follow it.
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '0'), { label: 'the v0 checkpoint anchor to be broadcast' });

        expect(nd.published.find(p => p.split('|')[1] === '1'), 'no v1 archive published').to.equal(undefined);
        expect(nd.db.rewardRows[0].batch_seq, 'reward stays pending').to.equal(null);
    });

    it('follower re-derivation rejects forged reward type / pubkey / amount / source / conflicting local row', async function () {
        let pk0 = pkOf(0), pk1 = pkOf(1);
        let bus = buildMesh(2, { matches: [], rewards: [rewardRow(pk0)] });
        // Since #4185 the verifier also REQUIRES the snapshot groups buildArchive was
        // obliged to emit, so the fixture carries the oracle_publish group at the
        // reward's earn block rather than an empty list. The reward re-derivation
        // assertions below are unchanged.
        let verify = async (ar) => {
            let pub   = bus.nodes[1].pub;
            let set   = await pub.resolveCapabilitySet('oracle_publish', Number(ar.block_index), pub.network);
            let snaps = set.map(v => ({ snapshot_block: Number(ar.block_index), capability: 'oracle_publish',
                                        signing_pubkey: v.pubkey, amount: v.amount, source: v.source }));
            return pub.verifyArchiveAgainstLocal(
                { matches: [], calls: [], rewards: [ar], capability_snapshots: snaps });
        };
        let good = {
            validator_pubkey: pk0, source: srcOf(pk0), round_number: 7,
            reward_type: 'anchor_BTC', amount: '10.00000000', block_index: 100
        };

        expect(await verify(good), 'baseline must re-derive cleanly').to.equal(true);
        // oracle_round/attest_fee are indexer-derived and must never ride the archive.
        expect(await verify(Object.assign({}, good, { reward_type: 'oracle_round' }))).to.equal(false);
        // Pubkey outside our oracle_publish set at the earn block.
        expect(await verify(Object.assign({}, good, { validator_pubkey: 'ab'.repeat(32), source: srcOf('ab'.repeat(32)) }))).to.equal(false);
        // Amount must equal OUR configured publish reward exactly.
        expect(await verify(Object.assign({}, good, { amount: '11.00000000' }))).to.equal(false);
        // Source must match our own block-scoped indexer resolution.
        expect(await verify(Object.assign({}, good, { source: 'src_forged' }))).to.equal(false);
        // A held (type, round) row must agree - a leader crediting itself for
        // another hub's publish diverges here on every honest hub.
        expect(await verify(Object.assign({}, good, { validator_pubkey: pk1, source: srcOf(pk1) }))).to.equal(false);
        // Absence alone is tolerated (late joiner): an unheld round still
        // verifies on re-derivation.
        expect(await verify(Object.assign({}, good, { round_number: 8 }))).to.equal(true);
    });
}

// The next batch seq spans reward rows, and mirror ids are bookkeeping only.
function registerRewardBookkeepingCases() {
    it('getNextBatchSeq spans validator_rewards too', async function () {
        let bus = buildMesh(1, { rewards: [rewardRow(pkOf(0), { batch_seq: 5 })] });
        expect(await bus.nodes[0].pub.getNextBatchSeq()).to.equal(6);  // matches/calls hold no seq ≥ 5
    });

    it('followers tolerate per-hub mirror ids in archived rows (id is bookkeeping, not consensus)', async function () {
        // Live finding (3-hub venue): each hub assigns its own AUTO_INCREMENT id
        // to the same finalized row (hub1=60, hub2=36, hub3=34 for one call) -
        // byte-comparing ids made every multi-hub archive unverifiable.
        let bus = buildMesh(4, { btcBlock: 101, network: 'mainnet' });   // count-path (SWQ off below 961000)
        let leader = archiveLeader(bus);
        for (let nd of bus.nodes) {
            if (nd !== leader) nd.db.matches[0].id = 1000 + nd.i;          // divergent local cursors
        }
        await startAll(bus);
        await leader.pub.flush();
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'the archive to publish despite divergent local ids' });
        let v1s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(v1s.length, 'archive published despite divergent ids').to.equal(1);
    });
}
