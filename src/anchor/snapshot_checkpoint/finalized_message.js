'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { snapshotFinalizedRefusal } = require('./finalize_policy.js');
const { createSnapshotSignTally } = require('./sign_tally.js');
const { snapshotCheckpointRow } = require('./finalized_row.js');
const {
    snapshotCheckpointCanonical,
} = require('../../consensus/snapshot_checkpoint/canonical.js');

function buildSnapshotFinalized(snapshotBlock, cp, signatures) {
    if (!Number.isSafeInteger(snapshotBlock) || snapshotBlock < 0)
        throw new TypeError('snapshotBlock must be a non-negative safe integer');
    snapshotCheckpointCanonical(cp);
    if (!Array.isArray(signatures))
        throw new TypeError('signatures must be an array');

    return {
        snapshot_block: snapshotBlock,
        cp: {
            chain: cp.chain,
            network: cp.network,
            block_index: cp.block_index,
            block_hash: cp.block_hash,
            state_root: cp.state_root,
            state_root_version: cp.state_root_version,
        },
        signatures: signatures.slice(),
    };
}

function acceptSnapshotFinalized(msg, view) {
    try {
        const refusal = snapshotFinalizedRefusal(msg, view);
        if (refusal !== null) return { refusal, row: null };

        const tally = createSnapshotSignTally(
            msg.snapshot_block,
            msg.cp,
            view.trustSet,
            view.verify
        );
        for (const signature of msg.signatures) {
            tally.add(Object.assign({}, signature, {
                snapshot_block: msg.snapshot_block,
                block_index: msg.cp.block_index,
            }));
        }
        return { refusal: null, row: snapshotCheckpointRow(msg.cp, tally.signatures()) };
    } catch (e) {
        return { refusal: 'malformed', row: null };
    }
}

module.exports = { acceptSnapshotFinalized, buildSnapshotFinalized };
