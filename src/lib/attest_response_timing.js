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
 * The forward margin the round leader stamps into the mirror-era ATTEST
 * response canonical (the ATTEST response mirror design, §4.2).
 *
 * WHAT THE NUMBER BUYS. The leader signs `effective_time = now + this`, and an
 * indexer applies the row at the first block whose protocol time reaches it. The
 * margin therefore has to be long enough that EVERY indexer already holds the
 * row by the time any indexer's chain reaches that block; otherwise two nodes
 * apply the same response at two different blocks and their action-index
 * counters fork permanently. What has to fit inside it is: federation gossip of
 * the finalized artifact (one P2P hop), the hub-mirror stream hop to each
 * indexer, and hub-to-hub clock skew. All three are seconds.
 *
 * WHY NOT 2400, THE CROSS-CHAIN RELAY'S MARGIN. That figure (lib/relay_margin.js)
 * is sized so a relayed row can LAND ON ANOTHER CHAIN before its effective time:
 * it has to cover a whole foreign-chain confirmation window, which on BTC is
 * tens of minutes. Nothing in the attestation-response path lands anywhere. The
 * row is produced, gossiped and streamed, and then it is simply present. Copying
 * 2400 here would buy nothing and would add 38 minutes of dead latency to every
 * contract callback, which is most of what this whole spec exists to remove.
 *
 * WHY THE OVERRIDE SEAM EXISTS AT ALL. Regtest blocks are stamped at about wall
 * clock now, so with the margin at 120 a regtest attestation response cannot
 * bind for 120 REAL seconds after it finalizes, per request. Every acceptance
 * test in §10 waits on a callback firing, so at the frozen value the whole AT1
 * to AT6 ladder is undrivable rather than merely slow. This is the same wedge
 * already recorded for the price-barrier grace, and it gets the same answer:
 * a network-gated seam, not a lowered constant.
 *
 * THE BATCH WINDOW RIDES HERE FOR THE SAME REASON. The periodic on-chain batch
 * that keeps the response history reconstructible from chain parse closes on the
 * wall-clock hour, and a regtest venue cannot wait an hour per acceptance test, so
 * it gets the identical network-gated seam. The window is deliberately NOT coupled
 * to the PRICE batch window, which counts ROUNDS rather than seconds and is resized
 * against the fee-staleness bound: coupling attestation coverage to a number that
 * moves for unrelated reasons would move a chain-only node's coverage proof with it.
 *
 * WHY THE SEAM IS REGTEST-ONLY AND FAILS LOUD THERE. The resolved value goes
 * straight into bytes the responsible set signs, and every honest hub bounds an
 * incoming proposal against its OWN expectation computed from this same number.
 * A hub running a different margin off regtest would therefore have every one of
 * its proposals refused by its peers and would refuse every one of theirs: not a
 * fork, but a federation that silently stops finalizing. So off regtest a
 * differing override is IGNORED with a warning (the house shape, matching
 * XChainHub._oracleMaxAgeSeconds and providers/http_get's private-address
 * hatch), and on regtest a value that is not a non-negative integer THROWS
 * rather than resolving to NaN and stamping `now + NaN` into a canonical no
 * verifier can rebuild.
 *
 ********************************************************************/

'use strict';

// Seconds ahead of the leader's clock that a mirror-era response binds. FROZEN
// PROTOCOL CONSTANT: it is not read from the row, it is the expectation every
// follower recomputes locally to bound a leader's proposal, so two hubs holding
// two values do not disagree about one row, they refuse each other's rounds.
const ATTEST_RESPONSE_FORWARD_S = 120;

// The regtest-only seam's key. Read from p2pConfig first (the e2e harness runs
// several hubs in one process off in-memory config, where no per-hub env var
// exists), then from the process environment for a single-hub container. Same
// precedence order as every other network-gated hub seam.
const ATTEST_RESPONSE_FORWARD_S_OVERRIDE = 'ATTEST_RESPONSE_FORWARD_S_OVERRIDE';

// Seconds per on-chain batch window, aligned to the unix hour. FROZEN PROTOCOL
// CONSTANT for the same reason the margin above is one: the window bounds are what
// the batch key is derived from and what the batch quorum signs, so two hubs on two
// cadences do not publish two schedules, they propose batches no peer can co-sign.
const ATTEST_BATCH_WINDOW_S = 3600;

// The regtest-only seam's key for the window above, resolved with the same
// precedence (p2pConfig first for an in-process federation, then the environment).
const ATTEST_BATCH_WINDOW_S_OVERRIDE = 'ATTEST_BATCH_WINDOW_S_OVERRIDE';

// Latched so the ignored-override warning prints once per process rather than
// once per attestation round. A per-round line would bury the log on a busy hub,
// and the condition it reports is a static misconfiguration that cannot change
// without a restart.
let warnedOverrideIgnored = false;
let warnedWindowOverrideIgnored = false;

// True when `raw` spells a non-negative integer number of seconds. Deliberately
// a string test rather than parseInt: parseInt('12abc') is 12 and parseInt('')
// is NaN, so an operator typo would either silently shorten the margin or
// resolve to NaN. Neither is a value to start a validator on.
function isNonNegativeIntegerSpelling(raw){
    let s = String(raw).trim();
    if(!/^[0-9]+$/.test(s)) return false;
    return Number.isSafeInteger(Number(s));
}

