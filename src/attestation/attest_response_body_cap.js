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
 * The response body cap the ATTEST response mirror design enforces on BOTH
 * legs of consensus: the round leader before it proposes a body, and every
 * follower before it signs a PREPARE/COMMIT for one (spec §5.3, decisions
 * D40/D41, row 9).
 *
 * WHY 8189. It is relay-leg parity, not a fresh number: v3/v4 already carry a
 * response body on chain at the encoder's 8189-byte wire ceiling
 * (AttestationRelay.js:138, 816-818), so a mirror-era body above it would
 * finalize a row the batch (§6) could never relay onto that same wire. The
 * hub's ONLY prior check for this number is a post-finalization drop in the
 * publisher that measures the ASSEMBLED WIRE (signatures included), not the
 * body (AttestationPublisher.js:319-324): today a body sitting exactly at
 * 8189 already finalizes and then dies once signatures are appended, and
 * nothing before that point ever looked at the body alone.
 *
 * WHY BOTH LEADER AND FOLLOWER, NOT JUST ONE. A leader-only gate stops an
 * honest leader from proposing an oversize body, but a Byzantine responsible
 * peer can still PROPOSE, or PREPARE-announce, one directly; without a
 * follower-side check an honest follower would sign it anyway and the round
 * would finalize a row this hub's own AttestationPublisher then drops,
 * burning the round for nothing. Both checks run the identical predicate
 * below so neither can silently drift from the other.
 *
 * WHY NOT A NEW PER-PROVIDER CONSTANT. Per-provider response caps already
 * exist and already sit below 8189 in practice (http_get 32768 bytes / llm
 * 16384 bytes of `max_response_bytes` in ProviderRegistry.js:33-51 bound the
 * fetch itself, and the PBFT proposal-size gate derived from them,
 * AttestationConsensus.js:644-665, is `ceil(maxBytes * 1.4)` base64 of that),
 * so a per-provider body cap is already a governance-syncable provider field
 * and needs no new constant here (inventory D41). This module's constant is
 * the protocol-wide RELAY ceiling, a separate and lower concern than any one
 * provider's fetch budget.
 *
 ********************************************************************/

'use strict';

// Decoded UTF-8 bytes of response body a mirror-era ATTEST response may
// carry. FROZEN PROTOCOL CONSTANT: like ATTEST_RESPONSE_FORWARD_S, it is not
// read off the wire, it is the expectation every hub recomputes locally, so
// two hubs holding two values would not disagree about one row, they would
// refuse each other's rounds (a proposer over one hub's cap but under
// another's is accepted by the loose hub and never counted by the strict
// one, stalling that hub's own quorum). Applies in BOTH the legacy and
// mirror canonical eras: the relay-parity reason it exists does not depend
// on which canonical shape signed the body.
const ATTEST_RESPONSE_BODY_MAX_BYTES = 8189;

// Byte length of `body` as UTF-8, not its character count. A Buffer (the
// shape every body takes once decoded off `body_b64` in this engine) is
// already exact and is returned as-is; a string is measured with
// Buffer.byteLength so a caller (or a test) handing this a JS string with
// multi-byte characters gets the wire size, not String#length.
function bodyByteLength(body){
    if(Buffer.isBuffer(body)) return body.length;
    return Buffer.byteLength(body == null ? '' : String(body), 'utf8');
}

// True when `body` decodes to at or under the cap. A predicate, not a
// throwing assertion, despite the name the spec's build row suggested it
// under: every call site here has its own reject-and-log shape (a PROPOSE is
// dropped, a proposal round declines to open), and a throw would turn a
// single oversize body into an unhandled-rejection crash of the whole hub
// process rather than a refused round.
function assertBodyWithinCap(body){
    return bodyByteLength(body) <= ATTEST_RESPONSE_BODY_MAX_BYTES;
}

module.exports = Object.freeze({
    ATTEST_RESPONSE_BODY_MAX_BYTES,
    bodyByteLength,
    assertBodyWithinCap
});
