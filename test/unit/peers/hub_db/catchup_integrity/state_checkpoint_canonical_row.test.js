'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');
const checkpointMethods = require('../../../../../src/anchor/checkpoint_engine/sign.js');
const canonicalForms = require('../../../../../src/anchor/checkpoint_engine/canonical_forms.js');
const StateCheckpointEngine = require('../../../../../src/anchor/checkpoint_engine');
const { verifyStateCheckpointCatchupRow } =
    require('../../../../../src/anchor/checkpoint_engine/catchup_verifier.js');
const { storeVerifiedRow } = require('../../../../../src/peers/hub_db/catchup_rows.js');
const HubDbPeerCatchup = require('../../../../../src/peers/hub_db/peer_catchup.js');

const SNAPSHOT_BLOCK = 1000000;

function identities(count){
    return Array.from({ length: count }, () => new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
}

function checkpoint(){
    return {
        chain: 'BTC', network: 'mainnet', block_index: 91,
        block_hash: 'ab'.repeat(32), ledger_hash: 'cd'.repeat(32),
        actions_hash: 'ef'.repeat(32), contract_hash: 'fa'.repeat(32),
        checkpoint_seq: SNAPSHOT_BLOCK, snapshot_block: SNAPSHOT_BLOCK,
        state_root: 'bc'.repeat(32), state_root_version: 1,
        block_merkle_root: 'de'.repeat(32), block_merkle_version: 1
    };
}

function sign(keys, cp){
    const canonical = canonicalForms.canonicalCheckpoint(checkpointMethods.normalizeCheckpoint(cp));
    return keys.map(key => ({ pubkey: key.getPubkeyHex(), sig: key.sign(canonical) }));
}

function contextFor(keys){
    return { network: 'mainnet', resolveCapabilityValidators: async () => keys.map((key, index) => ({
        signing_pubkey: key.getPubkeyHex(), source: 'source-' + index, amount: '1'
    })) };
}

function upperHashes(cp){
    return Object.assign({}, cp, {
        block_hash: cp.block_hash.toUpperCase(), ledger_hash: cp.ledger_hash.toUpperCase(),
        actions_hash: cp.actions_hash.toUpperCase(), contract_hash: cp.contract_hash.toUpperCase(),
        state_root: cp.state_root.toUpperCase(), block_merkle_root: cp.block_merkle_root.toUpperCase()
    });
}

async function acceptFinalizedArgs(cp, sigs){
    const createStateCheckpoint = sinon.stub().resolves({ affectedRows: 1 });
    const engine = new StateCheckpointEngine({
        db: { createStateCheckpoint }, network: 'mainnet', p2pConfig: { CHECKPOINT_ENABLED: 'false' },
        getPeerManager: () => null, getIdentity: () => null
    });
    sinon.stub(engine, 'seatedCheckpointAtSeq').resolves(null);
    sinon.stub(engine, 'persistCapabilitySnapshot').resolves();
    sinon.stub(engine, 'broadcastRowOrResync').resolves();
    sinon.stub(engine, 'advanceLatchAndEmit');
    await engine.acceptFinalized(engine.normalizeFinalizedCheckpoint(cp), sigs, 3, false);
    return createStateCheckpoint.firstCall.args;
}

describe('state checkpoint catch-up stores the verified canonical row', function () {
    afterEach(function () { sinon.restore(); });

    it('lowercases the hashes and roots of a peer row that passes quorum', async function () {
        const keys = identities(4);
        const cp = checkpoint();
        const wire = Object.assign(upperHashes(cp), { validator_signatures: JSON.stringify(sign(keys.slice(0, 3), cp)) });
        const verdict = await verifyStateCheckpointCatchupRow(wire, contextFor(keys));
        expect(verdict.ok).to.equal(true);
        for (const column of ['block_hash', 'ledger_hash', 'actions_hash', 'contract_hash', 'state_root', 'block_merkle_root'])
            expect(verdict.row[column], column).to.equal(cp[column]);
    });

    it('keeps only the deduplicated member signatures that verify, in wire order', async function () {
        const keys = identities(5);
        const cp = checkpoint();
        const good = sign(keys.slice(0, 3), cp);
        const stranger = sign([keys[4]], cp)[0];
        const forged = { pubkey: keys[3].getPubkeyHex(), sig: good[0].sig };
        const wire = Object.assign({}, cp, { validator_signatures: JSON.stringify([
            stranger, forged, good[0], { pubkey: good[0].pubkey.toUpperCase(), sig: good[0].sig }, good[1], good[2]
        ]) });
        const verdict = await verifyStateCheckpointCatchupRow(wire, contextFor(keys.slice(0, 4)));
        expect(verdict.ok).to.equal(true);
        expect(verdict.row.validator_signatures).to.equal(JSON.stringify(good));
    });

    it('writes the same createStateCheckpoint arguments the finalize path writes', async function () {
        const keys = identities(4);
        const cp = checkpoint();
        const sigs = sign(keys.slice(0, 3), cp);
        const wire = Object.assign(upperHashes(cp), {
            id: 5, validator_signatures: JSON.stringify([sigs[0], sigs[0], ...sigs.slice(1)])
        });
        const verdict = await verifyStateCheckpointCatchupRow(wire, contextFor(keys));
        const createStateCheckpoint = sinon.stub().resolves({ affectedRows: 1 });
        await storeVerifiedRow({ createStateCheckpoint }, 'state_checkpoints', verdict.row);
        const finalized = await acceptFinalizedArgs(cp, sigs);
        expect(createStateCheckpoint.firstCall.args.slice(0, 14)).to.deep.equal(finalized.slice(0, 14));
    });

    it('refuses a row whose verified signatures fall below quorum however many entries it lists', async function () {
        const keys = identities(4);
        const cp = checkpoint();
        const one = sign([keys[0]], cp);
        const wire = Object.assign({}, cp, { validator_signatures: JSON.stringify([...one, ...one, ...one]) });
        expect(await verifyStateCheckpointCatchupRow(wire, contextFor(keys)))
            .to.deep.include({ ok: false, reason: 'checkpoint signatures do not meet quorum' });
    });
});

describe('peer catch-up row selection after verification', function () {
    function catchupWith(verdict){
        const storeRow = sinon.stub().resolves();
        const catchup = new HubDbPeerCatchup({
            db: {}, peerManager: {}, storeRow, hasRow: async () => false,
            getVerifier: () => async () => verdict
        });
        sinon.stub(catchup, 'hasRow').resolves(false);
        sinon.stub(catchup, 'verifyWalkRow').resolves(verdict);
        return { catchup, storeRow };
    }

    it('stores the row a verifier returns, without the wire id', async function () {
        const { catchup, storeRow } = catchupWith({ ok: true, row: { id: 9, block_hash: 'aa' } });
        await catchup.processBatch({ table: 'state_checkpoints' }, [{ id: 9, block_hash: 'AA' }]);
        expect(storeRow.firstCall.args).to.deep.equal(['state_checkpoints', { block_hash: 'aa' }]);
    });

    it('stores the wire row when the verifier returns no row', async function () {
        for (const verdict of [true, { ok: true }]) {
            const { catchup, storeRow } = catchupWith(verdict);
            await catchup.processBatch({ table: 'oracle_prices' }, [{ id: 9, block_hash: 'AA' }]);
            expect(storeRow.firstCall.args).to.deep.equal(['oracle_prices', { block_hash: 'AA' }]);
        }
    });
});
