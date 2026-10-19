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

const { snapshotCheckpointCanonical } = require('../../consensus/snapshot_checkpoint/canonical.js');

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_128 = /^[0-9a-f]{128}$/i;

function normalizedSignatures(signatures) {
    if (!Array.isArray(signatures))
        throw new TypeError('snapshot checkpoint signatures must be an array');

    const byPubkey = new Map();
    for (const entry of signatures) {
        let pubkey;
        let sig;
        try {
            pubkey = entry && entry.pubkey;
            sig = entry && entry.sig;
        } catch (e) {
            continue;
        }
        if (typeof pubkey !== 'string' || typeof sig !== 'string' ||
            !HEX_64.test(pubkey) || !HEX_128.test(sig)) continue;

        pubkey = pubkey.toLowerCase();
        if (!byPubkey.has(pubkey)) byPubkey.set(pubkey, sig.toLowerCase());
    }

    if (byPubkey.size === 0)
        throw new TypeError('snapshot checkpoint requires a well-formed signature');

    return Array.from(byPubkey, ([pubkey, sig]) => ({ pubkey, sig }))
        .sort((left, right) => {
            if (left.pubkey < right.pubkey) return -1;
            if (left.pubkey > right.pubkey) return 1;
            return 0;
        });
}

function snapshotCheckpointRow(cp, signatures) {
    snapshotCheckpointCanonical(cp);

    const stateRootVersion = Number(cp.state_root_version);
    if (!Number.isSafeInteger(stateRootVersion) || stateRootVersion < 0)
        throw new TypeError('snapshot checkpoint state_root_version must be a non-negative safe integer');

    const rows = normalizedSignatures(signatures);
    return {
        chain: cp.chain,
        network: cp.network,
        block_index: cp.block_index,
        block_hash: cp.block_hash.toLowerCase(),
        state_root: cp.state_root.toLowerCase(),
        state_root_version: stateRootVersion,
        validator_signatures: JSON.stringify(rows),
    };
}

module.exports = { snapshotCheckpointRow };
