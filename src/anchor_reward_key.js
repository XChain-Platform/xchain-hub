/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The validator_rewards ledger key's ROUND QUALIFIER (hub copy).
 *
 * VENDORED TWIN of xchain-indexer/src/anchor_reward_key.js. The executable region
 * (from the strict-mode pragma down) is byte-identical and held so by
 * test/unit/anchorRewardKeyTwinParity.test.js; only this header differs, because each
 * side names its OWN call sites. Change the rule in the indexer copy and mirror it here
 * in the same change: the qualifier decides which two archive rewards are the same row,
 * so a divergence lets the hub conserve a reward the indexer pays, or refuse to co-sign
 * an archive the indexer derives.
 *
 * The hub reads it at the three sites that key on the reduced identity: the cross-pubkey
 * dedup guard (RewardTracker.recordAnchorReward), the follower co-sign cross-check
 * (StateAnchorPublisher._verifyArchiveAgainstLocal) and the archive batch_seq stamp.
 *
 ********************************************************************/

'use strict';

// The one reward type whose round_reference is a reissuable counter rather than a height.
const ARCHIVE_REWARD_TYPE = 'anchor_archive';

// The ledger-key qualifier for a reward of `rewardType` earned at `snapshotBlock`.
// Non-archive -> 0, always, so those keys are exactly what they were pre-column.
// A non-finite/negative snapshot block also yields 0 (the legacy value): the two writers
// both validate the height before this point (anchor.js regex-checks SNAPSHOT_BLOCK at
// parse, the derive path reads a BIGINT UNSIGNED column), so this is a fail-to-legacy
// floor, not a live path.
function rewardRoundQualifier(rewardType, snapshotBlock){
    if(String(rewardType) !== ARCHIVE_REWARD_TYPE) return 0;
    let sb = Number(snapshotBlock);
    return (Number.isFinite(sb) && sb >= 0) ? Math.floor(sb) : 0;
}

// The SQL twin of rewardRoundQualifier, for predicates that must compute the qualifier a
// row WOULD carry from an attestation row's own columns. Emitted from the same constant as
// the JS form, so the two cannot disagree about which reward type is qualified.
// `typeCol` / `snapshotCol` are caller-supplied column references (never user input).
function sqlRoundQualifier(typeCol, snapshotCol){
    return "CASE WHEN " + typeCol + " = '" + ARCHIVE_REWARD_TYPE + "'" +
           " THEN " + snapshotCol + " ELSE 0 END";
}

module.exports = { ARCHIVE_REWARD_TYPE, rewardRoundQualifier, sqlRoundQualifier };
