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
// StateAnchorPublisher: hub-to-hub federation of the confirmed
// anchor_reward_attestations row over XANCREWARD, and every way a receiver
// must refuse to turn a wire message into a money row.

const { expect }            = require('chai');
const sinon                 = require('sinon');
const StateAnchorPublisher  = require('../../../../../src/anchor/publisher');
const ValidatorIdentity     = require('../../../../../src/validators/identity');
const arMod                 = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const { DB_METHODS }        = require('../../../../helpers/mockHub.js');
const { CP_ROW }            = require('../../../../helpers/anchor_mesh.js');
const { XANCREWARD }        = require('../../../../../src/anchor/publisher.js');

const TXID = 'ab'.repeat(32);

// A hub with an identity, a wired DOGE indexer, and a resolvable oracle_publish set.
// `members` are the pubkeys in that set; the receiver's own key is always a member.
function makeReceiver(members) {
    const queries   = [];
    const broadcast = [];
    const sent      = [];
    const db = { ...DB_METHODS,
        async doQuery(sql, params) {
            queries.push({ sql, params });
            if (sql.indexOf('SELECT * FROM state_checkpoints') === 0) return [Object.assign({}, CP_ROW)];
            if (sql.indexOf('SELECT') === 0) return [{ id: 1, publisher: params[5] }];
            return { affectedRows: 1 };
        }
    };
    const hub = { db, getIdentity: () => null, hubDbBroadcaster: { broadcastRow: (ev) => broadcast.push(ev) } };
    const pub = new StateAnchorPublisher(hub);
    pub.identity    = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    pub.peerManager = { broadcast: (type, data) => sent.push({ type, data }), on: () => {} };
    pub.indexers.DOGE = { url: 'http://doge.indexer.invalid', key: '' };
    pub.dogeConfirmations = 60;
    pub.network = CP_ROW.network;
    const set = (members || []).concat([pub.identity.getPubkeyHex().toLowerCase()]);
    pub.resolveCapabilitySet = async () => set.map(pk => ({ pubkey: pk, source: pk, amount: '1' }));
    return { pub, queries, broadcast, sent, set };
}

// A signed XANCREWARD payload for the BUNDLE (v0) reward on CP_ROW, attested by
// `signers` (ValidatorIdentity instances) and relayed by `sender`. `chain` on this
// wire is the checkpoint IDENTITY the mined-anchor proof re-runs against; the row it
// eventually writes carries 'DOGE' (D21).
function payloadFrom(pub, sender, signers, over) {
    const publisher = (over && over.publisher) || sender.getPubkeyHex().toLowerCase();
    const d = Object.assign({
        chain: CP_ROW.chain, network: CP_ROW.network,
        reward_type: 'anchor_bundle', round_reference: CP_ROW.snapshot_block,
        snapshot_block: CP_ROW.snapshot_block, publisher: publisher,
        doge_anchor_txid: TXID, anchor_version: 0,
        block_index: CP_ROW.block_index, checkpoint_seq: CP_ROW.checkpoint_seq
    }, over || {});
    const canonical = (d.reward_type === 'anchor_archive')
        ? pub.archiveAttestationCanonical({ network: d.network, snapshot_block: d.snapshot_block }, d.round_reference, d.publisher)
        : pub.attestationCanonical({ network: d.network, snapshot_block: d.snapshot_block }, d.publisher);
    d.attest_sigs = (over && over.attest_sigs) || signers.map(s => ({
        pubkey: s.getPubkeyHex().toLowerCase(), sig: s.sign(canonical)
    }));
    d.sig_pubkey = sender.getPubkeyHex().toLowerCase();
    d.sig        = sender.sign(pub.rewardFederationCanonical(d));
    return d;
}

const onChain = (over) => Object.assign({
    exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
    confirmations: 60, txid: TXID,
    block_hash: CP_ROW.block_hash, ledger_hash: CP_ROW.ledger_hash,
    actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash,
    // A v0 bundle is root-bearing, so verifyAnchorOnChain byte-matches the roots too.
    state_root: CP_ROW.state_root, block_merkle_root: CP_ROW.block_merkle_root
}, over || {});

