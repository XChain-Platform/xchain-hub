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
 * XChain Hub - JSON-RPC oracle family: round submissions, price snapshots,
 * round presence, prices, publisher status and stake share. All public reads.
 *
 ********************************************************************/

const roundPresence = require('../../lib/oracle_round_presence.js');   // oracle round presence/divergence
const { validateLimit, strictInt } = require('../validate');
const swq = require('../../consensus/stake_weighted_quorum.js');
const { computeQuorumMargin } = require('../../oracle/quorum_margin.js');

// Preserve consensus-input capacity by enriching at most 16 historical anchors per public request.
const MAX_QUORUM_MARGIN_ANCHORS = 16;

function quorumInputs(row) {
    if (!row || row.status !== 'finalized' || typeof row.consensus_proof !== 'string') return null;
    let proof;
    try { proof = JSON.parse(row.consensus_proof); }
    catch (e) { return null; }
    let sigs = Array.isArray(proof) ? proof : proof && proof.sigs;
    let anchor = Array.isArray(proof) ? row.reference_block : proof && proof.batch && proof.batch.btc_block_height;
    if (!Array.isArray(sigs) || !Number.isFinite(Number(anchor))) return null;
    let signers = sigs.map(s => s && s.pubkey).filter(pk => typeof pk === 'string');
    if (signers.length !== sigs.length) return null;
    return { anchor: Number(anchor), signers };
}

async function quorumSnapshotFor(hub, inputs) {
    if (!inputs || !hub.capabilitySnapshot) return null;
    const weighted = swq.isStakeWeightedQuorumActive(inputs.anchor, hub.network);
    const snapshots = hub.capabilitySnapshot;
    const snapshot = weighted
        ? (typeof snapshots.getWeightSnapshot === 'function'
            ? await snapshots.getWeightSnapshot('price', inputs.anchor) : null)
        : (typeof snapshots.getSnapshot === 'function'
            ? await snapshots.getSnapshot('price', inputs.anchor) : null);
    if (!snapshot || !Array.isArray(snapshot.validators)) return null;
    let validators = snapshot.validators;
    if (weighted && snapshot.truncated === true) {
        validators = validators.slice();
        validators.truncated = true;
    }
    return { weighted, validators };
}

async function quorumMarginFor(snapshotPromise, inputs) {
    const snapshot = await snapshotPromise;
    if (!snapshot) return null;
    return computeQuorumMargin({
        weighted: snapshot.weighted,
        validators: snapshot.validators,
        signers: inputs.signers,
    });
}

async function addQuorumMargins(hub, rows) {
    const snapshots = new Map();
    const margins = new Map();
    return Promise.all(rows.map(async row => {
        const inputs = quorumInputs(row);
        const key = inputs && JSON.stringify([inputs.anchor, inputs.signers]);
        if (inputs && !snapshots.has(inputs.anchor) && snapshots.size < MAX_QUORUM_MARGIN_ANCHORS) {
            snapshots.set(inputs.anchor, quorumSnapshotFor(hub, inputs));
        }
        const snapshot = inputs && snapshots.get(inputs.anchor);
        if (key && snapshot && !margins.has(key)) {
            margins.set(key, quorumMarginFor(snapshot, inputs).catch(() => null));
        }
        const quorumMargin = key && margins.has(key) ? await margins.get(key) : null;
        return Object.assign({}, row, { quorum_margin: quorumMargin });
    }));
}

function buildOracleRpc(ctx) {
    return Object.assign({}, oracleStatusRpc(ctx), priceReadsRpc(ctx), roundPresenceRpc(ctx));
}

function oracleStatusRpc(ctx) {
    const { hub } = ctx;
    return {
        // Always 200. {active:false} means this hub runs NO oracle round at all -
        // the documented standalone config-oracle topology (the hub configuration page:
        // P2P_VALIDATOR_ADDR left empty), where startOracle() never mints an
        // OracleRound because there is no peerManager. That is an absent ROLE, not a
        // fault, so it is reported the same structured way getanchorstatus and
        // getoraclepublisherstatus report theirs, and deliberately NOT as an {error}
        // envelope: a health consumer cannot tell an error body apart from a
        // transport failure, so the old shape pinned such a hub at 'degraded' on
        // every poll for its whole life. startOracle() is awaited unguarded in
        // startApi, so a broken oracle subsystem fails the boot rather than
        // reaching here - {active:false} can only mean "no role".
        async getoraclesubmissions(){
            let oracle = hub.getOracle();
            if(!oracle) return {active: false};
            let info = await oracle.getSubmissionsInfo();
            // Publish the authoritative price-age bound alongside the cadence
            // (item #4479). ORACLE_ROUND_INTERVAL is an unbounded deployment
            // knob, so a health consumer deriving freshness from the cadence
            // alone (the dashboard's cadenceThresholds) can call a row 'ok'
            // that getprice already rejects as stale. Reuse oracleMaxAgeSecondsInForce
            // rather than a literal, so the exposed number can never diverge
            // from what getprice enforces; called without a pair it resolves to
            // the tightest tip-aware bound across registry chains. Additive: callers
            // that ignore the field are unaffected, and it is null when the registry
            // read fails.
            return {active: true, ...info, oracleMaxPriceAgeSeconds: await hub.oracleMaxAgeSecondsInForce()};
        },

        // ORACLE (PRICE v0) publisher status (read, no auth): publish-rail health for
        // the oracle-publish leader rotation - queue depth, lifetime published/abandoned
        // (dead-letter) counts, last-published round + txid, and the last-observed DOGE
        // publisher-wallet balance for runway monitoring. Reports only THIS hub's rail,
        // including its takeover of windows a silent leader left unpublished (the
        // takeover* fields); fleet-wide coverage is read off-hub by the dashboard.
        // Mirrors getanchorstatus: always 200 so a poller can read it independent of
        // overall hub health, {active:false} when no oracle publisher is running.
        async getoraclepublisherstatus(){
            if(!hub.oraclePublisher) return { active: false };
            return { active: true, ...hub.oraclePublisher.getStats() };
        },
    };
}

