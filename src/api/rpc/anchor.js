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
 * XChain Hub - JSON-RPC anchor family: checkpoints, ANCHOR and ROLLCALL publisher
 * status, the effector-spend controls and reorg reports.
 *
 ********************************************************************/

const SpendGuard = require('../../lib/spend_guard.js');   // per-capability effector-spend pause registry
const { validateChain, validateLimit, strictInt } = require('../validate');

function buildAnchorRpc(ctx) {
    return Object.assign({}, anchorStatusRpc(ctx), rollcallEffectorRpc(ctx), reorgReportRpc(ctx));
}

function anchorStatusRpc(ctx) {
    const { hub } = ctx;
    return {
        // Get state-checkpoint health: last finalized block per chain and a
        // process-lifetime count of rounds that timed out below quorum.
        // Mirrors getattestationstats / getcrosschaincallstats.
        async getcheckpointstats(){
            if(!hub.stateCheckpoints) return {error: "checkpoint engine not active"};
            try {
                return await hub.stateCheckpoints.getStats();
            } catch (err) {
                return {error: "error fetching checkpoint stats"};
            }
        },

        // Manually trigger an ANCHOR flush (write-auth): publish any pending
        // checkpoint anchors + the pending archive batch now instead of waiting
        // for the interval timer. Election still applies: a hub that isn't the
        // elected publisher for a pending anchor skips it (reflected in the
        // returned summary) rather than publishing out of turn.
        async anchorflush(){
            if(!hub.stateAnchorPublisher) return {error: "anchor publisher not active"};
            try {
                return await hub.stateAnchorPublisher.flush();
            } catch (err) {
                return {error: "anchor flush failed"};
            }
        },

        // ANCHOR publisher status (read, no auth): cumulative anchor counts plus the
        // last-observed DOGE publisher-wallet balance + threshold, for runway
        // monitoring. Always 200 (unlike `health`, which flips to 503 when degraded
        // and would hide the body), so a poller can read the balance independent of
        // overall hub health. Returns {active:false} when no publisher is running.
        async getanchorstatus(){
            if(!hub.stateAnchorPublisher) return { active: false };
            return { active: true, ...hub.stateAnchorPublisher.getAnchorStats() };
        },
    };
}

function rollcallEffectorRpc(ctx) {
    const { hub } = ctx;
    return {
        // ROLLCALL publisher status (sensitive read; see SENSITIVE_READ_METHODS).
        // PUBLISHER STATE ONLY, for the newest epoch this hub is tracking: whether we
        // signed it, how many verified signatures we have collected, how many of them
        // we last observed on chain, who leads the election, our own rank, the txids
        // we broadcast, and whether this hub's signer module can publish at all.
        //
        // It reports NO ledger facts. `last_rolled_epoch` and `absent_streak` are the
        // BTC indexer's (getrollcallabsences), where they are authoritative; serving a
        // hub's opinion of them here would give two answers to one question and the
        // wrong one would read as an eviction.
        //
        // Mirrors getanchorstatus: always 200, {active:false} plus a fully-shaped body
        // when no round engine is running, so a poller never has to branch on presence.
        async getrollcallstatus(){
            if(!hub.rollcallRound)
                return { active: false, epoch: null, signed: false, gossiped_count: 0,
                         on_chain_count: null, leader: null, our_rank: -1, txids: [],
                         broadcast_capable: false };
            return { active: true, ...hub.rollcallRound.getStatus() };
        },

        // Effector-spend control surface. Read: every registered SpendGuard
        // (one per on-chain effector: oracle-publish, attest, anchor, full-node) with
        // its pause state, balance floor, and rolling per-window spend ceiling (clamped
        // at the $2000 AML admission ceiling). Read-only, always 200.
        async geteffectorspendstatus(){
            return { effectors: SpendGuard.list() };
        },

        // Per-capability runtime pause (write, auth-gated). Halts a single
        // effector's on-chain spend immediately, INCLUDING its primary/leader path,
        // without a restart. `label` is the guard label (e.g. 'OraclePublisher',
        // 'AttestationPublisher', 'StateAnchorPublisher', 'FullNodeChallengeRound').
        async pauseeffectorspend({label, reason}){
            if(!label) return {error: "label is required"};
            if(!SpendGuard.pauseCapability(label, reason || 'operator pause via RPC'))
                return {error: "no effector registered with label '" + label + "'"};
            return {status: "paused", label};
        },
        async resumeeffectorspend({label}){
            if(!label) return {error: "label is required"};
            if(!SpendGuard.resumeCapability(label))
                return {error: "no effector registered with label '" + label + "'"};
            return {status: "resumed", label};
        },
    };
}

function reorgReportRpc(ctx) {
    const { hub } = ctx;
    return {
        async reportreorg({chain, reorg_height, timestamp, old_hash, new_hash}){
            if(!chain || !reorg_height || !timestamp)
                return {error: "chain, reorg_height, and timestamp are required"};
            let chainErr = validateChain(chain);
            if (chainErr) return chainErr;
            // strictInt, not parseInt, the same band every sibling write method enforces:
            // parseInt takes an integer PREFIX, so '850000junk' passed as 850000 and
            // '8.5e5' as 8, and the coerced height is what canonicalReorgId builds the
            // federation-wide round identity from. timestamp had no API guard at all, so
            // parseInt('abc') forwarded NaN into hub.reportReorg.
            let rh = strictInt(reorg_height);
            if (rh === null || rh < 0)
                return {error: "reorg_height must be a non-negative integer"};
            let ts = strictInt(timestamp);
            if (ts === null || ts < 0)
                return {error: "timestamp must be a non-negative integer"};
            // The reporter must supply its observed hash pair at reorg_height; the
            // hub (and every co-signing peer) re-verifies new_hash against its own
            // indexer before any rollback round can start.
            if(!old_hash || !new_hash)
                return {error: "old_hash and new_hash (the block hash observed at reorg_height before and after the reorg) are required"};
            try {
                await hub.reportReorg(chain, rh, ts, String(old_hash), String(new_hash));
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error reporting reorg"};
            }
        },

        async getreorghistory({limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getReorgHistory(limit);
            } catch (err) {
                return {error: "error fetching reorg history"};
            }
        },
    };
}

module.exports = { buildAnchorRpc };
