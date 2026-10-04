'use strict';

const { registerCatchupVerifier } = require('../../peers/hub_db/catchup_verifiers.js');
const { catchupHub } = require('../../peers/hub_db/catchup_context.js');

function refusal(reason) {
    return { ok: false, reason };
}

function sameLocalPosition(row, request, mirror) {
    return mirror.intOrNull(row.request_block_index) === mirror.intOrNull(request.block_index) &&
        mirror.intOrNull(row.request_action_index) === mirror.intOrNull(request.action_index);
}

async function verifyAttestationResponseRow(row, context) {
    const hub = catchupHub(context);
    const mirror = hub && hub.attestationResponseMirror;
    if (!mirror) return refusal('attestation response verifier is unavailable');

    const shaped = mirror.parseGossipRow(row);
    if (!shaped) return refusal('malformed attestation response row');
    if (String(row.request_id) !== shaped.request_id || String(row.response_hash) !== shaped.response_hash) {
        return refusal('attestation response identifiers are not canonical lowercase hex');
    }

    const local = await mirror.resolveLocalRequest(shaped);
    if (!local || !local.request) return refusal('local attestation request is unavailable');
    const declaredBlock = Number(local.request.block_index);
    if (!mirror.isMirrorEra(declaredBlock)) return refusal('local attestation request is not in the response mirror era');
    if (!sameLocalPosition(row, local.request, mirror)) {
        return refusal('attestation response request position differs from local state');
    }

    const verdict = await mirror.verifyGossipedRow(shaped, local.request, local.latestBlock);
    if (!verdict || verdict.ok !== true) {
        return refusal(verdict && verdict.error ? verdict.error : 'response signatures did not verify');
    }
    return { ok: true };
}

registerCatchupVerifier('attestation_responses', verifyAttestationResponseRow);

module.exports = { verifyAttestationResponseRow, sameLocalPosition };
