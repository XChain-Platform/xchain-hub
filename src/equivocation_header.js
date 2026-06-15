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
 * XChain Hub — Equivocation Header (EQUIV_HEADER / WI-2 bump 2)
 *
 * The single, CONSENSUS-CRITICAL implementation of the uniform signed header that
 * every PBFT/consensus canonical is prefixed with at/above the activation flag-day:
 *
 *     EQUIV|<ENGINE_TAG>|<ROUND_ID>|<VIEW>||<CONTENT>
 *
 * Adding `<VIEW>` to the signed preimage is what makes equivocation provable WITHOUT
 * false-positiving honest view changes: a legitimate view change re-signs different
 * content for the same round but under a DIFFERENT view, so its header differs.
 * Equivocation is then exactly: same (engine, round, view), different content.
 *
 * Both `EQUIV_KEY` (= ENGINE_TAG|ROUND_ID|VIEW) and the canonical may contain `|`
 * (e.g. the checkpoint round id is `chain|network|block_index|checkpoint_seq`, and
 * every settlement canonical is pipe-joined). So consumers MUST NOT field-split the
 * canonical to recover the key — they match on the literal prefix
 * `EQUIV|<EQUIV_KEY>||` via startsWith (the `||` is the unambiguous key/content
 * boundary; `buildEquivCanonical` is the only producer).
 *
 * This is consensus-breaking (it changes the signed bytes), so it is gated on the
 * BTC-anchored snapshot_block + network — the hub and every indexer flip on the same
 * anchor. The indexer keeps a byte-equivalent copy in
 * xchain-indexer/src/equivocation_header.js; the cross-service regression suite
 * asserts the activation map matches the canonical in
 * xchain-documentation/protocol/constants.js (a divergence forks the chain).
 *
 ********************************************************************/

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js — kept equal by the cross-service
// regression suite). Keyed on the BTC-anchored snapshot_block, NOT each chain's
// local height, so the hub and all indexers flip on the same anchor.
const EQUIV_HEADER_ACTIVATION = {
    mainnet: 999999999,   // PLACEHOLDER — set the real BTC flag-day height before mainnet enable
    testnet: 0,
    regtest: 0,
};

// Fixed per-engine tag (spec §4.1.1). One slashable canonical family per engine.
const ENGINE_TAGS = {
    DEX:        'XDEX',
    XCALL:      'XCALL',
    ATTEST:     'XATTEST',
    ORACLE:     'XORACLE',
    CHECKPOINT: 'XCHECKPOINT',
    CONFIG:     'XCONFIG',
    NODEPROOF:  'XNODEPROOF',
};

// Whether the EQUIV header is in effect for a round/settlement whose BTC-anchored
// snapshot is at `snapshotBlock` on `network`. Below this → legacy headerless bytes.
function isEquivHeaderActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = EQUIV_HEADER_ACTIVATION[network];
    if(threshold === undefined) return false;   // unknown network → off (safe)
    return sb >= threshold;
}

// The opaque equivocation key: the header prefix both conflicting messages must
// share through <VIEW>. May contain `|`; treat as an opaque string.
function equivKey(engineTag, roundId, view){
    return String(engineTag) + '|' + String(roundId) + '|' + String(view);
}

// The literal prefix that a header-carrying canonical begins with for a given key.
// Consumers match via canonical.startsWith(equivPrefix(key)); the trailing `||` is
// the unambiguous key/content boundary.
function equivPrefix(key){
    return 'EQUIV|' + String(key) + '||';
}

// Prefix the uniform signed header onto an existing engine canonical. The result is
// what validators sign at/above the flag-day; below it, callers pass through the bare
// `content` unchanged (byte-for-byte regression-safe).
function buildEquivCanonical(engineTag, roundId, view, content){
    return equivPrefix(equivKey(engineTag, roundId, view)) + String(content);
}

module.exports = {
    EQUIV_HEADER_ACTIVATION,
    ENGINE_TAGS,
    isEquivHeaderActive,
    equivKey,
    equivPrefix,
    buildEquivCanonical,
};
