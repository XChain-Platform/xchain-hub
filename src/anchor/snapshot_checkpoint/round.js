'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const ValidatorIdentity = require('../../validators/identity.js');
const {
    snapshotCheckpointBlock,
    snapshotCheckpointCanonical,
    snapshotCheckpointQuorum,
    snapshotCheckpointRoundId,
} = require('../../consensus/snapshot_checkpoint/canonical.js');
const { getLogger } = require('../../observability');
const { XSNP_SIGN_REQ, XSNP_SIGN, XSNP_FINALIZED } = require('./constants.js');
const { answerSnapshotSignRequest } = require('./cosigner.js');
const { buildSnapshotCosignView } = require('./cosign_view.js');
const { snapshotCosignRefusal } = require('./cosign_policy.js');
const { acceptSnapshotFinalized } = require('./finalized_message.js');
const { ROUND_STATE, createSnapshotRound } = require('./round_state.js');

const logger = getLogger();

function initialize(engine) {
    engine.snapshotRounds = new Map();
    engine.snapshotMessageHandler = null;
    engine.snapshotParentMessageHandler = null;
}

function start(engine) {
    if (engine.snapshotMessageHandler || !engine.source ||
        typeof engine.source.handleMessage !== 'function') return;
    engine.snapshotMessageHandler = envelope => {
        handleMessage(engine, envelope).catch(error => logger.error(
            'SnapshotCheckpointEngine: peer message error: ' +
            String(error && error.message || error)));
    };
    const original = engine.source.handleMessage;
    const wrapped = function (envelope) {
        const result = original.call(this, envelope);
        engine.snapshotMessageHandler(envelope);
        return result;
    };
    engine.snapshotParentMessageHandler = { original, wrapped };
    engine.source.handleMessage = wrapped;
}

function stop(engine) {
    const parent = engine.snapshotParentMessageHandler;
    if (parent && engine.source && engine.source.handleMessage === parent.wrapped)
        engine.source.handleMessage = parent.original;
    engine.snapshotParentMessageHandler = null;
    engine.snapshotMessageHandler = null;
    for (const pending of engine.snapshotRounds.values()) clearTimeout(pending.timer);
    engine.snapshotRounds.clear();
}

async function handleMessage(engine, envelope) {
    if (!envelope || !envelope.data) return;
    if (envelope.type === XSNP_SIGN_REQ)
        await handleSignRequest(engine, envelope.data);
    else if (envelope.type === XSNP_SIGN)
        await handleSignature(engine, envelope.data);
    else if (envelope.type === XSNP_FINALIZED)
        await persistFinalized(engine, envelope.data);
}

async function lead(engine, cp, validators, snapshotBlock, signature) {
    if (!engine.peerManager || typeof engine.peerManager.broadcast !== 'function') return;
    const id = snapshotCheckpointRoundId(cp);
    if (engine.snapshotRounds.has(id)) return;

    signature = signature || {
        pubkey: engine.identity.getPubkeyHex().toLowerCase(),
        sig: engine.identity.sign(snapshotCheckpointCanonical(cp)),
    };
    const request = {
        snapshot_block: snapshotBlock,
        cp: {
            chain: cp.chain,
            network: cp.network,
            block_index: cp.block_index,
            block_hash: cp.block_hash,
            state_root: cp.state_root,
            state_root_version: cp.state_root_version,
        },
        pubkey: signature.pubkey,
        sig: signature.sig,
    };
    const round = createSnapshotRound({
        snapshotBlock,
        cp,
        trustSet: validators,
        verify: ValidatorIdentity.verify,
        network: engine.network,
        expectedBlock: snapshotCheckpointBlock(snapshotBlock, engine.network),
        startedAt: Date.now(),
        timeoutMs: engine.roundTimeoutMs,
    });
    round.add({
        snapshot_block: snapshotBlock,
        block_index: cp.block_index,
        pubkey: request.pubkey,
        sig: request.sig,
    });
    const pending = {
        id, cp, snapshotBlock, validators, round,
        checking: false, finishing: false, timer: null,
    };
    engine.snapshotRounds.set(id, pending);
    pending.timer = setTimeout(() => {
        if (engine.snapshotRounds.get(id) === pending) engine.snapshotRounds.delete(id);
    }, engine.roundTimeoutMs);
    if (pending.timer.unref) pending.timer.unref();

    engine.peerManager.broadcast(XSNP_SIGN_REQ, request);
    await advanceLeader(engine, pending);
}

