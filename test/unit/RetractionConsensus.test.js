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
//  full fix: 2f+1 co-signed quorum-class retraction broadcasts.
// Covers the canonical byte-shape (pinned against the hub_db_sync consumer
// rebuild), the single-node self-sign path, gate/identity fallthroughs to the
// legacy unsigned broadcast, follower sign-only-with-local-intent, initiator
// quorum collection, FINALIZED adoption + dedup, and the timeout downgrade.

const assert            = require('assert');
const crypto            = require('crypto');
const { EventEmitter }  = require('events');
const RetractionConsensus = require('../../src/RetractionConsensus.js');
const ValidatorIdentity   = require('../../src/ValidatorIdentity.js');
const { waitUntil }       = require('../helpers/waitUntil');

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
    let db = { doQuery: async (sql, args) => { queries.push({ sql, args }); return /^SELECT/.test(sql) ? [{ id: 1 }] : []; } };
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
        _resolveBtcLatestBlock: async () => btcBlock
    };
    hub._queries = queries;
    return hub;
}

describe('RetractionConsensus ( signed retractions) @regression @tier1', function () {

    it('canonicalRetraction matches the golden consumer vector byte-for-byte', function () {
        assert.strictEqual(RetractionConsensus.canonicalRetraction(GOLDEN_EVT), GOLDEN_CANONICAL);
    });

    it('canonical uses empty slots for absent to_action_index / generation', function () {
        assert.strictEqual(
            RetractionConsensus.canonicalRetraction({ table: 'cross_chain_matches', source_chain: 'LTC', from_action_index: 3, snapshot_block: 10 }),
            'XRETRACTV1|cross_chain_matches|LTC|3|||10');
    });

    it('single-node self-sign: broadcasts a signed deletion with a verifying signature', async function () {
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
    });

    it('below the flag-day era the broadcast stays legacy-unsigned', async function () {
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
    });

    it('non-quorum-class tables pass through unsigned even at/after the gate', async function () {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 5, retraction_generation: 1 });
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
        assert.strictEqual(hub.hubDbBroadcaster.deletions[0].retraction_signatures, undefined);
        rc.stop();
    });

    it('without a validator identity (standalone hub) the broadcast stays legacy-unsigned', async function () {
        let hub = makeHub({ identity: null });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_matches', source_chain: 'LTC', from_action_index: 9, retraction_generation: 2 });
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
        assert.strictEqual(hub.hubDbBroadcaster.deletions[0].retraction_signatures, undefined);
        rc.stop();
    });

    it('multi-node: initiator collects follower sigs to quorum and streams the signed deletion', async function () {
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
            rc._handleMessage({ type: 'XRETRACT_SIGN', data: {
                id: roundId, sig_pubkey: follower.getPubkeyHex().toLowerCase(), sig: follower.sign(GOLDEN_CANONICAL)
            }});
        }
        // allow the async _finalize to run
        await new Promise(r => setImmediate(r));
        let dels = hub.hubDbBroadcaster.deletions;
        assert.strictEqual(dels.length, 1, 'quorum (3 of 4 sources) must finalize');
        assert.strictEqual(dels[0].retraction_signatures.length, 3);
        assert.ok(hub.peerManager.broadcasts.some(b => b.type === 'XRETRACT_FINALIZED'));
        rc.stop();
    });

    it('initiator rejects signatures from non-members and over the wrong canonical', async function () {
        let idA = makeIdentity(), idB = makeIdentity(), stranger = makeIdentity();
        let vset = [idA, idB].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: idA, validators: vset, p2p: { RETRACT_ROUND_TIMEOUT_MS: 5000, RETRACT_SIGN_RETRY_MS: 5000 } });
        let rc  = new RetractionConsensus(hub);
        await rc.submitLocal({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99, retraction_generation: 7 });
        let roundId = crypto.createHash('sha256').update(GOLDEN_CANONICAL, 'utf8').digest('hex');
        // stranger (not in snapshot) and a member signing a TAMPERED canonical: both ignored
        rc._handleMessage({ type: 'XRETRACT_SIGN', data: { id: roundId, sig_pubkey: stranger.getPubkeyHex().toLowerCase(), sig: stranger.sign(GOLDEN_CANONICAL) } });
        rc._handleMessage({ type: 'XRETRACT_SIGN', data: { id: roundId, sig_pubkey: idB.getPubkeyHex().toLowerCase(), sig: idB.sign(GOLDEN_CANONICAL + 'X') } });
        await new Promise(r => setImmediate(r));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0);
        rc.stop();
    });

    it('follower signs a SIGN_REQ only when its OWN indexer pushed a matching intent', async function () {
        let leader = makeIdentity(), follower = makeIdentity();
        let vset = [leader, follower].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: follower, validators: vset });
        let rc  = new RetractionConsensus(hub);
        let req = { type: 'XRETRACT_SIGN_REQ', data: {
            retraction: GOLDEN_EVT, sig_pubkey: leader.getPubkeyHex().toLowerCase(), sig: leader.sign(GOLDEN_CANONICAL)
        }};
        // No local intent -> silent
        rc._handleMessage(req);
        await new Promise(r => setImmediate(r));
        assert.ok(!hub.peerManager.broadcasts.some(b => b.type === 'XRETRACT_SIGN'), 'must not sign without a matching local intent');
        // Local intent arrives (own indexer pushed the same retraction; note its
        // GENERATION differs, which must not matter - instance-local counters)
        rc.localIntents.set(RetractionConsensus.intentKey({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, to_action_index: 99 }), Date.now());
        rc._handleMessage(req);
        await new Promise(r => setImmediate(r));
        let sign = hub.peerManager.broadcasts.find(b => b.type === 'XRETRACT_SIGN');
        assert.ok(sign, 'must sign once the local intent matches');
        assert.ok(ValidatorIdentity.verify(GOLDEN_CANONICAL, sign.data.sig, follower.getPubkeyHex().toLowerCase()));
        rc.stop();
    });

    it('follower refuses a SIGN_REQ whose snapshot_block drifts beyond the bound', async function () {
        let leader = makeIdentity(), follower = makeIdentity();
        let vset = [leader, follower].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: follower, validators: vset, btcBlock: 5000 });
        let rc  = new RetractionConsensus(hub);
        rc.localIntents.set(RetractionConsensus.intentKey(GOLDEN_EVT), Date.now());
        let evt = Object.assign({}, GOLDEN_EVT, { snapshot_block: 5000 + 145 });   // > 144 drift
        rc._handleMessage({ type: 'XRETRACT_SIGN_REQ', data: {
            retraction: evt, sig_pubkey: leader.getPubkeyHex().toLowerCase(),
            sig: leader.sign(RetractionConsensus.canonicalRetraction(evt))
        }});
        await new Promise(r => setImmediate(r));
        assert.ok(!hub.peerManager.broadcasts.some(b => b.type === 'XRETRACT_SIGN'));
        rc.stop();
    });

    it('FINALIZED adoption: a non-initiator hub re-verifies the quorum and streams the signed deletion once', async function () {
        let idA = makeIdentity(), idB = makeIdentity(), idC = makeIdentity(), me = makeIdentity();
        let vset = [idA, idB, idC, me].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: me, validators: vset });
        let rc  = new RetractionConsensus(hub);
        let sigs = [idA, idB, idC].map(i => ({ pubkey: i.getPubkeyHex().toLowerCase(), sig: i.sign(GOLDEN_CANONICAL) }));
        let env  = { type: 'XRETRACT_FINALIZED', data: { retraction: GOLDEN_EVT, signatures: sigs } };
        rc._handleMessage(env);
        await new Promise(r => setImmediate(r));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
        assert.strictEqual(hub.hubDbBroadcaster.deletions[0].retraction_signatures.length, 3);
        // Redelivery is deduped by the finalized ring
        rc._handleMessage(env);
        await new Promise(r => setImmediate(r));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
        rc.stop();
    });

    it('FINALIZED with a sub-quorum signature set is ignored', async function () {
        let idA = makeIdentity(), idB = makeIdentity(), idC = makeIdentity(), me = makeIdentity();
        let vset = [idA, idB, idC, me].map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        let hub = makeHub({ identity: me, validators: vset });
        let rc  = new RetractionConsensus(hub);
        let sigs = [idA, idB].map(i => ({ pubkey: i.getPubkeyHex().toLowerCase(), sig: i.sign(GOLDEN_CANONICAL) }));
        rc._handleMessage({ type: 'XRETRACT_FINALIZED', data: { retraction: GOLDEN_EVT, signatures: sigs } });
        await new Promise(r => setImmediate(r));
        assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0, '2 of 4 sources (weighted 600<=800*2/3... 3*200>2*400 false) must not stream');
        rc.stop();
    });

    it('round timeout downgrades to the legacy unsigned broadcast (never drops the retraction)', async function () {
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
    });

    // SWQ-TRUNC-MIRROR (). The retraction rail is a fourth writer into the
    // shared capability_snapshots mirror, and `.truncated` is a JS array property with
    // no column behind it: mirroring a capped set hands the off-BTC verifiers a partial
    // stake denominator they read back as COMPLETE, while this class rejects the same
    // set at its own meetsStakeThreshold. Persist must write nothing and stream nothing.
    it('refuses to persist or mirror a TRUNCATED capability set ()', async function () {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        hub.capabilitySnapshot.getWeightSnapshot = async () => ({
            validators: [{ pubkey: pk, source: 'srcA', weight: '100' }], truncated: true });
        let rc = new RetractionConsensus(hub);
        await rc._persistCapabilitySnapshot('cross_chain', 5000);
        assert.ok(!hub._queries.some(q => /INSERT IGNORE INTO capability_snapshots/.test(q.sql)),
            'no capability_snapshots row may be written from a truncated set');
        assert.strictEqual(hub.hubDbBroadcaster.rows.length, 0, 'nothing may be mirrored either');
        rc.stop();
    });

    it('still persists an untruncated capability set (the guard is not a blanket refusal)', async function () {
        let id  = makeIdentity();
        let pk  = id.getPubkeyHex().toLowerCase();
        let hub = makeHub({ identity: id, validators: [{ pubkey: pk, source: 'srcA', weight: '100' }] });
        let rc  = new RetractionConsensus(hub);
        await rc._persistCapabilitySnapshot('cross_chain', 5000);
        assert.ok(hub._queries.some(q => /INSERT IGNORE INTO capability_snapshots/.test(q.sql)));
        assert.ok(hub.hubDbBroadcaster.rows.some(r => r.table === 'capability_snapshots'));
        rc.stop();
    });

});