// The forward margin this hub stamps and bounds against, in seconds.
//
// Returns the frozen constant unless the network is regtest AND an override is
// set. `network` is the hub's own HUB_NETWORK; standalone mode (network '') is
// not regtest and therefore fails closed to the constant, for the reason the
// header gives: an unratified network is the one place a stray env var is most
// likely to be inherited from someone else's shell.
function resolveAttestResponseForwardS(network, p2pConfig){
    // The env read is spelled OUT, not indexed through the constant above, even
    // though the constant holds that exact string. A computed `process.env[name]`
    // is invisible to bin/check-env-var-doc-coverage.js, which scans for literal
    // reads: the variable would exist, be operator-settable, and appear in no
    // configuration table, and the gate would only ever see the anonymous
    // computed-read count rise. The indirection bought nothing here, since the
    // constant is its own name. It stays in use for the config-table lookup and
    // for the messages below, where it is a real deduplication.
    let raw = (p2pConfig && p2pConfig[ATTEST_RESPONSE_FORWARD_S_OVERRIDE] != null)
        ? p2pConfig[ATTEST_RESPONSE_FORWARD_S_OVERRIDE]
        : process.env.ATTEST_RESPONSE_FORWARD_S_OVERRIDE;

    if(raw === null || raw === undefined || String(raw).trim() === '')
        return ATTEST_RESPONSE_FORWARD_S;

    if(String(network) === 'regtest'){
        // Throwing beats defaulting. The operator set this key on purpose; a
        // silent fallback to 120 would leave the acceptance ladder hanging on
        // 120-second waits with nothing in the log to say why, which is the
        // failure mode the seam was added to remove.
        if(!isNonNegativeIntegerSpelling(raw))
            throw new Error(ATTEST_RESPONSE_FORWARD_S_OVERRIDE + '=' + JSON.stringify(String(raw)) +
                ' is not a non-negative integer number of seconds. Set it to a whole number of ' +
                'seconds (e.g. 2) or unset it to use the protocol value of ' + ATTEST_RESPONSE_FORWARD_S + '.');
        return Number(String(raw).trim());
    }

    // Off regtest the key is inert. Warn only when it actually differs from the
    // protocol value, so a config template that pins the same number everywhere
    // stays quiet, and warn once (see the latch above).
    let requested = isNonNegativeIntegerSpelling(raw) ? Number(String(raw).trim()) : null;
    if(requested !== ATTEST_RESPONSE_FORWARD_S && !warnedOverrideIgnored){
        warnedOverrideIgnored = true;
        console.log('WARNING: ' + ATTEST_RESPONSE_FORWARD_S_OVERRIDE + '=' + String(raw) +
            ' is set but IGNORED on ' + (network || '<unset>') + '; using the protocol forward margin (' +
            ATTEST_RESPONSE_FORWARD_S + 's). This seam is regtest-only: a hub stamping a different ' +
            'margin has every proposal refused by its peers and refuses every one of theirs.');
    }
    return ATTEST_RESPONSE_FORWARD_S;
}

// The batch window this hub closes on, in seconds. Same seam and same rules as the
// forward margin above, with one difference: a window of zero seconds is not a
// shorter cadence, it is a division by zero in the alignment arithmetic, so the
// regtest spelling test demands a POSITIVE integer rather than a non-negative one.
function resolveAttestBatchWindowS(network, p2pConfig){
    // Spelled out rather than indexed through the constant, for the reason
    // resolveAttestResponseForwardS records above: a computed process.env read is
    // invisible to the env-var documentation sweep.
    let raw = (p2pConfig && p2pConfig[ATTEST_BATCH_WINDOW_S_OVERRIDE] != null)
        ? p2pConfig[ATTEST_BATCH_WINDOW_S_OVERRIDE]
        : process.env.ATTEST_BATCH_WINDOW_S_OVERRIDE;

    if(raw === null || raw === undefined || String(raw).trim() === '')
        return ATTEST_BATCH_WINDOW_S;

    if(String(network) === 'regtest'){
        if(!isNonNegativeIntegerSpelling(raw) || Number(String(raw).trim()) <= 0)
            throw new Error(ATTEST_BATCH_WINDOW_S_OVERRIDE + '=' + JSON.stringify(String(raw)) +
                ' is not a positive integer number of seconds. Set it to a whole number of ' +
                'seconds (e.g. 10) or unset it to use the protocol window of ' + ATTEST_BATCH_WINDOW_S + '.');
        return Number(String(raw).trim());
    }

    let requested = isNonNegativeIntegerSpelling(raw) ? Number(String(raw).trim()) : null;
    if(requested !== ATTEST_BATCH_WINDOW_S && !warnedWindowOverrideIgnored){
        warnedWindowOverrideIgnored = true;
        console.log('WARNING: ' + ATTEST_BATCH_WINDOW_S_OVERRIDE + '=' + String(raw) +
            ' is set but IGNORED on ' + (network || '<unset>') + '; using the protocol batch window (' +
            ATTEST_BATCH_WINDOW_S + 's). This seam is regtest-only: the window bounds are inside the ' +
            'batch key and the signed batch canonical, so a hub on its own cadence proposes batches ' +
            'no peer can co-sign.');
    }
    return ATTEST_BATCH_WINDOW_S;
}

module.exports = Object.freeze({
    ATTEST_RESPONSE_FORWARD_S,
    ATTEST_RESPONSE_FORWARD_S_OVERRIDE,
    resolveAttestResponseForwardS,
    ATTEST_BATCH_WINDOW_S,
    ATTEST_BATCH_WINDOW_S_OVERRIDE,
    resolveAttestBatchWindowS
});