async function handleSignRequest(engine, request) {
    if (!request || !Number.isSafeInteger(request.snapshot_block) ||
        request.snapshot_block < 0 || !request.cp) return;
    const myPubkey = String(engine.identity && engine.identity.getPubkeyHex()).toLowerCase();
    if (request.pubkey === myPubkey) return;

    const validators = await engine.resolveValidators(request.snapshot_block);
    const expectedBlock = snapshotCheckpointBlock(request.snapshot_block, engine.network);
    const view = await buildSnapshotCosignView(request, {
        stateCheckpoints: engine.source,
        db: engine.db,
        network: engine.network,
        confirmations: engine.confirmations,
        gateActive: engine.gateActive(request.snapshot_block),
        expectedBlock,
    });
    const result = answerSnapshotSignRequest(request, {
        identity: engine.identity,
        validators,
        verify: ValidatorIdentity.verify,
        record: engine.signedRecord,
        view,
    });
    if (result.reply && engine.peerManager)
        engine.peerManager.broadcast(XSNP_SIGN, result.reply);
}

async function handleSignature(engine, reply) {
    if (!reply) return;
    const pending = [...engine.snapshotRounds.values()].find(candidate =>
        candidate.snapshotBlock === reply.snapshot_block &&
        candidate.cp.block_index === reply.block_index);
    if (!pending || pending.finishing) return;
    if (pending.round.add(reply) !== null) return;
    await advanceLeader(engine, pending);
}

async function advanceLeader(engine, pending) {
    if (pending.checking || pending.finishing ||
        engine.snapshotRounds.get(pending.id) !== pending) return;
    pending.checking = true;
    try {
        const stored = await engine.db.getSnapshotCheckpoint(
            pending.cp.chain, pending.cp.network, pending.cp.block_index);
        const decision = pending.round.decide({
            gateActive: engine.gateActive(pending.snapshotBlock),
            stored,
            nowMs: Date.now(),
        });
        if (decision.state === ROUND_STATE.PENDING) return;
        if (decision.state !== ROUND_STATE.FINALIZE) {
            closeRound(engine, pending);
            return;
        }

        const signed = Object.assign({}, pending.cp, {
            validator_signatures: decision.msg.signatures,
        });
        if (!snapshotCheckpointQuorum(signed, pending.validators, ValidatorIdentity.verify)) {
            closeRound(engine, pending);
            return;
        }
        pending.finishing = true;
        if (await persistFinalized(engine, decision.msg))
            engine.peerManager.broadcast(XSNP_FINALIZED, decision.msg);
        closeRound(engine, pending);
    } finally {
        pending.checking = false;
        if (pending.finishing) closeRound(engine, pending);
    }
}

function closeRound(engine, pending) {
    clearTimeout(pending.timer);
    if (engine.snapshotRounds.get(pending.id) === pending)
        engine.snapshotRounds.delete(pending.id);
}

async function persistFinalized(engine, message) {
    if (!message || !Number.isSafeInteger(message.snapshot_block) ||
        message.snapshot_block < 0 || !message.cp) return false;
    const expectedBlock = snapshotCheckpointBlock(message.snapshot_block, engine.network);
    const validators = await engine.resolveValidators(message.snapshot_block);
    const view = await buildSnapshotCosignView(message, {
        stateCheckpoints: engine.source,
        db: engine.db,
        network: engine.network,
        confirmations: engine.confirmations,
        gateActive: engine.gateActive(message.snapshot_block),
        expectedBlock,
    });
    const signed = engine.signedRecord.held(engine.network, message.cp.block_index);
    if (snapshotCosignRefusal(message, Object.assign({}, view, { signed })) !== null)
        return false;

    const accepted = acceptSnapshotFinalized(message, {
        network: engine.network,
        gateActive: view && view.gateActive,
        expectedBlock,
        trustSet: validators,
        verify: ValidatorIdentity.verify,
        stored: view && view.stored,
    });
    if (!accepted.row || engine.signedRecord.claim(message.cp) !== true) return false;
    const inserted = await engine.db.insertSnapshotCheckpoint(accepted.row);
    if (inserted) return true;
    const stored = await engine.db.getSnapshotCheckpoint(
        message.cp.chain, message.cp.network, message.cp.block_index);
    return samePayload(stored, message.cp);
}

function samePayload(stored, cp) {
    try {
        return snapshotCheckpointCanonical(stored) === snapshotCheckpointCanonical(cp);
    } catch (_) {
        return false;
    }
}

module.exports = { handleMessage, initialize, lead, persistFinalized, start, stop };