const inserts = (queries) => queries.filter(q => q.sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0);

// ── XANCREWARD: hub-to-hub federation of the confirmed attestation row (AML #4170) ──
//
// Before this, the anchor_reward_attestations row reached only the PUBLISHING hub's own
// indexer subscribers. The publisher rotates per checkpoint, so a federation's hubs held
// disjoint subsets and each indexer derived only the slice its own hub happened to publish.
// The fix broadcasts the CONFIRMED row, and the security property is entirely on the
// receiving side: the message supplies identity, never authority. Every one of these cases
// is a way a receiver must refuse to turn a wire message into a money row.
describe('StateAnchorPublisher XANCREWARD federation (#4170)', function () {
    afterEach(() => sinon.restore());

    registerPublisherFederationCases();
    registerReceiverProofCases();
    registerReceiverRefusalCases();
    registerReceiverPairingCases();
});

// The publisher federates at the CONFIRMED write and persists the proven txid.
function registerPublisherFederationCases() {
    it('the publisher federates the row at the CONFIRMED write, never at broadcast time', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries, sent } = makeReceiver([]);
        const me = pub.identity.getPubkeyHex().toLowerCase();
        pub.deferRewardAttestation({
            chain: CP_ROW.chain, network: CP_ROW.network,
            blockIndex: CP_ROW.block_index, checkpointSeq: CP_ROW.checkpoint_seq,
            txid: TXID, anchorVersion: 0,
            rewardType: 'anchor_bundle', roundReference: CP_ROW.snapshot_block,
            snapshotBlock: CP_ROW.snapshot_block, publisher: me,
            attestSigs: [{ pubkey: me, sig: 'ef'.repeat(64) }],
            federate: true
        });
        expect(sent.filter(m => m.type === XANCREWARD).length, 'nothing federated while unconfirmed').to.equal(0);

        pub.indexerCall = async () => onChain();
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'the row is written locally first').to.equal(1);
        const msg = sent.find(m => m.type === XANCREWARD);
        expect(msg, 'the confirmed row is federated').to.exist;
        expect(msg.data.doge_anchor_txid, 'bound to the PROVEN txid').to.equal(TXID);
        expect(msg.data.reward_amount, 'the frozen amount is never put on the wire').to.equal(undefined);
    });

    it('the proven txid is persisted on the row (doge_anchor_txid)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeReceiver([]);
        const me = pub.identity.getPubkeyHex().toLowerCase();
        pub.deferRewardAttestation({
            chain: CP_ROW.chain, network: CP_ROW.network,
            blockIndex: CP_ROW.block_index, checkpointSeq: CP_ROW.checkpoint_seq,
            txid: TXID, anchorVersion: 0,
            rewardType: 'anchor_bundle', roundReference: CP_ROW.snapshot_block,
            snapshotBlock: CP_ROW.snapshot_block, publisher: me,
            attestSigs: [{ pubkey: me, sig: 'ef'.repeat(64) }]
        });
        pub.indexerCall = async () => onChain();
        await pub.drainDeferredRewardAttest();
        const ins = inserts(queries)[0];
        expect(ins.sql).to.contain('doge_anchor_txid');
        expect(ins.params[8]).to.equal(TXID);
    });
}

// A receiver writes only once IT proves the anchor, and never below the gate.
function registerReceiverProofCases() {
    it('a receiver queues a quorum-valid message and writes it only once IT proves the anchor mined', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub, queries, sent } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        // A 2-member set needs both signatures: the relayer's and this receiver's own.
        await pub.handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer, pub.identity]) });
        expect(pub._deferredRewardAttest.size, 'queued behind its own mined-anchor proof').to.equal(1);
        expect(inserts(queries).length, 'nothing written on receipt alone').to.equal(0);

        pub.indexerCall = async () => onChain();
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'written once this hub proved the anchor itself').to.equal(1);
        expect(sent.filter(m => m.type === XANCREWARD).length, 'a receiver never re-broadcasts').to.equal(0);
    });

    it('a receiver writes NOTHING when its own DOGE view cannot confirm the anchor', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub, queries } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        await pub.handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer, pub.identity]) });
        expect(pub._deferredRewardAttest.size, 'the quorum was valid, so it queued').to.equal(1);
        pub.indexerCall = async () => ({ exists: false, checkpoint_anchored: false });
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length).to.equal(0);
    });

    it('below the derive gate a receiver ignores the message entirely', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub, queries } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        await pub.handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer]) });
        expect(pub._deferredRewardAttest.size).to.equal(0);
        expect(queries.length).to.equal(0);
    });
}