function priceReadsRpc(ctx) {
    const { hub } = ctx;
    return {
        // status is optional and additive: omitted/'finalized' preserves the
        // historical finalized-only contract; 'all' includes skipped/disputed
        // rows for health/monitoring consumers (dashboard oracle-feed parity).
        async getpricesnapshots({limit, status, with_watermark, with_quorum_margin}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            if (status !== undefined && status !== 'finalized' && status !== 'all')
                return {error: "status must be 'finalized' or 'all'"};
            try {
                let snapshots = await hub.getPriceSnapshots(limit || 50, status);
                if (with_quorum_margin) snapshots = await addQuorumMargins(hub, snapshots);
                // with_watermark is optional and additive: health consumers (the
                // dashboard's pairHealth) need a server-clock watermark so row age
                // is computed entirely in the hub's clock domain instead of diffing
                // hub block_timestamp against the caller's clock, which folds
                // host/hub skew into the freshness thresholds (same fix the
                // submissions rail already carries via lastSuccessAgeMs, and the
                // REST /hub-db/snapshot sibling via its `watermark`). Omitted =
                // historical bare-array contract, so existing callers are untouched.
                // oracleMaxPriceAgeSeconds rides this rail too (item 5551): the
                // bound the consumer clamps freshness to travelled only on
                // getoraclesubmissions, so it was lost exactly when that rail was
                // down; same oracleMaxAgeSecondsInForce source as there, never a literal.
                if (with_watermark) {
                    return {
                        watermark: Math.floor(Date.now() / 1000),
                        oracleMaxPriceAgeSeconds: await hub.oracleMaxAgeSecondsInForce(),
                        snapshots,
                    };
                }
                return snapshots;
            } catch (err) {
                return {error: "error fetching price snapshots"};
            }
        },

        async getprice({coin_pair}){
            if(!coin_pair) return {error: "coin_pair is required"};
            try {
                // Return an explicit stale/unavailable error rather than an aged-out
                // price (L-5): the hub is advisory, but a consumer cannot tell a stale
                // price from a fresh one, so gate on the same bound the indexer enforces.
                let s = await hub.getPriceStatus(coin_pair);
                if(s.missing) return {error: "no price data for " + coin_pair};
                if(s.stale)   return {error: "oracle price for " + coin_pair + " is stale (age " +
                                             s.ageSeconds + "s exceeds max " + s.maxAgeSeconds + "s)"};
                return s.row;
            } catch (err) {
                return {error: "error fetching price"};
            }
        },
    };
}

function roundPresenceRpc(ctx) {
    const { hub } = ctx;
    return {
        // Per-round PRESENCE over an explicit range, so "this hub has no
        // record of round 26" is a REPORTED value rather than an empty result set.
        // Poll every hub over the same from_round/to_round and compare `digest`:
        // equal digests mean the federation agrees on which rounds happened and how
        // they ended; unequal ones are localised by `missing` and the per-round
        // statuses. bin/oracle-round-presence.js does exactly that across a fleet.
        async getoracleroundpresence({from_round, to_round, limit}){
            // Safe integers, not merely finite ones. A bound at or past 2^53 survives
            // both Number.isFinite and strictInt's Number.isInteger, and the presence
            // fold cannot increment past it: one unauthenticated call pinned the event
            // loop. Omitted bounds stay legal, since the hub anchors those itself.
            for (let [name, v] of [['from_round', from_round], ['to_round', to_round]]) {
                if (v === undefined || v === null) continue;
                let n = strictInt(v);
                if (n === null || !Number.isSafeInteger(n) || n < 0)
                    return {error: name + ' must be a non-negative integer'};
            }
            if (limit !== undefined && limit !== null) {
                let n = strictInt(limit);
                if (n === null || n < 1 || n > roundPresence.MAX_RANGE)
                    return {error: 'limit must be between 1 and ' + roundPresence.MAX_RANGE};
            }
            try {
                return await hub.getOracleRoundPresence(from_round, to_round, limit);
            } catch (err) {
                return {error: "error fetching oracle round presence"};
            }
        },

        // Operator stake share vs the weighted commit gate (read, no auth). Per chain
        // and capability: total active stake, our share of it, whether it clears
        // 3*tally > 2*S, and how much further third-party stake fits before it stops
        // clearing. Mirrors getanchorstatus: always 200, so an operator (or the drill
        // that adds a competing stake on regtest) can read the margin without waiting
        // for a round to fail. Aggregates only, no address list: the numbers are what
        // is acted on, and a mismatched address is named in the hub's own log.
        // {active:false} when no watcher is running (config-only hub, or no operator
        // staking sources configured).
        async getstakeshare(){
            if(!hub.stakeShareWatcher) return { active: false };
            return { active: true, ...hub.stakeShareWatcher.getStats() };
        },
    };
}

module.exports = { buildOracleRpc };
