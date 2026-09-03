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
 * XChain Hub - StakeShareWatcher
 *
 * Polls each chain's indexer for the stake-weight snapshot behind
 * STAKE_WEIGHTED_QUORUM and feeds StakeShareMonitor, so the operator's own
 * share of active stake is measured against the two-thirds commit gate BEFORE
 * a round has to fail to reveal it, learned from a prior outage.
 *
 * Per chain, because stake is per chain: a staking address on BTC is not the
 * same set as one on DOGE, and one chain can be a single new staker away from a
 * halt while the others are comfortable. The chain's own indexer is the source
 * of truth for its own stake, exactly as CapabilitySnapshot uses the BTC
 * indexer for BTC-anchored rounds.
 *
 * It reads the SAME RPC the consensus path reads (getstakeweightsbycapability)
 * at the SAME buried height (tip minus the reorg buffer) with the SAME
 * MIN_STAKE, and hands the rows to the quorum predicate's own denominator. A
 * monitor that computed the share its own way could report a comfortable margin
 * for a set the gate reads differently, which is worse than no monitor.
 *
 * Read-only and best-effort: a failed poll records `unavailable` and changes no
 * hub state. It never votes, never writes, and never gates a round.
 *
 ********************************************************************/

'use strict';

const axios = require('axios');
const coins = require('./coins');
const { StakeShareMonitor, evaluateStakeShare, normalizeSources, LEVELS } =
    require('./lib/stake_share_monitor.js');

// Capabilities whose weighted gate can halt a user-visible rail. `price` is the
// commit gate for oracle price rounds (a prior halt) and `oracle_publish`
// gates the publisher election that puts a finalized PRICE on chain, so a
// federation can hold a healthy price share and still be unable to publish it.
const DEFAULT_CAPABILITIES = ['price', 'oracle_publish'];

// Five minutes. Stake moves at block cadence and the alert is a forecast with
// hours of lead time, so a tighter loop only adds indexer load; ten polls still
// cross an hour of an operator's response window.
const DEFAULT_POLL_MS = 5 * 60 * 1000;

// Reorg depth to step back from the tip when the hub exposes no snapshot buffer
// of its own. Matches CapabilitySnapshot's default (the BTC confirmation depth
// the platform already treats as buried), so the monitor measures the same
// height the consensus snapshot locks.
const DEFAULT_REORG_BUFFER = 6;

// Split a comma/whitespace list from the environment; empty -> [].
function envList(value) {
    return normalizeSources(value);
}

class StakeShareWatcher {

    /**
     * @param {object} hub   XChainHub (needs _resolveIndexerUrl, _btcIndexerHeaders;
     *                       capabilityRegistry and capabilitySnapshot are used when present).
     * @param {object} [opts] test seams: env, now, log, axios, monitor, pollMs.
     */
    constructor(hub, opts) {
        opts = opts || {};
        this.hub  = hub;
        this.env  = opts.env || process.env;
        this._log = typeof opts.log === 'function' ? opts.log : (msg) => console.error(msg);
        this._axios = opts.axios || axios;

        this.pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs
            : (parseInt(this.env.HUB_STAKE_SHARE_POLL_MS, 10) || DEFAULT_POLL_MS);
        this.chains = (opts.chains && opts.chains.length ? opts.chains : envList(this.env.HUB_STAKE_SHARE_CHAINS))
            .map(c => String(c).toUpperCase());
        if (this.chains.length === 0) this.chains = coins.ALLOWED_COINS.slice();
        this.capabilities = (opts.capabilities && opts.capabilities.length)
            ? opts.capabilities.slice()
            : (envList(this.env.HUB_STAKE_SHARE_CAPABILITIES).length
                ? envList(this.env.HUB_STAKE_SHARE_CAPABILITIES)
                : DEFAULT_CAPABILITIES.slice());

        this.warnAtStakes     = parseInt(this.env.HUB_STAKE_SHARE_WARN_STAKES, 10) || undefined;
        this.criticalAtStakes = parseInt(this.env.HUB_STAKE_SHARE_CRITICAL_STAKES, 10) || undefined;

        this.monitor = opts.monitor || new StakeShareMonitor({
            throttleMs: this.pollMs,
            now:        opts.now,
            log:        this._log
        });

        this._timer   = null;
        this._running = false;
        this.passes   = 0;
        this.lastPassAt = null;
    }

