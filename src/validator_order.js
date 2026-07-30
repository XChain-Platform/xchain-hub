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
 * XChain Platform: canonical validator-set ordering .
 *
 * Three hub engines elect a leader by indexing into their in-memory validator
 * set: Consensus (`validatorSet[(seq + view) % N]`), OracleConsensus and
 * Governance (`validatorSet[round % N]`). Membership alone does not fix that
 * index; ORDER does. Before this module, the order was whatever the loader
 * handed over, so cross-hub leader agreement rested on an unstated promise
 * that every hub's source emits identical ordering for identical membership.
 * Two hubs that disagree on the order elect different leaders for the same
 * (seq, view) and reject each other's legitimate proposals: a silent fork on
 * the config-PBFT rail and a liveness stall on the oracle/governance rails.
 *
 * Canonicalizing here makes the leader a function of the MEMBERSHIP rather
 * than of the query that produced it, which is the property the federation
 * actually needs. The sort key mirrors the one already used by
 * Governance._buildValidatorSnapshot and OracleConsensus._getLeader's
 * snapshot path : lowercased signing pubkey ascending.
 *
 * Consensus-breaking by construction (it moves the leader for any set a hub
 * previously held unsorted), so it ships inside the  pre-launch batch,
 * ungated, and is made safe by that batch's mandatory fleet-wide
 * wipe-and-replay rebase rather than by an activation height. Per the 
 * spec §2 and §4 the batch carries no activation constants and must not ride
 * on an existing one.
 *
 * CrossChainEngine and ReorgHandler also hold a validator set but only ever
 * read it as membership (Set/quorum), never by index, so they are
 * order-independent already and are left alone.
 *
 ********************************************************************/

// Total order over validators: lowercased signing pubkey ascending, then addr
// ascending. The addr tie-break matters because the registry may bind one
// signing key to several addrs (see OracleConsensus._addrForPubkey); leaning on
// Array.prototype.sort's stability instead would only preserve the incoming
// order, which is precisely the thing that is not canonical.
//
// Returns a NEW array: XChainHub._propagateValidatorSet hands the SAME array
// object to every engine, so sorting in place would mutate a caller's array and
// let one engine's canonicalization leak into another's input. A non-array
// input is passed through untouched so a caller's malformed value fails where
// it always failed, rather than being silently rewritten to [] here.
function canonicalValidatorOrder(validators) {
    if (!Array.isArray(validators)) return validators;
    return validators.slice().sort((a, b) => {
        let pa = (a && a.pubkey !== undefined && a.pubkey !== null) ? String(a.pubkey).toLowerCase() : '';
        let pb = (b && b.pubkey !== undefined && b.pubkey !== null) ? String(b.pubkey).toLowerCase() : '';
        if (pa < pb) return -1;
        if (pa > pb) return 1;
        let aa = (a && a.addr !== undefined && a.addr !== null) ? String(a.addr) : '';
        let ab = (b && b.addr !== undefined && b.addr !== null) ? String(b.addr) : '';
        if (aa < ab) return -1;
        if (aa > ab) return 1;
        return 0;
    });
}

module.exports = { canonicalValidatorOrder };
