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
 * XChain Hub - bounded probes behind ping and health: a deadline that
 * cleans up after itself, and the admission-tip probe with single-flight
 * and a short cache.
 *
 * `health` is on the public tier, and every call used to read all three
 * admission tips from the indexers, so the upstream cost of a health flood
 * was three indexer calls per call. The probe below shares one upstream read
 * among every concurrent caller and reuses its result for
 * ADMISSION_PROBE_TTL_MS, so a flood costs at most three indexer calls per
 * TTL window whatever its size. The TTL is far inside the six-block stall
 * window the admission gate dates tips against, so the report never trails
 * the producer's own view by more than a probe interval.
 *
 ********************************************************************/

'use strict';

const {
    ADMIT_COLUMN_CHAINS,
    ADMIT_MARGIN_BLOCKS,
    isMirrorAdmissionProducerActive
} = require('../../consensus/gates/mirror_admission_gate.js');

const ADMISSION_PROBE_TTL_MS = 1500;

// Race `work` against a deadline and clear the deadline's timer however the race ends,
// so a fast completion leaves no live handle behind. `work` is a promise, or a function
// handed an AbortSignal that fires at the deadline, so an HTTP read can be cancelled
// instead of left running after its caller has given up on it.
function raceTimeout(work, ms) {
    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, ms);
    });
    let pending;
    try { pending = Promise.resolve(typeof work === 'function' ? work(controller.signal) : work); }
    catch (err) { pending = Promise.reject(err); }
    return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}

// The admission-tip probe for one hub. Returns an async function answering the health
// report's `admission_tips` section, or null where the hub runs no producer.
function makeAdmissionTipProbe(hub, p2pConfig, timeoutMs, opts) {
    opts = opts || {};
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : ADMISSION_PROBE_TTL_MS;
    const clock = typeof opts.now === 'function' ? opts.now : Date.now;
    let cached = null;
    let inflight = null;

    // A timed-out or failed read is cached like a good one: the refusal it produces is
    // the honest report, and re-reading on every call is the amplification this bounds.
    function readTips() {
        if (cached && clock() - cached.at < ttlMs) return Promise.resolve(cached.resolved);
        if (inflight) return inflight;
        inflight = raceTimeout((signal) => hub.resolveAdmissionTips(ADMIT_COLUMN_CHAINS.slice(), { signal }), timeoutMs)
            .then((resolved) => resolved || {}, () => ({}))
            .then((resolved) => { cached = { resolved, at: clock() }; return resolved; })
            .finally(() => { inflight = null; });
        return inflight;
    }

    return async function probeAdmissionTips() {
        if (!p2pConfig || !hub || typeof hub.resolveAdmissionTips !== 'function') return null;
        return admissionReport(hub, await readTips());
    };
}

// The per-chain report from one resolver answer. A stale resolver result is null; the
// last observation is retained only as diagnosis and is never promoted back into a
// usable admission height. Built per call, so ages stay current under the cache.
function admissionReport(hub, resolved) {
    let chains = {};
    let missing = [];
    for (let chain of ADMIT_COLUMN_CHAINS) {
        let tip = usableAdmissionHeight(resolved[chain]);
        let previous = lastAdmissionTip(hub, chain);
        let stale = false;
        if (tip === null && previous !== null) {
            stale = typeof hub.admissionTipFresh === 'function'
                ? !hub.admissionTipFresh(chain, previous.height)
                : true;
        }
        if (tip === null) missing.push(chain);
        chains[chain] = {
            height: tip === null && previous !== null ? previous.height : tip,
            observed_at_ms: previous === null ? null : previous.at_ms,
            age_s: previous === null || previous.at_ms === null
                ? null : Math.max(0, Math.floor((Date.now() - previous.at_ms) / 1000)),
            fresh: tip !== null,
            stale,
            reason: tip !== null ? null : (stale
                ? 'admission tip for ' + chain + ' is stale'
                : 'no fresh admission tip for ' + chain)
        };
    }

    // Signed admission rows use their own BTC anchor for the producer flag day.
    // A stale last observation is sufficient to establish that the node has crossed
    // the activation, but is diagnostic only and remains unusable above.
    let btcHeight = chains.BTC && chains.BTC.height;
    let producerActive = usableAdmissionHeight(btcHeight) !== null &&
        isMirrorAdmissionProducerActive('BTC', hub.network, btcHeight);
    return {
        producer_active: producerActive,
        healthy: !producerActive || missing.length === 0,
        reason: producerActive && missing.length > 0
            ? 'no fresh admission tip for ' + missing.join(', ') + '; refusing to finalize admission-era rows'
            : null,
        admit_margin_blocks: ADMIT_MARGIN_BLOCKS,
        chains
    };
}

function usableAdmissionHeight(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function lastAdmissionTip(hub, chain) {
    let seen = hub && hub._admissionTipSeen;
    if (!seen || typeof seen.get !== 'function') return null;
    let value = seen.get(chain);
    if (!value) return null;
    let height = usableAdmissionHeight(value.height);
    return height === null ? null : { height, at_ms: Number(value.atMs) || null };
}

module.exports = { ADMISSION_PROBE_TTL_MS, makeAdmissionTipProbe, raceTimeout };
