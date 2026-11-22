'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const ValidatorIdentity = require('../../validators/identity.js');

// Producer messages carry one signature per known signer. Keep a generous fixed ceiling so a
// peer cannot turn the 32 MiB snapshot response bound into hundreds of thousands of synchronous
// ed25519 verifies. The current validator sets are far smaller, while this still permits signatures
// from known senders that were not price-qualified in the round's capability snapshot.
const MAX_PRODUCER_PROOF_ENTRIES = 1024;

// What a stored producer proof can be held to. The producer records every signature it collected, whether
// or not the signer was price-qualified at the round's block, sorted by pubkey, and records the number of
// PREPARE voters as validator_count, so neither equals the verified-signature set the way a pushed or
// batch round's does. Only the properties every honest producer row has are enforced here: a canonical
// array of {pubkey, sig} entries with lowercase pubkeys in strictly ascending order, every entry
// carrying a signature that verifies over the round's payload, and a validator_count from 1 up to the
// larger of the snapshot and proof sizes. The caller has already had verifyValidatedRound accept the
// round, which refuses any entry whose pubkey or sig is not well-formed hex.
//
// Pubkeys are lowercase because the producer keys its signature map on the lowercased wire key and its
// own key is lowercase hex. The count is at least 1 because a solo round records 1 and a federated round
// counts the proposer, whose PROPOSE is only taken from a proven key in the round's member set.

function inCanonicalOrder(proof) {
    for (let index = 0; index < proof.length; index++) {
        if (proof[index].pubkey !== proof[index].pubkey.toLowerCase()) return false;
        if (index > 0 && !(proof[index - 1].pubkey < proof[index].pubkey)) return false;
    }
    return true;
}

function alreadyVerified(verifiedSigs) {
    return new Set((verifiedSigs || []).map(sig => sig.pubkey + '|' + sig.sig));
}

// Returns a refusal reason, or null when the stored proof and count are what a producer writes.
function producerProofReason(row, proof, verified) {
    if (proof.length > MAX_PRODUCER_PROOF_ENTRIES) return 'stored round proof has too many entries';
    const canonical = JSON.stringify(proof.map(entry => ({ pubkey: entry.pubkey, sig: entry.sig })));
    if (canonical !== String(row.consensus_proof)) return 'stored round proof is not in canonical form';
    if (!inCanonicalOrder(proof)) return 'stored round proof is not in strict lowercase pubkey order';
    const known = alreadyVerified(verified.verifiedSigs);
    for (const entry of proof) {
        if (known.has(entry.pubkey.toLowerCase() + '|' + entry.sig.toLowerCase())) continue;
        if (!ValidatorIdentity.verify(verified.payload, entry.sig, entry.pubkey)) {
            return 'stored round proof carries an unverified signature';
        }
    }
    const count = String(row.validator_count);
    if (!/^[0-9]+$/.test(count) || !Number.isSafeInteger(Number(count))) {
        return 'stored round validator_count is not a whole number';
    }
    if (Number(count) < 1) return 'stored round validator_count is below the proposer floor';
    const snapshotSize = verified.snapshot && Array.isArray(verified.snapshot.validators)
        ? verified.snapshot.validators.length : 0;
    if (Number(count) > Math.max(snapshotSize, proof.length)) {
        return 'stored round validator_count exceeds the round signer bound';
    }
    return null;
}

module.exports = { producerProofReason, MAX_PRODUCER_PROOF_ENTRIES };
