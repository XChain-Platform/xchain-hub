/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

// Pins the XSNAPCKPT bytes and quorum rule the hub signs with, and holds the hub copy byte-identical
// to the indexer copy that verifies capability snapshot proofs: a one-sided edit makes the hub
// finalize checkpoints every indexer rejects.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const checkpoint = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const REPO_ROOT    = path.join(__dirname, '..', '..', '..', '..');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(REPO_ROOT, '..');
const INDEXER_DIR  = process.env.XCHAIN_INDEXER_DIR || path.join(SIBLING_ROOT, 'xchain-indexer');
const TWIN_PATH    = path.join('src', 'consensus', 'snapshot_checkpoint', 'canonical.js');

const pubkey = (digit) => String(digit).repeat(64);
const signature = (key) => key + key;
const base = {
    chain: 'BTC',
    network: 'testnet',
    block_index: 100,
    block_hash: 'A'.repeat(64),
    state_root: 'B'.repeat(64),
    state_root_version: 2,
};
const trustSet = [1, 2, 3, 4].map((digit) => ({ pubkey: pubkey(digit), weight: '1', source: 'source-' + digit }));
const EXPECTED_CANONICAL = `XSNAPCKPT|BTC|testnet|100|${'a'.repeat(64)}|${'b'.repeat(64)}|2`;

// Signs with a stand-in scheme that accepts only the literal canonical, so a reordered field fails quorum.
function verify(canonical, sig, key) {
    return canonical === EXPECTED_CANONICAL && sig === signature(key);
}

function signedBy(...digits) {
    return Object.assign({}, base, {
        validator_signatures: digits.map((digit) => ({ pubkey: pubkey(digit), sig: signature(pubkey(digit)) })),
    });
}

describe('snapshot checkpoint canonical twin', function () {
    it('hub copy writes the literal domain-separated canonical bytes and round id', function () {
        assert.strictEqual(checkpoint.SNAPSHOT_CHECKPOINT_TAG, 'XSNAPCKPT');
        assert.strictEqual(checkpoint.snapshotCheckpointCanonical(base), EXPECTED_CANONICAL);
        assert.strictEqual(checkpoint.snapshotCheckpointRoundId(base), 'SNAP|BTC|testnet|100');
    });

    it('hub copy finalizes only above two thirds of trusted, distinct, verified stake', function () {
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 2, 3), trustSet, verify), true);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 2), trustSet, verify), false);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 1, 2), trustSet, verify), false);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 2, 9), trustSet, verify), false);
        const asText = signedBy(1, 2, 3);
        asText.validator_signatures = JSON.stringify(asText.validator_signatures);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(asText, trustSet, verify), true);
    });

    it('hub copy is byte-identical to the indexer copy', function () {
        const twin = path.join(INDEXER_DIR, TWIN_PATH);
        if (!skipOrFail(this, siblingCheckout(__dirname, twin), 'the indexer snapshot checkpoint twin check')) return;
        assert.ok(fs.readFileSync(path.join(REPO_ROOT, TWIN_PATH)).equals(fs.readFileSync(twin)),
            'src/consensus/snapshot_checkpoint/canonical.js differs from the indexer copy; '
            + 'edit both copies together or the hub signs checkpoints the indexers reject.');
    });
});
