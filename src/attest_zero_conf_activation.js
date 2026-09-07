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
 * ATTEST zero-confirmation flip: serve a request the block it is mined in.
 *
 * WHAT FLIPS AT THIS HEIGHT. Three things, all keyed on the REQUEST's own BTC
 * block, and all under one height because each is consensus-adjacent:
 *
 *   A. The hub serves a request at the tip it was mined at instead of waiting
 *      ATTESTATION_CONFIRMATIONS blocks (AttestationRound.confirmationsFor).
 *      The effective count feeds the leader slot and the model index, which
 *      every hub in a round must agree on: two hubs that disagree elect
 *      different leaders, sign different effective_times and stall.
 *   B. The frozen widening ladder starts at the request block and draws one
 *      headroom slot at step 0 (ATTEST_RESPONSIBLE_WIDENING_V2). That shapes
 *      WHO MAY SIGN, which every indexer recomputes.
 *   C. The applier falls through an inert candidate row to the next one
 *      (utility.selectApplicableAttestationResponses). A new indexer binds a
 *      row an old one strands on, so identical inputs must give identical
 *      state on every node.
 *
 * A mixed fleet therefore agrees on every request below the height, and every
 * hub and indexer above it derives the same set, the same ladder and the same
 * binding. A hub on an older build above the height disagrees on the leader
 * slot for the first three blocks of a request, which is a liveness stall of
 * that round, never a fork.
 *
 * WHAT IT DOES NOT TOUCH. The responsible set is still resolved at the buried
 * snapshot block, CANONICAL_REORG_BUFFER blocks below the request, on both
 * sides. The three-block wait only ever protected the hub's own provider spend
 * against a reorged request, and that spend is an accepted cost of business
 * (operator ruling 2026-09-07). A re-mined request keeps its content-derived
 * request_id, so the finalized ring refuses a second round and the mirror row
 * re-binds at the new block.
 *
 * ORDERING, asserted at boot below. Wherever this map is non-null it must be
 * at or above BOTH ATTEST_RESPONSE_MIRROR_ACTIVATION and
 * ATTEST_RESPONSIBLE_WIDENING_ACTIVATION, and both must be non-null there. The
 * mirror half keeps a legacy-era round from running at 0 confirmations and
 * burning a BTC broadcast fee against a reorged request. The widening half is
 * what makes headroom exist at all: widenSlots returns 0 wherever the widening
 * map is null, so zero-conf armed alone would remove the wait and leave no
 * headroom behind it.
 *
 * MAINNET IS null, the inert sentinel: the legacy path runs byte for byte.
 * Testnet is operator-armed after the regtest milestone, floor 151324 (the
 * mirror height there), and sized after the INDEXER wave is confirmed complete,
 * not the hub wave: change C is indexer-only and keyed on the request block, so
 * an indexer still on the old build strands a request a new one binds. Regtest
 * is 0 so the e2e mirror venue exercises the flip from genesis.
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js
 * and the value twin of xchain-indexer/src/attest_zero_conf_activation.js; kept
 * value-identical by the activation-constants parity suite. A one-sided edit
 * forks the responsible set and the binding block at the flag day.
 *
 ********************************************************************/

'use strict';

// Per-network activation height (LOCAL COPY, parity-tested). Compared against
// the ATTEST v0 request's own BTC block_index.
const ATTEST_ZERO_CONF_ACTIVATION = {
    mainnet: null,        // INERT: operator-owned height, unratified. Ratified only after the mirror arms there.
    testnet: null,        // INERT until the operator sizes it; floor 151324 (ATTEST_RESPONSE_MIRROR_ACTIVATION.testnet), sized after the indexer wave.
    regtest: 0,           // ARMED at genesis so the e2e mirror venue exercises the flip
};

// Networks already reported by the guard in isZeroConfActive, so a per-request
// per-block path says it once rather than once per row.
const warnedUnknownNetworks = new Set();

