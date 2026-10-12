/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * XChain Hub - the ATTEST response mirror era predicate, written once.
 *
 * Three hub paths ask the same question of a finalized request: is its response
 * served by the mirror or by an on-chain ATTEST v1? AttestationPublisher's early
 * return, AttestationResponseMirror's era gate, and AttestationConsensus's
 * effective_time rule all call this one function, so they cannot disagree. A
 * disagreement would deliver a response twice or not at all, or let consensus
 * sign a canonical for one era while delivery serves the other.
 *
 ********************************************************************/

'use strict';

// The mirror flag day is a registry row read by literal key, never a local copy of its heights.
const gateRegistry = require('../consensus/gate_registry');
const ATTEST_RESPONSE_MIRROR_KEY = 'attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION';

// Answer whether a request admitted at `requestBlock` rides the mirror, keyed on the REQUEST's
// own BTC block (never the response's, never the tip) so its era is fixed at admission.
// Read through the module object at call time, so a test stub on activeAt still applies.
function isMirrorEraRequest(network, requestBlock){
    return gateRegistry.activeAt(ATTEST_RESPONSE_MIRROR_KEY, network, null, requestBlock, null);
}

module.exports = { ATTEST_RESPONSE_MIRROR_KEY, isMirrorEraRequest };