// Every quorum, membership, signature and shape refusal on the receiver.
function registerReceiverRefusalCases() {
    it('refuses a message whose XANCPUB quorum does not verify against the RECEIVER\'s own set', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const outsider = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        // The relayer is a member, but the only attestation signature belongs to a
        // non-member: a quorum the receiver's own oracle_publish set does not support.
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        const d = payloadFrom(pub, relayer, [outsider]);
        await pub.handleRewardAttestation({ data: d });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('refuses a message relayed by a non-member (no free verification work for outsiders)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const outsider = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([]);                       // outsider is NOT in the set
        await pub.handleRewardAttestation({ data: payloadFrom(pub, outsider, [outsider]) });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('refuses a message crediting a publisher outside the receiver\'s oracle_publish set', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        await pub.handleRewardAttestation({
            data: payloadFrom(pub, relayer, [relayer], { publisher: 'cd'.repeat(32) })
        });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('refuses a message whose transport signature does not verify (a tampered tuple)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        const d = payloadFrom(pub, relayer, [relayer]);
        d.round_reference = d.round_reference + 1;              // signed over the ORIGINAL tuple
        await pub.handleRewardAttestation({ data: d });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('refuses a malformed txid, an unattested ANCHOR version, and a mismatched reward_type', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        for (const over of [{ doge_anchor_txid: 'nope' }, { anchor_version: 0 }, { reward_type: 'anchor_LTC' }]) {
            await pub.handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer], over) });
            expect(pub._deferredRewardAttest.size, JSON.stringify(over)).to.equal(0);
        }
    });
}

// Fail-closed sets, cross-paired legs, own echoes and the tagged transport canonical.
function registerReceiverPairingCases() {
    it('refuses to act on an unresolved oracle_publish set (fail closed)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        pub.resolveCapabilitySet = async () => [];
        await pub.handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer]) });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    // reward_type and anchor_version were validated INDEPENDENTLY, so a cross-paired
    // tuple got in: v1 is the archive leg and v0 the checkpoint-bundle leg, and the BTC
    // derive path (indexer anchor_proof_client._judge) enforces that pairing forever.
    // A cross-paired row passes the drain's byte-match (an archive head wraps the same
    // checkpoint, so the four core hashes agree) and lands permanently in an
    // append-only table the derive path then rejects: a stranded credit, not a mint.
    it('refuses a reward_type cross-paired with the other leg\'s anchor_version', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        for (const over of [{ anchor_version: 1 },                                  // bundle leg on an archive version
                            { reward_type: 'anchor_archive', anchor_version: 0 }]) {  // archive leg on the bundle version
            await pub.handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer], over) });
            expect(pub._deferredRewardAttest.size, JSON.stringify(over)).to.equal(0);
        }
    });

    it('ignores its own broadcast echoing back', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub } = makeReceiver([]);
        await pub.handleRewardAttestation({ data: payloadFrom(pub, pub.identity, [pub.identity]) });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('the transport canonical is tagged so it can never be replayed as an attestation signature', function () {
        const { pub } = makeReceiver([]);
        const d = { chain: 'BTC', network: 'regtest', reward_type: 'anchor_bundle', round_reference: 100,
                    snapshot_block: 100, publisher: 'ab'.repeat(32), doge_anchor_txid: TXID,
                    anchor_version: 0, block_index: 494, checkpoint_seq: 7 };
        expect(pub.rewardFederationCanonical(d)).to.equal(
            'XANCREWARD|BTC|regtest|anchor_bundle|100|100|' + 'ab'.repeat(32) + '|' + TXID + '|0|494|7');
    });
}