// True when a request admitted at `requestBlock` is served at the tip, widened
// with headroom, and applied with fall-through.
//
// Returns false whenever the network is unratified or the height is unusable,
// which is the legacy path byte for byte. `null` is the UNRATIFIED sentinel and
// must read as "off": without the explicit null test `req >= null` coerces to
// `req >= 0` and arms the flip on every block of an unratified network, the
// inverse of what the sentinel means. A network with NO ENTRY is a
// misconfiguration rather than a posture, and is reported once.
function isZeroConfActive(requestBlock, network){
    let threshold = ATTEST_ZERO_CONF_ACTIVATION[network];
    if(threshold === undefined && !warnedUnknownNetworks.has(String(network))){
        warnedUnknownNetworks.add(String(network));
        console.warn('ATTEST zero-conf: no activation entry for network ' +
            JSON.stringify(String(network)) + ', so the flip is OFF for every request. ' +
            'Known networks: ' + Object.keys(ATTEST_ZERO_CONF_ACTIVATION).join(', ') + '.');
    }
    if(threshold === null || threshold === undefined) return false;
    let req = parseInt(requestBlock);
    if(!Number.isFinite(req)) return false;
    return req >= threshold;
}

// The boot-time ordering assertion (spec §3.2 a), on the CapabilitySnapshot
// _resolveReorgBuffer pattern: throw on a declared consensus network, warn on
// regtest and standalone, and a loud one-off bypass for a coordinated fleet-wide
// change. Called once from the AttestationRound constructor.
//
// Requires lazily: the widening module requires this one for the V2 switch, so a
// top-level require here would be a cycle.
function assertZeroConfOrdering(network){
    let net = String(network || '');
    let zc  = ATTEST_ZERO_CONF_ACTIVATION[net];
    if(zc === null || zc === undefined) return;   // unratified here: nothing to order
    let mirror   = require('./attest_response_mirror_activation.js').ATTEST_RESPONSE_MIRROR_ACTIVATION[net];
    let widening = require('./attest_responsible_widening_activation.js').ATTEST_RESPONSIBLE_WIDENING_ACTIVATION[net];
    let problem = null;
    if(mirror === null || mirror === undefined)
        problem = 'ATTEST_RESPONSE_MIRROR_ACTIVATION is unratified there, so a legacy-era round could run at 0 confirmations and burn its broadcast fee against a reorged request';
    else if(widening === null || widening === undefined)
        problem = 'ATTEST_RESPONSIBLE_WIDENING_ACTIVATION is unratified there, so widenSlots returns 0 and zero-conf would remove the wait with no headroom behind it';
    else if(zc < Math.max(mirror, widening))
        problem = 'it is below max(mirror ' + mirror + ', widening ' + widening + '), so a request between the heights would be served at the tip under rules that still expect the wait';
    if(problem === null) return;
    let detail = 'ATTEST_ZERO_CONF_ACTIVATION.' + net + ' is ' + zc + ' but ' + problem +
        '. Fix the map in both service copies and the documentation canon ' +
        '(XCHAIN_HUB_SKIP_ZERO_CONF_ASSERT=1 to bypass on a venue where every hub runs the SAME maps).';
    if(process.env.XCHAIN_HUB_SKIP_ZERO_CONF_ASSERT === '1'){
        console.warn('XCHAIN_HUB_SKIP_ZERO_CONF_ASSERT=1: skipping the zero-conf ordering assertion. ' + detail);
        return;
    }
    if(net === 'mainnet' || net === 'testnet'){
        let err = new Error('ATTEST zero-conf: ' + detail);
        err.code = 'ZERO_CONF_ORDERING';
        throw err;
    }
    console.warn('ATTEST zero-conf: ordering violation (non-strict on ' + (net || 'standalone') + '): ' + detail);
}

module.exports = {
    ATTEST_ZERO_CONF_ACTIVATION,
    isZeroConfActive,
    assertZeroConfOrdering
};
