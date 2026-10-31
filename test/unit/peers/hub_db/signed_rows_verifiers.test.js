'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const swq = require('../../../../src/consensus/stake_weighted_quorum.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const checkpointForms = require('../../../../src/anchor/checkpoint_engine/canonical_forms.js');
const checkpointVerifier = require('../../../../src/anchor/checkpoint_engine/catchup_verifier.js');
const { rememberCatchupHub } = require('../../../../src/peers/hub_db/catchup_context.js');
const capabilityVerifier = require('../../../../src/oracle/price_aggregator/capability_catchup_verifier.js');
const attestationVerifier = require('../../../../src/attestation/response_mirror/catchup_verifier.js');

const PUBKEY = 'ab'.repeat(32);

function signedCheckpoint(network, signers) {
    const row = {
        chain: 'BTC', network, block_index: 91, block_hash: 'block',
        ledger_hash: 'ledger', actions_hash: 'actions', contract_hash: 'contract',
        checkpoint_seq: 12, snapshot_block: 12, state_root: null,
        state_root_version: null, block_merkle_root: null, block_merkle_version: null
    };
    const canonical = checkpointForms.canonicalCheckpoint(row);
    row.validator_signatures = JSON.stringify(signers.map(signer => ({
        pubkey: signer.getPubkeyHex(), sig: signer.sign(canonical)
    })));
    return row;
}

function checkpointDb(signers) {
    return {
        findCapabilitySnapshotsBySnapshotBlock: async () => signers.map((signer, index) => ({
            signing_pubkey: signer.getPubkeyHex(), source: 'source-' + index,
            amount: ['70', '20', '10'][index]
        }))
    };
}

describe('state_checkpoints production catch-up context', function () {
    it('uses the deployment network and refuses a differently labelled signed row', async function () {
        const signers = Array.from({ length: 3 }, () => new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
        const context = { db: checkpointDb(signers), network: 'mainnet' };
        expect(await checkpointVerifier.verifyStateCheckpointCatchupRow(
            signedCheckpoint('mainnet', signers), context)).to.equal(true);
        const foreign = signedCheckpoint('testnet', [signers[0]]);
        expect(await checkpointVerifier.verifyStateCheckpointCatchupRow(foreign, context)).to.deep.equal({
            ok: false, reason: 'checkpoint network does not match deployment network'
        });
        expect(await checkpointVerifier.verifyStateCheckpointCatchupRow(foreign, { db: context.db })).to.equal(true);
    });

    it('marks validator lookup errors retryable while malformed rows remain lasting refusals', async function () {
        const signer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const db = { findCapabilitySnapshotsBySnapshotBlock: async () => { throw new Error('database unavailable'); } };
        const verdict = await checkpointVerifier.verifyStateCheckpointCatchupRow(
            signedCheckpoint('mainnet', [signer]), { db, network: 'mainnet' });
        expect(verdict).to.deep.equal({ ok: false, retry: true,
            reason: 'validator lookup failed for snapshot_block 12: database unavailable' });
        expect(await checkpointVerifier.verifyStateCheckpointCatchupRow(
            { network: 'mainnet' }, { db, network: 'mainnet' })).to.deep.equal({
            ok: false, reason: 'malformed state checkpoint row'
        });
    });
});

describe('capability_snapshots catch-up verifier', function () {
    afterEach(function () { sinon.restore(); });

    it('accepts only a row in the locally resolved signed snapshot', async function () {
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
        const getWeightSnapshot = sinon.stub().resolves({
            validators: [{ pubkey: PUBKEY, source: 'stake-source', weight: '125.50' }]
        });
        const hub = {
            db: {},
            network: 'testnet',
            capabilitySnapshot: { getWeightSnapshot }
        };
        rememberCatchupHub(hub);
        const row = {
            snapshot_block: 900000,
            capability: 'attestation',
            signing_pubkey: PUBKEY,
            source: 'stake-source',
            amount: '125.50'
        };

        expect(await capabilityVerifier.verifyCapabilitySnapshotRow(row, { db: hub.db })).to.deep.equal({ ok: true });
        expect(getWeightSnapshot.calledOnceWith('attestation', 900000)).to.equal(true);

        row.amount = '125.51';
        expect(await capabilityVerifier.verifyCapabilitySnapshotRow(row, { hub })).to.deep.equal({
            ok: false,
            reason: 'row is absent from the local capability snapshot'
        });
    });
});

describe('capability_snapshots catch-up snapshot resolver', function () {
    afterEach(function () { sinon.restore(); });

    it('fails closed on an unresolved, truncated, or malformed snapshot', async function () {
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        const getSnapshot = sinon.stub();
        const hub = { network: 'testnet', capabilitySnapshot: { getSnapshot } };
        const row = {
            snapshot_block: 900000,
            capability: 'price',
            signing_pubkey: PUBKEY,
            source: '',
            amount: '10'
        };

        getSnapshot.onFirstCall().resolves(null);
        getSnapshot.onSecondCall().resolves({ truncated: true, validators: [] });
        expect((await capabilityVerifier.verifyCapabilitySnapshotRow(row, { hub })).reason)
            .to.equal('local capability snapshot is unresolved');
        expect((await capabilityVerifier.verifyCapabilitySnapshotRow(row, { hub })).reason)
            .to.equal('local capability snapshot is truncated');
        expect((await capabilityVerifier.verifyCapabilitySnapshotRow({ ...row, signing_pubkey: 'bad' }, { hub })).reason)
            .to.equal('malformed capability snapshot row');
    });
});

describe('attestation_responses catch-up verifier', function () {
    afterEach(function () { sinon.restore(); });

    function fixture(signatureVerdict) {
        const request = { request_id: 'cd'.repeat(32), block_index: 800000, action_index: 42 };
        const shaped = { request_id: request.request_id, response_hash: 'ef'.repeat(32) };
        const mirror = {
            parseGossipRow: sinon.stub().returns(shaped),
            resolveLocalRequest: sinon.stub().resolves({ request, latestBlock: 800010 }),
            isMirrorEra: sinon.stub().returns(true),
            intOrNull: (value) => value == null ? null : Math.trunc(Number(value)),
            verifyGossipedRow: sinon.stub().resolves(signatureVerdict)
        };
        const row = {
            request_id: request.request_id,
            response_hash: shaped.response_hash,
            request_block_index: 800000,
            request_action_index: 42
        };
        return { mirror, row, request, hub: { attestationResponseMirror: mirror } };
    }

    it('delegates signature verification to the live response mirror', async function () {
        const f = fixture({ ok: true, error: null });

        expect(await attestationVerifier.verifyAttestationResponseRow(f.row, { hub: f.hub }))
            .to.deep.equal({ ok: true });
        expect(f.mirror.verifyGossipedRow.calledOnceWith(
            f.mirror.parseGossipRow.firstCall.returnValue, f.request, 800010)).to.equal(true);
    });

    it('refuses bad response signatures and peer-supplied request positions', async function () {
        const badSignature = fixture({ ok: false, error: 'insufficient valid signatures (1/2)' });
        expect((await attestationVerifier.verifyAttestationResponseRow(
            badSignature.row, { hub: badSignature.hub })).reason)
            .to.equal('insufficient valid signatures (1/2)');

        const badPosition = fixture({ ok: true, error: null });
        badPosition.row.request_action_index = 43;
        expect((await attestationVerifier.verifyAttestationResponseRow(
            badPosition.row, { hub: badPosition.hub })).reason)
            .to.equal('attestation response request position differs from local state');
        expect(badPosition.mirror.verifyGossipedRow.called).to.equal(false);
    });
});
