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
// full fix: 2f+1 co-signed quorum-class retraction broadcasts.
// Covers the canonical byte-shape (pinned against the hub_db_sync consumer
// rebuild), the single-node self-sign path, gate/identity fallthroughs to the
// legacy unsigned broadcast, follower sign-only-with-local-intent, initiator
// quorum collection, FINALIZED adoption + dedup, the timeout downgrade, and the
// fail-closed finalize (a throwing / zero-row / truncated capability-snapshot persist
// defers the signed deletion and releases the round id instead of streaming it).
const assert            = require('assert');
const crypto            = require('crypto');
const { EventEmitter }  = require('events');
const RetractionConsensus = require('../../../src/consensus/retraction.js');
const ValidatorIdentity   = require('../../../src/validators/identity.js');
const { waitUntil }       = require('../../helpers/waitUntil');
const { DB_METHODS } = require('../../helpers/mockHub.js');
// The golden canonical: MUST byte-match hub_db_sync.js canonicalRetraction()
// in xchain-indexer / xchain-explorer (their suites sign this same literal).
const GOLDEN_EVT = {
    table: 'cross_chain_calls', source_chain: 'DOGE',
    from_action_index: 42, to_action_index: 99,
    retraction_generation: 7, snapshot_block: 5000
};
const GOLDEN_CANONICAL = 'XRETRACTV1|cross_chain_calls|DOGE|42|99|7|5000';
function makeIdentity(){
    return new ValidatorIdentity(crypto.randomBytes(32).toString('hex'));
}
// Minimal hub stub. Weighted-quorum path is what regtest exercises (SWQ is
// genesis-active there), so snapshot validators carry real sources/weights.
function makeHub({ identity, validators, network = 'regtest', btcBlock = 5000, p2p = {} } = {}){
    let peerManager = new EventEmitter();
    peerManager.broadcasts = [];
    peerManager.broadcast = (type, data) => peerManager.broadcasts.push({ type, data });
    let broadcaster = {
        deletions: [], rows: [],
        broadcastDeletion(evt){ this.deletions.push(evt); },
        broadcastRow(evt){ this.rows.push(evt); }
    };
    let queries = [];
    let db = { ...DB_METHODS, doQuery: async (sql, args) => { queries.push({ sql, args }); return /^SELECT/.test(sql) ? [{ id: 1 }] : []; } };
    let vset = validators || [];
    let hub = {
        identity: identity || null,
        peerManager,
        hubDbBroadcaster: broadcaster,
        db,
        network,
        p2pConfig: p2p,
        capabilitySnapshot: {
            getWeightSnapshot: async () => ({ validators: vset.map(v => ({ pubkey: v.pubkey, source: v.source, weight: v.weight })) }),
            getSnapshot:       async () => ({ validators: vset.map(v => ({ pubkey: v.pubkey, amount: v.weight })) })
        },
        resolveBtcLatestBlock: async () => btcBlock
    };
    hub._queries = queries;
    return hub;
}
{
    function canonicalretractionMatchesTheGoldenConsumerVectorTest2() {
        assert.strictEqual(RetractionConsensus.canonicalRetraction(GOLDEN_EVT), GOLDEN_CANONICAL);
    }
    function canonicalUsesEmptySlotsForAbsentTest3() {
        assert.strictEqual(
            RetractionConsensus.canonicalRetraction({ table: 'cross_chain_matches', source_chain: 'LTC', from_action_index: 3, snapshot_block: 10 }),
            'XRETRACTV1|cross_chain_matches|LTC|3|||10');
    }
    async function singleNodeSelfSignBroadcastsATest4() {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99, retraction_generation: 7 });
        let dels = hub.hubDbBroadcaster.deletions;
        assert.strictEqual(dels.length, 1);
        assert.strictEqual(dels[0].snapshot_block, 5000);
        assert.strictEqual(dels[0].retraction_signatures.length, 1);
        assert.strictEqual(dels[0].retraction_signatures[0].pubkey, pk);
        assert.ok(ValidatorIdentity.verify(GOLDEN_CANONICAL, dels[0].retraction_signatures[0].sig, pk),
            'signature must verify over the golden canonical');
        // The verifying snapshot rows are persisted + streamed BEFORE the deletion.
        assert.ok(hub._queries.some(q => /INSERT IGNORE INTO capability_snapshots/.test(q.sql)));
        assert.ok(hub.hubDbBroadcaster.rows.some(r => r.table === 'capability_snapshots'));
        rc.stop();
    }
    async function belowTheFlagDayEraTheTest5() {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        // mainnet threshold 963000 > snapshot 5000 -> gate off
        let hub = makeHub({ identity: id, network: 'mainnet', validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, retraction_generation: 7 });
        let dels = hub.hubDbBroadcaster.deletions;
        assert.strictEqual(dels.length, 1);
        assert.strictEqual(dels[0].retraction_signatures, undefined);
        assert.strictEqual(dels[0].snapshot_block, undefined);
        rc.stop();
    }
    async function nonQuorumClassTablesPassThroughTest6() {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 5, retraction_generation: 1 });
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
        assert.strictEqual(hub.hubDbBroadcaster.deletions[0].retraction_signatures, undefined);
        rc.stop();
    }
    async function withoutAValidatorIdentityStandaloneHubTest7() {
        let hub = makeHub({ identity: null });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_matches', source_chain: 'LTC', from_action_index: 9, retraction_generation: 2 });
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
        assert.strictEqual(hub.hubDbBroadcaster.deletions[0].retraction_signatures, undefined);
        rc.stop();
    }
    async function multiNodeInitiatorCollectsFollowerSigsTest8() {
        let idA = makeIdentity(), idB = makeIdentity(), idC = makeIdentity(), idD = makeIdentity();
        let vset = [idA, idB, idC, idD].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: idA, validators: vset, p2p: { RETRACT_ROUND_TIMEOUT_MS: 5000, RETRACT_SIGN_RETRY_MS: 5000 } });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99, retraction_generation: 7 });
        // SIGN_REQ went out, nothing streamed yet (1/4 sigs; weighted needs 3*300>2*400)
        assert.ok(hub.peerManager.broadcasts.some(b => b.type === 'XRETRACT_SIGN_REQ'));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0);
        let roundId = crypto.createHash('sha256').update(GOLDEN_CANONICAL, 'utf8').digest('hex');
        for (let follower of [idB, idC]) {
            rc.handleMessage({ type: 'XRETRACT_SIGN', data: {
                id: roundId, sig_pubkey: follower.getPubkeyHex().toLowerCase(), sig: follower.sign(GOLDEN_CANONICAL)
            }});
        }
        // allow the async finalize to run
        await new Promise(r => setImmediate(r));
        let dels = hub.hubDbBroadcaster.deletions;
        assert.strictEqual(dels.length, 1, 'quorum (3 of 4 sources) must finalize');
        assert.strictEqual(dels[0].retraction_signatures.length, 3);
        assert.ok(hub.peerManager.broadcasts.some(b => b.type === 'XRETRACT_FINALIZED'));
        rc.stop();
    }
    async function initiatorRejectsSignaturesFromNonMembersTest9() {
        let idA = makeIdentity(), idB = makeIdentity(), stranger = makeIdentity();
        let vset = [idA, idB].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: idA, validators: vset, p2p: { RETRACT_ROUND_TIMEOUT_MS: 5000, RETRACT_SIGN_RETRY_MS: 5000 } });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99, retraction_generation: 7 });
        let roundId = crypto.createHash('sha256').update(GOLDEN_CANONICAL, 'utf8').digest('hex');
        // stranger (not in snapshot) and a member signing a TAMPERED canonical: both ignored
        rc.handleMessage({ type: 'XRETRACT_SIGN', data: { id: roundId, sig_pubkey: stranger.getPubkeyHex().toLowerCase(), sig: stranger.sign(GOLDEN_CANONICAL) } });
        rc.handleMessage({ type: 'XRETRACT_SIGN', data: { id: roundId, sig_pubkey: idB.getPubkeyHex().toLowerCase(), sig: idB.sign(GOLDEN_CANONICAL + 'X') } });
        await new Promise(r => setImmediate(r));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0);
        rc.stop();
    }
    async function followerSignsASignReqOnlyTest10() {
        let leader = makeIdentity(), follower = makeIdentity();
        let vset = [leader, follower].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: follower, validators: vset });
        let rc  = new RetractionConsensus(hub);
        let req = { type: 'XRETRACT_SIGN_REQ', data: {
            retraction: GOLDEN_EVT, sig_pubkey: leader.getPubkeyHex().toLowerCase(), sig: leader.sign(GOLDEN_CANONICAL)
        }};
        // No local intent -> silent
        rc.handleMessage(req);
        await new Promise(r => setImmediate(r));
        assert.ok(!hub.peerManager.broadcasts.some(b => b.type === 'XRETRACT_SIGN'), 'must not sign without a matching local intent');
        // Local intent arrives (own indexer pushed the same retraction; note its
        // GENERATION differs, which must not matter - instance-local counters)
        rc.localIntents.set(RetractionConsensus.intentKey({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99 }), Date.now());
        rc.handleMessage(req);
        await new Promise(r => setImmediate(r));
        let sign = hub.peerManager.broadcasts.find(b => b.type === 'XRETRACT_SIGN');
        assert.ok(sign, 'must sign once the local intent matches');
        assert.ok(ValidatorIdentity.verify(GOLDEN_CANONICAL, sign.data.sig, follower.getPubkeyHex().toLowerCase()));
        rc.stop();
    }
    async function followerRefusesASignReqWhoseTest11() {
        let leader = makeIdentity(), follower = makeIdentity();
        let vset = [leader, follower].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: follower, validators: vset, btcBlock: 5000 });
        let rc  = new RetractionConsensus(hub);
        rc.localIntents.set(RetractionConsensus.intentKey(GOLDEN_EVT), Date.now());
        let evt = Object.assign({}, GOLDEN_EVT, { snapshot_block: 5000 + 145 });   // > 144 drift
        rc.handleMessage({ type: 'XRETRACT_SIGN_REQ', data: {
            retraction: evt, sig_pubkey: leader.getPubkeyHex().toLowerCase(),
            sig: leader.sign(RetractionConsensus.canonicalRetraction(evt))
        }});
        await new Promise(r => setImmediate(r));
        assert.ok(!hub.peerManager.broadcasts.some(b => b.type === 'XRETRACT_SIGN'));
        rc.stop();
    }
    async function finalizedAdoptionANonInitiatorHubTest12() {
        let idA = makeIdentity(), idB = makeIdentity(), idC = makeIdentity(), me = makeIdentity();
        let vset = [idA, idB, idC, me].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: me, validators: vset });
        let rc  = new RetractionConsensus(hub);
        let sigs = [idA, idB, idC].map(i => ({ pubkey: i.getPubkeyHex().toLowerCase(), sig: i.sign(GOLDEN_CANONICAL) }));
        let env  = { type: 'XRETRACT_FINALIZED', data: { retraction: GOLDEN_EVT, signatures: sigs } };
        rc.handleMessage(env);
        await new Promise(r => setImmediate(r));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
        assert.strictEqual(hub.hubDbBroadcaster.deletions[0].retraction_signatures.length, 3);
        // Redelivery is deduped by the finalized ring
        rc.handleMessage(env);
        await new Promise(r => setImmediate(r));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
        rc.stop();
    }
    async function finalizedWithASubQuorumSignatureTest13() {
        let idA = makeIdentity(), idB = makeIdentity(), idC = makeIdentity(), me = makeIdentity();
        let vset = [idA, idB, idC, me].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: me, validators: vset });
        let rc  = new RetractionConsensus(hub);
        let sigs = [idA, idB].map(i => ({ pubkey: i.getPubkeyHex().toLowerCase(), sig: i.sign(GOLDEN_CANONICAL) }));
        rc.handleMessage({ type: 'XRETRACT_FINALIZED', data: { retraction: GOLDEN_EVT, signatures: sigs } });
        await new Promise(r => setImmediate(r));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0, '2 of 4 sources (weighted 600<=800*2/3... 3*200>2*400 false) must not stream');
        rc.stop();
    }
    async function roundTimeoutDowngradesToTheLegacyTest14() {
        let idA = makeIdentity(), idB = makeIdentity(), idC = makeIdentity();
        let vset = [idA, idB, idC].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: idA, validators: vset, p2p: { RETRACT_ROUND_TIMEOUT_MS: 40, RETRACT_SIGN_RETRY_MS: 15 } });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99, retraction_generation: 7 });
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0);
        await waitUntil(() => hub.hubDbBroadcaster.deletions.length === 1, { label: 'the timed-out round to downgrade to an unsigned broadcast' });
        let dels = hub.hubDbBroadcaster.deletions;
        assert.strictEqual(dels.length, 1, 'timed-out round must still broadcast');
        assert.strictEqual(dels[0].retraction_signatures, undefined, 'timeout downgrade is unsigned');
        rc.stop();
    }
    // SWQ-TRUNC-MIRROR. The retraction rail is a fourth writer into the
    // shared capability_snapshots mirror, and `.truncated` is a JS array property with
    // no column behind it: mirroring a capped set hands the off-BTC verifiers a partial
    // stake denominator they read back as COMPLETE, while this class rejects the same
    // set at its own meetsStakeThreshold. Persist must write nothing and stream nothing.
    async function refusesToPersistOrMirrorATest15() {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        hub.capabilitySnapshot.getWeightSnapshot = async () => ({
            validators: [{ pubkey: pk, source: 'srcA', weight: '100' }], truncated: true });
        let rc = new RetractionConsensus(hub);
        await rc.persistCapabilitySnapshot('cross_chain', 5000);
        assert.ok(!hub._queries.some(q => /INSERT IGNORE INTO capability_snapshots/.test(q.sql)),
            'no capability_snapshots row may be written from a truncated set');
        assert.strictEqual(hub.hubDbBroadcaster.rows.length, 0, 'nothing may be mirrored either');
        rc.stop();
    }
    // Fail-closed finalize. The capability-snapshot persist is a PRECONDITION
    // of the signed deletion: mirrors verify the co-signatures against those rows, so a
    // swallowed DB throw or a silent zero-row persist would stream a deletion no mirror
    // can verify AND retire the round id forever, stranding the retracted rows live in
    // every indexer. Every failure path must stream nothing and RELEASE the round id.
    async function failClosedAThrowingCapabilityPersistTest16() {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        hub.db.doQuery = async (sql) => {
            if(/INSERT IGNORE INTO capability_snapshots/.test(sql)) throw new Error('db down');
            return /^SELECT/.test(sql) ? [{ id: 1 }] : [];
        };
        let rc = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99, retraction_generation: 7 });
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0, 'no deletion may be streamed when the persist failed');
        assert.strictEqual(rc.finalized.size, 0, 'the round id must be released so a later delivery re-runs it');
        rc.stop();
    }
    async function failClosedAZeroRowCapabilityTest17() {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        // The set resolves for the round, then degrades to [] (indexer RPC error / 401-403
        // surfaces as an empty snapshot) by the time the persist re-resolves it: the INSERT
        // loop never runs, never throws, never warns.
        let calls = 0;
        hub.capabilitySnapshot.getWeightSnapshot = async () => {
            calls++;
            return calls === 1 ? { validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] } : { validators: [] };
        };
        let rc = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99, retraction_generation: 7 });
        assert.ok(!hub._queries.some(q => /INSERT IGNORE INTO capability_snapshots/.test(q.sql)), 'nothing was persisted');
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0, 'an unverifiable deletion must not be streamed');
        assert.strictEqual(rc.finalized.size, 0, 'the round id must be released');
        rc.stop();
    }
    async function failClosedASetThatTurnsTest18() {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        let calls = 0;
        hub.capabilitySnapshot.getWeightSnapshot = async () => {
            calls++;
            let snap = { validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] };
            if(calls > 1) snap.truncated = true;   // the truncated guard writes no rows
            return snap;
        };
        let rc = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99, retraction_generation: 7 });
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0);
        assert.strictEqual(hub.hubDbBroadcaster.rows.length, 0);
        assert.strictEqual(rc.finalized.size, 0, 'a truncated persist is a deferral, not a finalization');
        rc.stop();
    }
    async function aDeferredFinalizedReRunsOnTest19() {
        let idA = makeIdentity(), idB = makeIdentity(), idC = makeIdentity(), me = makeIdentity();
        let vset = [idA, idB, idC, me].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: me, validators: vset });
        let healthy = false;
        hub.db.doQuery = async (sql, args) => {
            if(/INSERT IGNORE INTO capability_snapshots/.test(sql) && !healthy) throw new Error('db down');
            hub._queries.push({ sql, args });
            return /^SELECT/.test(sql) ? [{ id: 1 }] : [];
        };
        let rc   = new RetractionConsensus(hub);
        let sigs = [idA, idB, idC].map(i => ({ pubkey: i.getPubkeyHex().toLowerCase(), sig: i.sign(GOLDEN_CANONICAL) }));
        let env  = { type: 'XRETRACT_FINALIZED', data: { retraction: GOLDEN_EVT, signatures: sigs } };
        rc.handleMessage(env);
        await waitUntil(() => rc.finalized.size === 0, { label: 'the failed round to be released' });
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0, 'deferred, nothing streamed');
        healthy = true;
        rc.handleMessage(env);
        await waitUntil(() => hub.hubDbBroadcaster.deletions.length === 1, { label: 're-delivery to finalize once the DB recovers' });
        assert.strictEqual(hub.hubDbBroadcaster.deletions[0].retraction_signatures.length, 3);
        // and the ring still dedups a third delivery of the same round
        rc.handleMessage(env);
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
        rc.stop();
    }
    async function stillPersistsAnUntruncatedCapabilitySetTest20() {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        let rc  = new RetractionConsensus(hub);
        await rc.persistCapabilitySnapshot('cross_chain', 5000);
        assert.ok(hub._queries.some(q => /INSERT IGNORE INTO capability_snapshots/.test(q.sql)));
        assert.ok(hub.hubDbBroadcaster.rows.some(r => r.table === 'capability_snapshots'));
        rc.stop();
    }
    function retractionconsensusSignedRetractionsRegressionTier1Suite1() {
        it('canonicalRetraction matches the golden consumer vector byte-for-byte', canonicalretractionMatchesTheGoldenConsumerVectorTest2);
        it('canonical uses empty slots for absent to_action_index / generation', canonicalUsesEmptySlotsForAbsentTest3);
        it('single-node self-sign: broadcasts a signed deletion with a verifying signature', singleNodeSelfSignBroadcastsATest4);
        it('below the flag-day era the broadcast stays legacy-unsigned', belowTheFlagDayEraTheTest5);
        it('non-quorum-class tables pass through unsigned even at/after the gate', nonQuorumClassTablesPassThroughTest6);
        it('without a validator identity (standalone hub) the broadcast stays legacy-unsigned', withoutAValidatorIdentityStandaloneHubTest7);
        it('multi-node: initiator collects follower sigs to quorum and streams the signed deletion', multiNodeInitiatorCollectsFollowerSigsTest8);
        it('initiator rejects signatures from non-members and over the wrong canonical', initiatorRejectsSignaturesFromNonMembersTest9);
        it('follower signs a SIGN_REQ only when its OWN indexer pushed a matching intent', followerSignsASignReqOnlyTest10);
        it('follower refuses a SIGN_REQ whose snapshot_block drifts beyond the bound', followerRefusesASignReqWhoseTest11);
        it('FINALIZED adoption: a non-initiator hub re-verifies the quorum and streams the signed deletion once', finalizedAdoptionANonInitiatorHubTest12);
        it('FINALIZED with a sub-quorum signature set is ignored', finalizedWithASubQuorumSignatureTest13);
        it('round timeout downgrades to the legacy unsigned broadcast (never drops the retraction)', roundTimeoutDowngradesToTheLegacyTest14);
        it('refuses to persist or mirror a TRUNCATED capability set', refusesToPersistOrMirrorATest15);
        it('fail-closed: a THROWING capability persist defers the signed retraction and releases the round', failClosedAThrowingCapabilityPersistTest16);
        it('fail-closed: a ZERO-row capability persist (degraded validator set) defers the signed retraction', failClosedAZeroRowCapabilityTest17);
        it('fail-closed: a set that turns TRUNCATED at persist time defers rather than streaming', failClosedASetThatTurnsTest18);
        it('a deferred FINALIZED re-runs on re-delivery once the persist recovers, then dedups', aDeferredFinalizedReRunsOnTest19);
        it('still persists an untruncated capability set (the guard is not a blanket refusal)', stillPersistsAnUntruncatedCapabilitySetTest20);
    }
    describe('RetractionConsensus (signed retractions) @regression @tier1', retractionconsensusSignedRetractionsRegressionTier1Suite1);
}
// The parts reach canonicalRetraction and intentKey as RetractionConsensus.<static>,
// so a static reassigned on the class (a double, a patch) is the one every signing
// path runs, never a module-local copy the reassignment cannot reach.
describe('RetractionConsensus statics dispatch through the class', function () {
    it('every signing path calls the statics through the class, so a reassigned static is the one it runs', async function () {
        let leader = makeIdentity(), me = makeIdentity(), lpk = leader.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: me, validators: [leader, me].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' })) });
        let rc = new RetractionConsensus(hub), seen = [];
        let saved = { intentKey: RetractionConsensus.intentKey, canonicalRetraction: RetractionConsensus.canonicalRetraction };
        RetractionConsensus.intentKey = () => { seen.push('intentKey'); return 'reassigned'; };
        RetractionConsensus.canonicalRetraction = (evt) => { seen.push('canonical'); return saved.canonicalRetraction(evt); };
        try {
            await rc.submitLocal(GOLDEN_EVT);   // two validators: opens a signing round
            await rc.handleSignReq({ data: { retraction: GOLDEN_EVT, sig_pubkey: lpk, sig: leader.sign(GOLDEN_CANONICAL) } });
            await rc.handleFinalized({ data: { retraction: GOLDEN_EVT, signatures: [] } });
        } finally { Object.assign(RetractionConsensus, saved); rc.stop(); }
        assert.deepStrictEqual(seen, ['intentKey', 'canonical', 'canonical', 'intentKey', 'canonical']);
        assert.ok(hub.peerManager.broadcasts.some(b => b.type === 'XRETRACT_SIGN'), 'signed against the reassigned intent key');
    });
});
