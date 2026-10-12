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
 * XChain Hub - state checkpoint scrape series.
 *
 **********************************************************************/

'use strict';

const { installEngineSeries } = require('./hub_metrics_engine_series');

// One process-lifetime StateCheckpointEngine count as a counter.
function countSpec(name, help, field){
    return { name, help, read: (engine) => engine[field] };
}

// Quorum loss, equivocation and cadence stalls, read off the engine's own fields.
const CHECKPOINT_SERIES = {
    counters: [
        countSpec('xchain_checkpoint_round_timeouts_total',
            'Checkpoint rounds this hub led that timed out below quorum', '_roundTimeouts'),
        countSpec('xchain_checkpoint_sub_quorum_finalized_total',
            'FINALIZED checkpoint broadcasts dropped by this hub as a follower for carrying too few signatures',
            '_subQuorumFinalized'),
        countSpec('xchain_checkpoint_malformed_finalized_total',
            'FINALIZED checkpoint broadcasts dropped by this hub as malformed', '_malformedFinalized'),
        countSpec('xchain_checkpoint_seq_conflicts_total',
            'Quorum-signed checkpoints refused because a different payload already holds that sequence',
            '_seqConflicts'),
        countSpec('xchain_checkpoint_seq_double_sign_refusals_total',
            'Signature requests refused because this hub already signed a different payload at that sequence',
            '_seqDoubleSignRefusals'),
        countSpec('xchain_checkpoint_cadence_stalls_total',
            'Checkpoint cadence ticks that were due but this hub could not lead', '_cadenceStalls')
    ],
    gauges: [
        {
            name: 'xchain_checkpoint_cadence_stalled',
            help: '1 while the checkpoint cadence is stalled with a named reason, 0 once a round clears it',
            read: (engine) => (engine._cadenceStallReason !== undefined ? engine._cadenceStallReason !== null : null)
        },
        {
            name: 'xchain_checkpoint_observer_idle',
            help: '1 when this hub sits outside the checkpoint signer set and deliberately opens no round',
            read: (engine) => engine._observerIdle
        },
        {
            name: 'xchain_checkpoint_frozen_tip_ticks',
            help: 'Consecutive not-my-slot checkpoint ticks that saw the same BTC block; climbing means the tip is frozen',
            read: (engine) => engine._notMySlotTicks
        },
        {
            name: 'xchain_checkpoint_frozen_tip_stall_ticks',
            help: 'Frozen-tip tick count at which a not-my-slot tick is metered as a cadence stall',
            read: (engine) => engine._frozenTipTicks
        }
    ]
};

/**
 * Register the state checkpoint scrape series on an installed registry.
 *
 * Checkpoint quorum loss, equivocation and a stalled cadence were visible only
 * through getcheckpointstats. These read the engine's in-memory fields and
 * never call its getStats(), which is async and reads the database.
 *
 * @param {{registry: ?object}} observability  installObservability() handle.
 * @param {{stateCheckpoints: ?object}} hub  resolved lazily at scrape time,
 *        since the engine starts after the API installs metrics.
 * @returns {boolean} true when the metrics were registered.
 */
function installHubCheckpointMetrics(observability, hub){
    const registry = observability && observability.registry;
    if(!registry || !hub) return false;
    installEngineSeries(registry, () => hub.stateCheckpoints, CHECKPOINT_SERIES);
    return true;
}

module.exports = { installHubCheckpointMetrics, CHECKPOINT_SERIES };