    // Operator staking sources for one chain. The per-chain form is the correct
    // one (addresses are chain-specific); the bare form is the union fallback for
    // a single-chain deployment. Both are read so a hub can name only the chains
    // it actually stakes on without listing foreign addresses that can never match.
    operatorSourcesFor(chain) {
        let scoped = envList(this.env['HUB_OPERATOR_STAKE_SOURCES_' + String(chain).toUpperCase()]);
        let shared = envList(this.env.HUB_OPERATOR_STAKE_SOURCES);
        return normalizeSources(scoped.concat(shared));
    }

    // True when at least one chain has an operator source list. With none, the
    // watcher has nothing to measure and says so once at start rather than
    // polling forever to report `unconfigured`.
    isConfigured() {
        for (let chain of this.chains) if (this.operatorSourcesFor(chain).length > 0) return true;
        return false;
    }

    start() {
        if (this._timer) return false;
        if (!this.isConfigured()) {
            this._log('Stake-share monitor DISABLED: no operator staking sources configured. ' +
                'Nothing is watching this federation\'s share of active stake against the ' +
                'STAKE_WEIGHTED_QUORUM two-thirds commit gate, so a single new community STAKE can ' +
                'halt price rounds with no warning. Set HUB_OPERATOR_STAKE_SOURCES_<COIN> ' +
                '(or HUB_OPERATOR_STAKE_SOURCES) to the staking addresses this operator controls.');
            return false;
        }
        this.pollOnce().catch(e => this._log('Stake-share poll failed: ' + ((e && e.message) || e)));
        this._timer = setInterval(() => {
            this.pollOnce().catch(e => this._log('Stake-share poll failed: ' + ((e && e.message) || e)));
        }, this.pollMs);
        if (this._timer.unref) this._timer.unref();
        this._log('Stake-share monitor watching ' + this.chains.join(',') + ' for ' +
            this.capabilities.join(',') + ' every ' + this.pollMs + 'ms against the two-thirds ' +
            'stake-weighted commit gate');
        return true;
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    // One full pass over every configured chain and capability. In-flight guard:
    // the interval fires on a bare setInterval while a pass awaits unbounded
    // indexer round-trips, so a slow indexer would otherwise stack passes.
    // Skipping is safe because the next tick re-reads fresh truth.
    async pollOnce() {
        if (this._running) return false;
        this._running = true;
        try {
            for (let chain of this.chains) {
                let sources = this.operatorSourcesFor(chain);
                // A chain this operator does not stake on is not a finding: skip it
                // rather than filling /health with `unconfigured` rows for chains
                // that were never in scope.
                if (sources.length === 0) continue;
                await this._pollChain(chain, sources);
            }
            this.passes++;
            this.lastPassAt = Date.now();
            return true;
        } finally {
            this._running = false;
        }
    }

    async _pollChain(chain, sources) {
        let url;
        try { url = await this.hub._resolveIndexerUrl(chain); }
        catch (err) { url = null; }
        if (!url) {
            for (let cap of this.capabilities) {
                this.monitor.recordUnavailable(chain, cap,
                    'no ' + chain + ' indexer URL could be resolved (' + chain + '_INDEXER_API_URL, ' +
                    chain + '_INDEXER_URL, or the configs table), so this chain\'s stake share is unmeasured.');
            }
            return;
        }

        let tip = await this._latestBlock(chain, url);
        if (tip === null) {
            for (let cap of this.capabilities) {
                this.monitor.recordUnavailable(chain, cap,
                    'the ' + chain + ' indexer at ' + url + ' did not report a latest block, so no stake ' +
                    'snapshot height could be resolved.');
            }
            return;
        }
        let block = Math.max(0, tip - this._reorgBuffer());

        for (let cap of this.capabilities) {
            await this._pollCapability(chain, cap, url, block, sources);
        }
    }

    async _pollCapability(chain, capability, url, block, sources) {
        let minStake = this._minStakeFor(capability, block);
        let params = { capability: capability, block_index: block };
        if (minStake !== null) params.min_stake = minStake;

        let result;
        try {
            let res = await this._axios.post(url, {
                jsonrpc: '2.0', id: Date.now(), method: 'getstakeweightsbycapability', params: params
            }, { headers: this._headers(), timeout: 5000 });
            result = res && res.data && res.data.result;
        } catch (err) {
            let status = err && err.response && err.response.status;
            return this.monitor.recordUnavailable(chain, capability,
                'the ' + chain + ' indexer at ' + url + ' could not be read' +
                (status ? ' (HTTP ' + status + (status === 401 || status === 403
                    ? ': the hub\'s BTC_INDEXER_API_KEY does not match the indexer\'s INDEXER_API_KEY' : '') + ')'
                    : ' (' + ((err && err.message) || 'transport error') + ')') +
                ', so this chain\'s stake share is unmeasured.');
        }
        if (!result || result.error) {
            return this.monitor.recordUnavailable(chain, capability,
                'the ' + chain + ' indexer refused the stake-weight read at block ' + block + ': ' +
                ((result && result.error) || 'no result'));
        }
        if (!Array.isArray(result.validators)) {
            return this.monitor.recordUnavailable(chain, capability,
                'the ' + chain + ' indexer answered the stake-weight read at block ' + block +
                ' with no validators array.');
        }

        // Carry `truncated` onto the ARRAY, which is where the quorum predicate
        // looks for it. A truncated set is one meetsStakeThreshold() fails closed
        // on, so it must reach the evaluator as such rather than be summed.
        let rows = result.validators;
        if (result.truncated === true) rows.truncated = true;

        let evaluation = evaluateStakeShare({
            validators:       rows,
            operatorSources:  sources,
            minStake:         minStake,
            warnAtStakes:     this.warnAtStakes,
            criticalAtStakes: this.criticalAtStakes
        });
        evaluation.blockIndex = block;
        return this.monitor.record(chain, capability, evaluation);
    }

    // One shared hub-to-indexer key covers every chain (_btcIndexerHeaders is the
    // hub's single header builder, despite the name). Tolerates a hub stub that
    // does not define it so a read never dies on a missing header.
    _headers() {
        if (this.hub && typeof this.hub._btcIndexerHeaders === 'function') return this.hub._btcIndexerHeaders();
        return { 'Content-Type': 'application/json' };
    }

    // Latest committed height on a chain's indexer. Null when unreadable; the
    // caller turns that into `unavailable` rather than guessing a height.
    async _latestBlock(chain, url) {
        try {
            let res = await this._axios.post(url, {
                jsonrpc: '2.0', id: Date.now(), method: 'getlatestblock', params: {}
            }, { headers: this._headers(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return null;
            let blk = Number(result.block_index);
            return Number.isInteger(blk) && blk >= 0 ? blk : null;
        } catch (err) {
            return null;
        }
    }

    // The same buried-height offset the consensus snapshot uses, read off the
    // live CapabilitySnapshot when there is one so an operator override cannot
    // put the monitor and the gate on different heights.
    _reorgBuffer() {
        let snap = this.hub && this.hub.capabilitySnapshot;
        let buf = snap && Number(snap.reorgBufferBlocks);
        return Number.isInteger(buf) && buf >= 0 ? buf : DEFAULT_REORG_BUFFER;
    }

    // The capability's MIN_STAKE at this height, from the same registry the
    // consensus snapshot resolves it from. Null (omit the param) when no registry
    // is live, which lets the indexer apply its own local threshold; the
    // evaluator then sizes the margin off the smallest stake present instead.
    _minStakeFor(capability, block) {
        let reg = this.hub && this.hub.capabilityRegistry;
        if (!reg || typeof reg.getMinStake !== 'function') return null;
        let v;
        try { v = reg.getMinStake(capability, block); }
        catch (err) { return null; }
        if (v === null || v === undefined) return null;
        let s = String(v).trim();
        return /^\d+\.?\d*$/.test(s) ? s : null;
    }

    // Body-only telemetry for /health and the operator RPC.
    getStats() {
        let stats = this.monitor.snapshot();
        // `chains` on the monitor snapshot is the per-chain RESULT map, so the
        // configured list rides under its own name rather than shadowing it.
        stats.poll_ms              = this.pollMs;
        stats.passes               = this.passes;
        stats.watched_chains       = this.chains.slice();
        stats.watched_capabilities = this.capabilities.slice();
        stats.last_pass_age_s      = this.lastPassAt === null ? null : Math.round((Date.now() - this.lastPassAt) / 1000);
        return stats;
    }
}

module.exports = StakeShareWatcher;
module.exports.DEFAULT_CAPABILITIES = DEFAULT_CAPABILITIES;
module.exports.DEFAULT_POLL_MS = DEFAULT_POLL_MS;
module.exports.LEVELS = LEVELS;
