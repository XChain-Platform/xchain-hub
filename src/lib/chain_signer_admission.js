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
 * XChain Hub - Vote admission keyed on the proven signing key
 *
 * THE single definition of "may this message be counted toward quorum".
 *
 * Quorum N is derived from CHAIN state (CapabilitySnapshot), so a validator
 * that stakes on chain immediately raises the agreement threshold on every hub
 * in the federation. Admission therefore has to follow the chain too, or every
 * honest joiner lands in the DENOMINATOR without ever reaching the NUMERATOR
 * and the federation gets harder to agree in the more adoption succeeds. That
 * was the defect this module closes.
 *
 * It admits on the SIGNING KEY, never on the sender address, and that choice is
 * the whole security argument:
 *
 *   - The chain attributes KEYS. A STAKE action carries SOURCE and
 *     SIGNING_PUBKEY; there is no P2P address anywhere in chain state, so an
 *     address simply cannot be checked against the chain. The signer set the
 *     hub already maintains for transport auth is a set of pubkeys.
 *   - The key is PROVEN, not claimed. PeerManager stamps `sig_pubkey` on every
 *     outgoing envelope and verifies the ed25519 signature over the envelope
 *     with it before any handler runs, so by the time a tally sees the
 *     envelope, the holder of that key demonstrably signed this exact message.
 *   - Counting keys instead of addresses CLOSES count-mode quorum forgery
 *     rather than merely containing it. Addresses are self-asserted wire
 *     fields, so one authorized key could sign N envelopes naming N different
 *     senders and inflate an address-keyed tally to a full forged quorum.
 *     Deduped by key, those same N envelopes collapse to one vote.
 *
 * This is the same union transport already applies (PeerManager._verifySignature:
 * a key in the chain-effective set OR in the registry's pubkey set), which is
 * what makes the permissionless promise true: staking on chain is sufficient to
 * be counted, with no operator having to hand-register the joiner first.
 *
 * The local registry is retained as the OTHER arm of the union, not as a
 * gatekeeper in front of it. It still carries hubs that are legitimately not in
 * chain state (a genuine pre-bootstrap federation, or a hub the operator
 * registered directly), and it remains the authorization floor whenever the
 * chain-effective set cannot be refreshed.
 *
 * Two fail-closed rules are load-bearing and must not be relaxed:
 *
 *   1. An envelope with no `sig_pubkey` is never counted. Without a proven key
 *      there is nothing the chain can attribute, and the sender field alone is
 *      forgeable. This is unconditional: there is deliberately no activation
 *      gate and no lenient legacy path, because a gate protects the replay of a
 *      chain that already exists and neither network has one (mainnet has no
 *      chain, testnet was re-genesised empty). A peer whose build does not
 *      stamp the field is deployed forward, not accommodated here.
 *   2. The empty-registry leniency covers the genuine pre-bootstrap window
 *      ONLY. Once a chain-effective signer set exists, an empty registry means
 *      a misconfiguration or a wipe window rather than bootstrap, and counting
 *      unattributable senders there would reopen the forgery above. A sender is
 *      admissible because the CHAIN attributes it, never because the registry
 *      happens to be empty.
 *
 **********************************************************************/

// Lowercased proven signing key of an authenticated envelope, or null when the
// envelope carries none. PeerManager verified the envelope's signature against
// this exact value, so it is an identity rather than a claim.
function provenPubkey(envelope) {
    if (!envelope) return null;
    let pk = envelope.sig_pubkey;
    if (!pk || typeof pk !== 'string') return null;
    return pk.toLowerCase();
}

// True iff the validator registry binds some addr to this pubkey. The registry
// is Map<addr, pubkeyHex> and is consulted here as an addr-independent pubkey
// SET, so a key rotated under a new addr is admitted as soon as the registry
// carries it. Mirrors PeerManager._registryHasPubkey.
function registryHasPubkey(registry, pubkeyHexLower) {
    if (!registry || typeof registry.values !== 'function') return false;
    for (let v of registry.values()) {
        if (v && String(v).toLowerCase() === pubkeyHexLower) return true;
    }
    return false;
}

// Whether an authenticated envelope may be counted toward quorum. See the
// header for why this keys on the signing key and never on envelope.sender.
function isAdmissibleSigner(peerManager, envelope) {
    let registry = peerManager && peerManager.validatorPubkeys;
    // Null registry fails closed: with no registry loaded the hub cannot
    // authenticate anyone, and the chain arm alone must not stand in for a hub
    // that failed to load its own authorization floor.
    if (!registry) return false;

    let pk = provenPubkey(envelope);
    // No proven key, nothing to attribute (rule 1 above). Fail closed.
    if (!pk) return false;

    // The CHAIN attributes this key: admissible regardless of the registry.
    // This arm is the fix; it is what lets a community validator that staked on
    // chain be counted without any operator action on any other hub.
    let chainSet = peerManager.effectiveSignerSet;
    if (chainSet && chainSet.has(pk)) return true;

    // The local registry attributes this key.
    if (registryHasPubkey(registry, pk)) return true;

    // Neither attributes it. An empty registry is lenient ONLY while no
    // chain-effective set exists (rule 2 above); once one does, fail closed.
    if (registry.size === 0) return !(chainSet && chainSet.size > 0);
    return false;
}

module.exports = { isAdmissibleSigner, provenPubkey, registryHasPubkey };
