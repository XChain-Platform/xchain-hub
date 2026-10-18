'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    buildSnapshotSignReply,
    snapshotSignRequestRefusal,
} = require('./sign_request.js');
const { snapshotCosignRefusal } = require('./cosign_policy.js');

function refused(reason) {
    return { refusal: reason, reply: null };
}

function canSign(identity) {
    return Boolean(identity) &&
        typeof identity.sign === 'function' &&
        typeof identity.getPubkeyHex === 'function';
}

function answerSnapshotSignRequest(req, ctx) {
    try {
        if(ctx === null || typeof ctx !== 'object' ||
            ctx.record === null || typeof ctx.record !== 'object' ||
            typeof ctx.record.claim !== 'function' ||
            typeof ctx.record.held !== 'function') {
            return refused('malformed');
        }

        const requestRefusal = snapshotSignRequestRefusal(
            req, ctx.validators, ctx.verify
        );
        if(requestRefusal !== null) return refused(requestRefusal);

        const view = ctx.view;
        const signed = ctx.record.held(view.network, req.cp.block_index);
        const cosignRefusal = snapshotCosignRefusal(
            req, Object.assign({}, view, { signed })
        );
        if(cosignRefusal !== null) return refused(cosignRefusal);

        if(!canSign(ctx.identity)) return refused('malformed');
        if(ctx.record.claim(req.cp) !== true) return refused('conflicting_payload');

        return {
            refusal: null,
            reply: buildSnapshotSignReply(ctx.identity, req.snapshot_block, req.cp),
        };
    } catch(e) {
        return refused('malformed');
    }
}

module.exports = { answerSnapshotSignRequest };
