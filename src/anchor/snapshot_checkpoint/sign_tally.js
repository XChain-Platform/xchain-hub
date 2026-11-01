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

const {
    snapshotCheckpointCanonical,
    snapshotCheckpointQuorum,
} = require('../../consensus/snapshot_checkpoint/canonical.js');
const { totalStake } = require('../../consensus/stake_weighted_quorum.js');

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_128 = /^[0-9a-f]{128}$/i;
const SIGN_TALLY_DROP = Object.freeze({
    MALFORMED: 'malformed',
    OTHER_ROUND: 'other_round',
    UNTRUSTED: 'untrusted',
    DUPLICATE: 'duplicate',
    BAD_SIGNATURE: 'bad_signature',
});

function trustedPubkeys(trustSet) {
    const trusted = new Set();
    if (!Array.isArray(trustSet)) return trusted;
    try {
        for (const entry of trustSet) {
            try {
                if (entry && typeof entry.pubkey === 'string' && HEX_64.test(entry.pubkey))
                    trusted.add(entry.pubkey.toLowerCase());
            } catch (e) {
                continue;
            }
        }
    } catch (e) {
        return trusted;
    }
    return trusted;
}

// Operator diagnostics only. Quorum decisions remain in the canonical
// stake-weighted predicate called by finalize_policy.
function snapshotSignTallyStatus(kept, trusted, trustSet, cp, verify) {
    const signerPubkeys = new Set(kept.map(row => row.pubkey));
    try {
        const signedValidators = (trustSet || []).filter(validator => validator &&
            signerPubkeys.has(String(validator.pubkey).toLowerCase()));
        return {
            signerCount: kept.length,
            validatorCount: trusted.size,
            stakeTally: totalStake(signedValidators).toString(),
            totalStake: totalStake(trustSet).toString(),
            quorumMet: snapshotCheckpointQuorum(Object.assign({}, cp, {
                validator_signatures: kept,
            }), trustSet, verify),
        };
    } catch (e) {
        return {
            signerCount: kept.length,
            validatorCount: trusted.size,
            stakeTally: null,
            totalStake: null,
            quorumMet: false,
        };
    }
}

function createSnapshotSignTally(snapshotBlock, cp, trustSet, verify) {
    const canonical = snapshotCheckpointCanonical(cp);
    const blockIndex = cp.block_index;
    const trusted = trustedPubkeys(trustSet);
    const seen = new Set();
    const kept = [];

    function add(reply) {
        let pubkeyValue;
        let sig;
        try {
            if (!reply) return SIGN_TALLY_DROP.MALFORMED;
            pubkeyValue = reply.pubkey;
            sig = reply.sig;
            if (typeof pubkeyValue !== 'string' || !HEX_64.test(pubkeyValue) ||
                typeof sig !== 'string' || !HEX_128.test(sig)) {
                return SIGN_TALLY_DROP.MALFORMED;
            }
        } catch (e) {
            return SIGN_TALLY_DROP.MALFORMED;
        }

        try {
            if (reply.snapshot_block !== snapshotBlock || reply.block_index !== blockIndex)
                return SIGN_TALLY_DROP.OTHER_ROUND;
        } catch (e) {
            return SIGN_TALLY_DROP.OTHER_ROUND;
        }

        const pubkey = pubkeyValue.toLowerCase();
        if (!trusted.has(pubkey)) return SIGN_TALLY_DROP.UNTRUSTED;
        if (seen.has(pubkey)) return SIGN_TALLY_DROP.DUPLICATE;
        try {
            if (typeof verify !== 'function' || verify(canonical, sig, pubkey) !== true)
                return SIGN_TALLY_DROP.BAD_SIGNATURE;
        } catch (e) {
            return SIGN_TALLY_DROP.BAD_SIGNATURE;
        }

        seen.add(pubkey);
        kept.push({ pubkey, sig });
        return null;
    }

    function signatures() {
        return kept.map((row) => ({ pubkey: row.pubkey, sig: row.sig }));
    }

    const status = () => snapshotSignTallyStatus(kept, trusted, trustSet, cp, verify);
    return { add, signatures, status };
}

module.exports = { SIGN_TALLY_DROP, createSnapshotSignTally };
