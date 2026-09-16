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
 * XChain Hub - CapabilitySnapshot fetch guards
 *
 * The checks every federation read passes before its answer may become a
 * snapshot: failure classification, the MALFORMED shape test and the two echo
 * guards. src/validators/capability_snapshot.js installs every method below on
 * CapabilitySnapshot.prototype, so callers keep writing snapshot.<method>().
 *
 ********************************************************************/

const { REASONS, classifyFetchError } = require('../consensus_input_monitor.js');

// A weight is a plain decimal string, exactly as stake_weighted_quorum.bcnum
// accepts one. Kept identical to that predicate's own pattern so a row this
// class admits can never be one the predicate then fails closed on.
const NUMERIC_WEIGHT = /^[+-]?(\d+\.?\d*|\.\d+)$/;

module.exports = {

    // Classify a federation-read failure and return null (the fetch helpers'
    // "indexer unavailable" sentinel). A 401/403 is NOT "indexer down": it means
    // the hub's x-api-key (BTC_INDEXER_API_KEY) does not match the indexer's
    // INDEXER_API_KEY. Swallowed silently (as every catch did), that misconfig is
    // indistinguishable from a dead indexer or an empty validator set, so every
    // attestation round and config-change quorum collapses to a null snapshot
    // while nothing points the operator at auth. Surface it distinctly, throttled.
    onFetchError(method, err) {
        let reason = classifyFetchError(err);
        let detail;
        if (reason === REASONS.AUTH) {
            detail = 'HTTP ' + err.response.status + ': the hub\'s x-api-key (BTC_INDEXER_API_KEY) does not ' +
                'match the indexer\'s INDEXER_API_KEY. Federation snapshots stay NULL (attestation + ' +
                'config-change quorum collapse) until the two keys match.';
        } else if (reason === REASONS.HTTP_ERROR) {
            detail = 'HTTP ' + err.response.status + ' from the BTC indexer.';
        } else {
            detail = 'The BTC indexer did not respond (' + ((err && err.message) || 'unknown transport error') +
                '); check that it is running and reachable at the configured URL.';
        }
        return this.fail(method, reason, detail);
    },

    // Record a consensus-input failure and return the null sentinel every fetch
    // path already uses. Single choke point so no future null-return can be
    // added without also raising the alarm (the exact regression the
    // consensus-input monitor closes).
    fail(method, reason, detail, throttleKey) {
        this.monitor.recordFailure(method, reason, detail, throttleKey);
        return null;
    },

    // Coerce an indexer result's `validators` field into a real array, or return
    // null when the shape is MALFORMED. A valid response always carries a
    // validators array (possibly empty after the qualifying-stake filter, or
    // capped when `truncated`); both of those are LEGITIMATE and must produce a
    // real snapshot, so an actual array (even length 0) passes through. Anything
    // else (missing field, object, string, number) is a parse failure / wrong
    // shape and returns null, which routes the caller through the consensus
    // fail-closed gate instead of silently yielding a zero-validator snapshot
    // (quorum=0) that is indistinguishable from single-node.
    //
    // On the WEIGHT fetchers the caller passes requireWeight, and a row
    // whose weight is missing/blank/nonnumeric makes the whole snapshot MALFORMED.
    // stake_weighted_quorum fails closed on such a row, but only if it ever sees
    // one: every consumer of this snapshot re-maps it through
    // `String(v.weight != null ? v.weight : '0')`, which launders a missing weight
    // into a real '0' and hands the predicate a well-formed row carrying no stake.
    // That is the exact defect the predicate guards against - the source stays in
    // the dedupe map, S shrinks, and a smaller real stake clears 3*tally > 2*S -
    // so the rejection has to happen HERE, at the point the wire row enters the
    // hub, not at the predicate the laundering hides it from. Rejecting the whole
    // snapshot (rather than dropping the row) is deliberate: dropping a row shrinks
    // S exactly the same way. A legitimate '0' weight still passes.
    coerceValidators(result, opts) {
        if (!result || !Array.isArray(result.validators)) return null;
        if (opts && opts.requireWeight) {
            for (let v of result.validators) {
                if (!v || v.weight === null || v.weight === undefined) return null;
                let w = String(v.weight).trim();
                if (w === '' || !NUMERIC_WEIGHT.test(w)) return null;
            }
        }
        return result.validators;
    },

    // Freshness / echo guard. The indexer fail-closes on a not-yet-indexed block
    // (`block_index > latest` -> error, surfaced here as a null snapshot) and
    // echoes the REQUESTED block on success, so a mismatch means the indexer
    // answered for a different height than asked. Locking a snapshot mislabeled
    // with `requested` would let two hubs compute quorum over different validator
    // sets for the same round. Reject on mismatch (throttled log follows the
    // auth idiom with its own field, so echo and auth alarms never mask each
    // other). Returns true when the echoed block matches the request.
    blockEchoOk(method, result, requested) {
        if (Number(result.block_index) === Number(requested)) return true;
        this.fail(method, REASONS.ECHO_MISMATCH,
            'Returned block_index ' + result.block_index + ' for requested block ' + requested +
            '; rejecting the snapshot (freshness/echo mismatch, possible indexer bug or misconfiguration).');
        return false;
    },

    // The OTHER half of the request key, guarded the same way and for the same
    // reason. `capability` selects which stake rows the indexer filters, so a
    // response answering for a different capability is a validator set for the wrong
    // population - and it would be cached under the REQUESTED key for the full TTL
    // and consumed as the round's N by every quorum caller. Strict, exactly like the
    // block echo: an ABSENT capability field fails too, because a stripped field is
    // indistinguishable here from a wrong one. Fail-closed costs this hub a vote;
    // fail-open casts a wrong one. Only the two capability-scoped fetchers call this;
    // the whole-federation ('*') fetchers send no capability and have nothing to echo.
    capabilityEchoOk(method, result, requested) {
        if (String(result.capability) === String(requested)) return true;
        this.fail(method, REASONS.ECHO_MISMATCH,
            'Returned capability ' + result.capability + ' for requested capability ' + requested +
            '; rejecting the snapshot (echo mismatch, possible indexer bug or misconfiguration).');
        return false;
    }
};
