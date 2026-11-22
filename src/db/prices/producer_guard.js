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
 * XChain Hub - the ON DUPLICATE KEY UPDATE guard the pushed and batch round
 * writers share, so a landing never replaces the signed anchor and proof of a
 * round this hub finalized itself.
 *
 * MariaDB applies the assignments left to right and a later expression reads the
 * value an earlier one already set. The producer test reads status, reference_chain,
 * source_chain, source_action_index, push_generation and consensus_proof, all of which
 * the same statement rewrites, so it is evaluated ONCE, first, into consensus_round
 * (1 for every other row, 2 while the statement holds a producer row), and every
 * guarded column then tests that flag. consensus_round is put back to 1 before the
 * status assignment, so no reader ever sees the 2. status is assigned last because
 * the disputed test must read the held status.
 *
 * The SQL test mirrors hasProducerProvenance in src/peers/hub_db/price_round_groups.js:
 * finalized or disputed, BTC reference, source_chain differing from reference_chain (NULL-safe,
 * because the producer insert leaves source_chain at its column default), no source
 * action, push generation absent or 0, and an array-shaped proof.
 *
 ********************************************************************/

const PRODUCER_TEST = `consensus_round = IF(status IN ('finalized', 'disputed') AND reference_chain = 'BTC' AND
                        NOT (source_chain <=> reference_chain) AND source_action_index IS NULL AND
                        (push_generation IS NULL OR push_generation = 0) AND consensus_proof LIKE '[%', 2, 1)`;

const keepProducer = column => `${column} = IF(consensus_round = 2, ${column}, VALUES(${column}))`;
const fillSkipped = column => `${column} = IF(status = 'skipped', VALUES(${column}), ${column})`;

// The ON DUPLICATE KEY UPDATE body. `landingClock` is the optional batch_block_time
// assignment, which keeps its own earliest-wins rule for producer rows too.
function upsertAssignments(landingClock) {
    const columns = ['price', 'reference_block', 'reference_chain', 'block_timestamp', 'validator_count',
        'consensus_proof', 'source_chain', 'source_action_index', 'push_generation'];
    const admits = ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];
    return [PRODUCER_TEST, ...columns.map(keepProducer), ...(landingClock ? [landingClock] : []),
        ...admits.map(keepProducer), 'consensus_round = 1',
        "status = IF(status = 'disputed', status, 'finalized')"].join(',\n                    ');
}

// A repair selected this key from an earlier presence read. Another writer may fill it
// before the INSERT runs, so every duplicate assignment must still inspect the held
// status. Status stays last so all preceding expressions see the pre-update value.
function skippedOnlyUpsertAssignments() {
    const columns = ['price', 'reference_block', 'reference_chain', 'block_timestamp', 'validator_count',
        'consensus_proof', 'source_chain', 'source_action_index', 'push_generation'];
    const admits = ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];
    return [...columns.map(fillSkipped), ...admits.map(fillSkipped),
        "consensus_round = IF(status = 'skipped', 1, consensus_round)",
        "status = IF(status = 'skipped', 'finalized', status)"].join(',\n                    ');
}

module.exports = { upsertAssignments, skippedOnlyUpsertAssignments, PRODUCER_TEST };
