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
 * ATTEST leader-rotation silent-slot skip (framework spec §8.2 liveness ladder).
 *
 * WHAT FLIPS AT THIS HEIGHT. One thing: whether AttestationRound's leader
 * rotation is allowed to step OVER a responsible slot it has proven silent
 * (attestation_escalation.effectiveLeaderSlot) or must stop on it exactly as the
 * bare spec §8.2 ladder does (attestation_escalation.leaderIndex). Below the
 * height the round consults no silent set, arms no watch and emits no skip
 * warning, so its leader is byte for byte the pre-skip slot. At or above it the
 * skip runs.
 *
 * WHY IT NEEDS A GATE AT ALL, given that leadership is not indexer-validated.
 * Two hubs on different builds elect DIFFERENT leaders for the same request the
 * moment one of them can skip and the other cannot. A round whose members
 * disagree about the leader has no leader proposal to take its canonical
 * effective_time from, every hub stamps its own wall clock instead, no two
 * PREPAREs share a canonical and the round times out for the rest of the
 * request's life. That is a liveness split rather than a ledger fork, but it is
 * exactly the stall the skip was written to end, and a roll wave that lasts
 * hours would reintroduce it on every request admitted mid-wave. Under one
 * height the whole fleet changes leader arithmetic on the same request, whatever
 * order the binaries land in.
 *
 * The second reason is that the un-gated skip's safety rests on an assumption
 * about who is on the wire: a member is judged silent from THIS hub's local
 * observation of PROPOSE traffic. Two honest hubs converge on the same set only
 * because a key that sends nothing sends nothing to everyone. Community
 * validators whose keys go dark and then return, or a partition that mutes one
 * peer for one hub only, break that symmetry, and the gate is what lets the
 * fleet be moved onto and off the new arithmetic deliberately rather than as a
 * side effect of who upgraded first.
 *
 * ACTIVATION PLANE: the REQUEST's own block_index, never the poll tip. It is the
 * same anchor ATTEST_RESPONSIBLE_WIDENING_ACTIVATION and ATTEST_ZERO_CONF_ACTIVATION
 * key on, so a request is admitted under one leader-arithmetic rule for its whole
 * life and every hub that ever polls it reaches the same verdict about which rule
 * applies. Keying on the poll tip instead would flip the rule under a live request
 * mid-window, which is the one shape a leader gate must not have: the hubs that
 * polled before the flip and the hubs that polled after would elect different
 * slots for the same round. Evaluated on BTC heights, like the ladder itself.
 *
 * HEIGHTS.
 *
 *   testnet 152400. TBTC tip was 151794 measured today at 15:08Z, and TBTC blocks
 *   run about 20 minutes each, i.e. 3 per hour and 72 per day. 152400 - 151794 =
 *   606 blocks, so roughly 202 hours or about 8.4 days out. Sized against two
 *   things and neither is a wall-clock date: it is past the next hub train's roll
 *   wave, so no request can be admitted above the height while half the fleet
 *   still runs the pre-skip ladder, and it is 192 blocks (about 64 hours) above
 *   the ROLLCALL close at 152208, so the rules-aware capability set for a request
 *   at the height is drawn from calls rolled under the new arithmetic rather than
 *   from a window straddling it.
 *
 *   mainnet null, the UNRATIFIED sentinel: the pre-skip ladder runs byte for
 *   byte. Mainnet hub writes are held, so there is no wave to coordinate and
 *   nothing to arm against; the height is ratified in the same operator ruling
 *   that lifts the hold.
 *
 *   regtest 0, so the e2e venue exercises the skip from genesis.
 *
 * HUB-ONLY, AND DELIBERATELY NOT VENDORED. Leadership decides which hub runs
 * agree() and broadcasts first; it never decides who may SIGN, which is the only
 * attestation property an indexer recomputes (that one is gated by
 * attest_responsible_widening_activation.js and IS a twin). So there is no
 * indexer copy to keep value-identical, and this map is not a member of
 * consensus_rules_digest.js's SHARED_GATES, which is the hub/indexer
 * INTERSECTION: a hub-only entry there would report ABSENT on every indexer and
 * turn a correct build into a permanent rules mismatch, and would also lengthen
 * the ROLLCALL v1 GATES field, dropping every validator whose last rolled call
 * predates it. xchain_price_activation.js is the standing precedent for a
 * hub-only gate that stays out of the digest for the same reason.
 *
 ********************************************************************/

'use strict';

// Per-network activation height. Compared against the ATTEST v0 request's own BTC
// block_index. See the header for how each value was sized.
const ATTEST_LEADER_SILENCE_SKIP_ACTIVATION = {
    mainnet: null,        // INERT: operator-owned height, unratified while mainnet hub writes are held
    testnet: 152400,      // SIZED 2026-09-10: tip 151794 at 15:08Z at about 20 min/block, so about 8.4 days out, past the next hub roll wave and 192 blocks above the 152208 ROLLCALL close
    regtest: 0,           // ARMED at genesis so the e2e venue exercises the skip
};

// Networks already reported by the guard below, so a per-request per-poll path
// says it once rather than once per round.
const warnedUnknownNetworks = new Set();

// True when a request admitted at `blockIndex` runs the silent-slot skip. False is
// the pre-skip spec §8.2 ladder, byte for byte.
//
// `null` is the UNRATIFIED sentinel and must read as "off": without the explicit
// null test `blk >= null` coerces to `blk >= 0` and arms the skip on every block of
// an unratified network, the inverse of what the sentinel means. A network with NO
// ENTRY is a misconfiguration rather than a posture, and is reported once.
function isLeaderSilenceSkipActive(blockIndex, network){
    let threshold = ATTEST_LEADER_SILENCE_SKIP_ACTIVATION[network];
    if(threshold === undefined && !warnedUnknownNetworks.has(String(network))){
        warnedUnknownNetworks.add(String(network));
        console.warn('ATTEST leader-silence skip: no activation entry for network ' +
            JSON.stringify(String(network)) + ', so the skip is OFF for every request. ' +
            'Known networks: ' + Object.keys(ATTEST_LEADER_SILENCE_SKIP_ACTIVATION).join(', ') + '.');
    }
    if(threshold === null || threshold === undefined) return false;
    let blk = parseInt(blockIndex);
    if(!Number.isFinite(blk)) return false;
    return blk >= threshold;
}

module.exports = {
    ATTEST_LEADER_SILENCE_SKIP_ACTIVATION,
    isLeaderSilenceSkipActive
};
