'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

function refusal(reason) {
    return { ok: false, reason: String(reason || 'row verification failed') };
}

function retryableRefusal(reason) {
    return Object.assign(refusal(reason), { retry: true });
}

function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function validatorLookupFailure(snapshotBlock, error) {
    return retryableRefusal('validator lookup failed for snapshot_block ' +
        Number(snapshotBlock) + ': ' + errorMessage(error));
}

module.exports = { refusal, validatorLookupFailure };
