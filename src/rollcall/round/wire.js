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
 * XChain Hub - ROLLCALL round: the canonical and the action wire
 *
 * What an epoch is published AS: the signed canonical, the v0 and v1 action
 * wires, and the size budget that decides how many pairs one action carries.
 *
 * The two instance methods go on RollcallRound.prototype and the three size
 * statics on the class itself, so every caller spells them as before.
 *
 ********************************************************************/

'use strict';

const { buildRollcallCanonical } = require('../rollcall_canonical.js');

// The one gossip type this engine adds. PeerManager.broadcast has no type
// registry, so a new type is this constant plus one `case` in handleMessage.
const XROLLCALL_SIGN = 'XROLLCALL_SIGN';
// How many not-yet-opened epochs' gossip a hub holds. One is the normal case
// (peers a poll ahead); a few more covers a hub catching up after a stall.
const EARLY_SIG_EPOCHS = 4;

// Wire chunking bound for a v0 roll call, from the frozen test vector's size
// budget: a 7-digit epoch header costs 152 bytes and each (PUBKEY, SIG) pair 194,
// against the protocol's 8189-byte action-data ceiling. A federation larger than
// this is rolled in several actions per epoch, which the union rule makes free.
const MAX_PAIRS_PER_ACTION = 41;
// The protocol's action-data ceiling and the exact cost of one (PUBKEY, SIG)
// pair on the wire: '|' + 64 hex + '|' + 128 hex. An action past the ceiling is
// DROPPED by the decoder with no error anywhere, so both numbers are asserted
// against the frozen vector's size_budget block by the canonical suite.
const ACTION_DATA_CEILING = 8189;
const BYTES_PER_PAIR      = 194;

// RollcallRound itself, bound by round.js as soon as the class is defined. The size
// statics and the publish path call each other through the class, the way the class
// body spells RollcallRound.maxPairsForGates(...), so a static reassigned on the class
// is the one every internal caller runs.
let RollcallRound = null;
function bindRoundClass(cls){ RollcallRound = cls; }
function roundClass(){ return RollcallRound; }

const methods = {

    // CONSENSUS-CRITICAL: must byte-match what xchain-indexer's actions/rollcall/index.js
    // rebuilds from the carried fields and what the BTC close rebuilds from its own
    // ledger_hash. Frozen by xchain-documentation/protocol/test-vectors/rollcall_canonical.json.
    //
    // The spelling itself lives in rollcall_canonical.js, called rather than
    // repeated: with two forms (v0, and v1 appending sha256(GATES)) three sites
    // rebuilding these bytes by hand is three places to drift, and a drift drops
    // real presence proofs and evicts live validators with nothing going red.
    // Omitting `gates` is the v0 form, byte-identical to what this method built
    // before v1 existed.
    canonical(epochHeight, ledgerHash, gates){
        return buildRollcallCanonical({ network: this.network, epochHeight, ledgerHash, gates });
    },

    // v0: ROLLCALL|0|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|SIG_COUNT|PUBKEY_1|SIG_1|...
    // v1: ROLLCALL|1|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|GATES|SIG_COUNT|PUBKEY_1|SIG_1|...
    //
    // The version is a function of `gates` alone, so the wire and the canonical
    // this hub signed cannot disagree about which form the epoch is.
    //
    // PUBLISHER carries no signature of its own; it is the key the publish reward
    // attaches to, and the chain pays only the ELECTED leader, so naming a key
    // here is a claim the close checks rather than a race anyone can win.
    buildWire(epochHeight, ledgerHash, publisher, pairs, gates){
        let v1    = (gates !== undefined && gates !== null);
        let parts = ['ROLLCALL', v1 ? '1' : '0', String(Number(epochHeight)),
                     String(ledgerHash).toLowerCase(), String(publisher).toLowerCase()];
        if(v1) parts.push(String(gates));
        parts.push(String(pairs.length));
        for(let p of pairs) parts.push(String(p.pubkey).toLowerCase(), String(p.sig).toLowerCase());
        return parts.join('|');
    }
};

// The v1 wire prefix ahead of the first pair, in bytes, measured from the REAL
// GATES string rather than remembered as a number: every '|' between header
// fields is counted here and the separator BEFORE each pair is counted in that
// pair's 194, so header + 194 * pairs is the exact payload size. A 7-digit
// epoch and a 2-digit SIG_COUNT are the widest fields any v1 action can carry
// (the cap below is under 100), which is the same basis the frozen vector
// measured v0's 152-byte header on.
function v1HeaderBytes(gates){
    return Buffer.byteLength(['ROLLCALL', '1', '1008000', 'a'.repeat(64), 'b'.repeat(64),
                              String(gates), '00'].join('|'), 'utf8');
}

// Pairs per action for an epoch publishing `gates`: floor((8189 - header) / 194).
//
// v0 keeps the frozen 41 (header 152). v1 is DERIVED, never hardcoded: GATES is
// knownGateKeys().join(',') and grows every time a gate is appended to
// SHARED_GATES, so a hardcoded cap would go stale silently and the first
// oversize action would be dropped by the decoder with nothing going red.
// Today that is 33 keys / 1790 bytes, header 1942, cap 32, re-derived after the bridge
// gate and this family's three entries both landed (D88 recorded 19 / 1076 / 1228 / 35).
// The cap really does move with the list, which is the point of deriving it: a v1 action
// now carries 32 pairs where it carried 35, and the ceiling is still far away.
//
// Zero means no pair fits at all, which a GATES list longer than the ceiling
// would produce; the publish path refuses rather than building an action the
// decoder would drop.
function maxPairsForGates(gates){
    if(gates === undefined || gates === null) return MAX_PAIRS_PER_ACTION;
    let cap = Math.floor((ACTION_DATA_CEILING - roundClass().v1HeaderBytes(gates)) / BYTES_PER_PAIR);
    return cap > 0 ? cap : 0;
}

// Split a pair list into per-action chunks. Any number of ROLLCALLs may land
// for one epoch and the present set is their UNION, so a split costs a second
// fee and nothing else.
function chunkPairs(pairs, max){
    let size = Number.isFinite(max) && max > 0 ? max : MAX_PAIRS_PER_ACTION;
    let out = [];
    for(let i = 0; i < pairs.length; i += size) out.push(pairs.slice(i, i + size));
    return out;
}

module.exports = {
    methods,
    statics: { v1HeaderBytes, maxPairsForGates, chunkPairs },
    bindRoundClass,
    roundClass,
    MAX_PAIRS_PER_ACTION,
    ACTION_DATA_CEILING,
    BYTES_PER_PAIR,
    XROLLCALL_SIGN
};
