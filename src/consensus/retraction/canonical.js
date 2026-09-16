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
 * XChain Hub - Retraction Consensus: canonical and intent key
 *
 * The two pure spellings a round is keyed on. Pure functions rather than
 * methods: both parts and the class's own statics call them, and neither reads
 * any instance state.
 *
 ********************************************************************/

'use strict';

// The signed canonical. MUST byte-match the consumer rebuild in
// hub_db_sync.js (xchain-indexer + xchain-explorer vendored copy).
function canonicalRetraction(evt){
    let to  = (evt.to_action_index       !== undefined && evt.to_action_index       !== null) ? String(evt.to_action_index)       : '';
    let gen = (evt.retraction_generation !== undefined && evt.retraction_generation !== null) ? String(evt.retraction_generation) : '';
    return 'XRETRACTV1|' + String(evt.table) + '|' + String(evt.source_chain) + '|' +
           String(evt.from_action_index) + '|' + to + '|' + gen + '|' + String(evt.snapshot_block);
}

// Intent identity for follower matching: what an independent honest indexer
// of the same chain derives from the same reorg. Deliberately EXCLUDES the
// generation (instance-local counter) and snapshot_block (leader-resolved).
function intentKey(evt){
    let to = (evt.to_action_index !== undefined && evt.to_action_index !== null) ? String(evt.to_action_index) : '';
    return String(evt.table) + '|' + String(evt.source_chain) + '|' + String(evt.from_action_index) + '|' + to;
}

// RetractionConsensus itself, bound by retraction.js as soon as the class is
// defined. The parts call the two statics through the class, spelled
// RetractionConsensus.canonicalRetraction(...) at every call, so a static
// reassigned on the class is the one every signing path runs.
let RetractionConsensus = null;
function bindRetractionClass(cls){ RetractionConsensus = cls; }
function retractionClass(){ return RetractionConsensus; }

module.exports = { canonicalRetraction, intentKey, bindRetractionClass, retractionClass };
