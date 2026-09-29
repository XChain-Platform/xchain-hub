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
 * Polls the BTC indexer for the stake-weight snapshot behind
 * STAKE_WEIGHTED_QUORUM and feeds StakeShareMonitor, so the operator's own
 * share of active stake is measured against the two-thirds commit gate BEFORE
 * a round has to fail to reveal it, learned from a prior outage.
 *
 * BTC only, because capability staking is BTC-only at the protocol level (the
 * DOGE and LTC coin modules declare no capabilities) and the gate reads no
 * other chain's stake. A DOGE or LTC row could never predict a halt.
 *
 * It reads through the gate's OWN code: CapabilitySnapshot.getWeightSnapshot,
 * so the coin-verified indexer URL, the buried height, the MIN_STAKE fallback
 * and refusal, the row checks and the echo guards are the gate's, not a copy.
 * A monitor that computed the share its own way could report a comfortable
 * margin for a set the gate reads differently, which is worse than no monitor.
 *
 * The reader is a PRIVATE CapabilitySnapshot with a silent monitor: the hub's
 * shared one feeds the consensus-input alarm on /health, and a watcher success
 * there would reset a failure streak the gate is building.
 *
 * Read-only and best-effort: a failed poll records `unavailable` and changes no
 * hub state. It never votes, never writes, and never gates a round.
 *
 ********************************************************************/

'use strict';

const axios = require('axios');
const coins = require('../coins');
const hubConfig = require('../config');
const { StakeShareMonitor, evaluateStakeShare, normalizeSources, LEVELS } = require('./stake_share_monitor.js');
const CapabilitySnapshot = require('./capability_snapshot.js');
const { ConsensusInputMonitor } = require('./consensus_input_monitor.js');
const { getLogger } = require('../observability');
const logger = getLogger();

// The one chain whose capability stake any gate reads.
const GATE_CHAIN = 'BTC';

// Capabilities whose weighted gate can halt a user-visible rail: `price` rounds (a prior
// halt), the `oracle_publish` election that puts a finalized PRICE on chain (a healthy price
// share can still fail to publish), `attestation` rounds and `cross_chain` settlement, all
// under the same two-thirds predicate. Kept equal to DERIVED_CAPABILITIES by test.
const DEFAULT_CAPABILITIES = ['price', 'oracle_publish', 'attestation', 'cross_chain'];

// Five minutes. Stake moves at block cadence and the alert is a forecast with
// hours of lead time, so a tighter loop only adds indexer load; ten polls still
// cross an hour of an operator's response window.
const DEFAULT_POLL_MS = 5 * 60 * 1000;

// Split a comma/whitespace list from the environment; empty -> [].
function envList(value) {
    return normalizeSources(value);
}

class StakeShareWatcher {

    /**
     * @param {object} hub   XChainHub (needs resolveBtcIndexerUrl and btcIndexerHeaders;
     *                       capabilityRegistry, stakeWeightFeed and capabilitySnapshot are
     *                       read the way the gate reads them).
     * @param {object} [opts] test seams: env, now, log, axios, monitor, pollMs,
     *                       CapabilitySnapshot (the reader class).
     */
    constructor(hub, opts) {
        opts = opts || {};
        this.hub  = hub;
        this.env  = hubConfig.env(opts.env);
        this._log = typeof opts.log === 'function' ? opts.log : (msg) => logger.error(msg);
        this._axios = opts.axios || axios;
        this._SnapshotClass = opts.CapabilitySnapshot || CapabilitySnapshot;
        this._reader = null;

        this.pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs
            : (parseInt(this.env.HUB_STAKE_SHARE_POLL_MS, 10) || DEFAULT_POLL_MS);
        this.chains = [GATE_CHAIN];
        this.noteIgnoredChains(opts.chains && opts.chains.length ? opts.chains : envList(this.env.HUB_STAKE_SHARE_CHAINS));
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

    // Say once which named chains and chain-scoped source lists are ignored, so an
    // operator who configured DOGE or LTC learns why no row for them appears.
    noteIgnoredChains(requested) {
        let dropped = requested.map(c => String(c).toUpperCase()).filter(c => c !== GATE_CHAIN);
        let scoped  = coins.ALLOWED_COINS.filter(c => c !== GATE_CHAIN &&
            envList(this.env['HUB_OPERATOR_STAKE_SOURCES_' + c]).length > 0);
        if (dropped.length === 0 && scoped.length === 0) return;
        this._log('Stake-share monitor watches ' + GATE_CHAIN + ' only: capability staking is ' +
            'BTC-only and the stake-weighted gate reads no other chain. Ignoring ' +
            (dropped.length ? 'HUB_STAKE_SHARE_CHAINS entries ' + dropped.join(',') : '') +
            (dropped.length && scoped.length ? ' and ' : '') +
            (scoped.length ? scoped.map(c => 'HUB_OPERATOR_STAKE_SOURCES_' + c).join(', ') : '') + '.');
    }

    // Operator staking sources for a chain: its scoped list plus the bare
    // HUB_OPERATOR_STAKE_SOURCES. Only BTC is ever asked for.
    operatorSourcesFor(chain) {
        let scoped = envList(this.env['HUB_OPERATOR_STAKE_SOURCES_' + String(chain).toUpperCase()]);
        let shared = envList(this.env.HUB_OPERATOR_STAKE_SOURCES);
        return normalizeSources(scoped.concat(shared));
    }

    // True when the watched chain has an operator source list. With none, the
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
                'halt price, publish, attestation or cross-chain rounds with no warning. Set HUB_OPERATOR_STAKE_SOURCES_<COIN> ' +
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
                await this.pollChain(chain, sources);
            }
            this.passes++;
            this.lastPassAt = Date.now();
            return true;
        } finally {
            this._running = false;
        }
    }

    async pollChain(chain, sources) {
        // Resolve the URL the gate resolves: null when none is set OR when the
        // configured BTC indexer positively reports serving another coin.
        let url;
        try { url = await this.hub.resolveBtcIndexerUrl(); }
        catch (err) { url = null; }
        if (!url) {
            for (let cap of this.capabilities) {
                this.monitor.recordUnavailable(chain, cap,
                    'no usable BTC indexer: either no URL resolved (BTC_INDEXER_API_URL, BTC_INDEXER_URL, ' +
                    'or the configs table) or the configured one reports serving another coin. The gate\'s ' +
                    'capability snapshots are disabled by the same check, so rounds cannot lock a validator set.');
            }
            return;
        }

        let tip = await this.latestBlock(chain, url);
        if (tip === null) {
            for (let cap of this.capabilities) {
                this.monitor.recordUnavailable(chain, cap,
                    'the ' + chain + ' indexer at ' + url + ' did not report a latest block, so no stake ' +
                    'snapshot height could be resolved.');
            }
            return;
        }

        for (let cap of this.capabilities) {
            await this.pollCapability(chain, cap, tip, sources);
        }
    }

    // Read one capability's stake set through the gate's getWeightSnapshot. It
    // takes the RAW tip because it buries by the reorg buffer itself.
    async pollCapability(chain, capability, tip, sources) {
        let reader, snap, failuresBefore;
        try {
            reader = this.reader();
            failuresBefore = reader.monitor.failures;
            snap = await reader.getWeightSnapshot(capability, tip);
        } catch (err) {
            return this.monitor.recordUnavailable(chain, capability,
                'the gate\'s stake-weight read threw (' + ((err && err.message) || err) +
                '), so this chain\'s stake share is unmeasured.');
        }
        if (!snap) {
            // The reader's monitor holds why the gate would have refused this read.
            let last = reader.monitor.failures > failuresBefore ? reader.monitor.lastFailure : null;
            return this.monitor.recordUnavailable(chain, capability,
                'the gate\'s stake-weight read refused the snapshot' +
                (last ? ' (' + last.reason + '): ' + last.detail : '.'));
        }

        // Copy the snapshot's rows and carry `truncated` onto the ARRAY, which
        // is where the quorum predicate looks for it and fails closed.
        let rows = snap.validators.slice();
        if (snap.truncated === true) rows.truncated = true;

        // Size the margin unit off the same threshold the read just used.
        let blockIndex = Number(snap.blockIndex);
        let minStake;
        try { minStake = reader.resolveMinStake(capability, blockIndex); }
        catch (err) { minStake = null; }
        let evaluation = evaluateStakeShare({
            validators:       rows,
            operatorSources:  sources,
            minStake:         minStake,
            warnAtStakes:     this.warnAtStakes,
            criticalAtStakes: this.criticalAtStakes
        });
        evaluation.blockIndex = blockIndex;
        return this.monitor.record(chain, capability, evaluation);
    }

    // The watcher's own CapabilitySnapshot, built on first use. Its monitor is
    // silent so a monitoring read never logs as a consensus-input failure, it
    // caches nothing so every pass sees fresh stake, and it buries by the hub's
    // live buffer so the monitor and the gate can never read different heights.
    reader() {
        if (this._reader) return this._reader;
        let reader = new this._SnapshotClass(this.hub);
        reader.monitor = new ConsensusInputMonitor({ log: () => {} });
        reader.cacheTtlMs = 0;
        // Adopt the live buffer only when it is a real integer (no Number() coercion, which
        // turns null into 0); otherwise the reader keeps CANONICAL_REORG_BUFFER.
        let live = this.hub && this.hub.capabilitySnapshot && this.hub.capabilitySnapshot.reorgBufferBlocks;
        if (Number.isInteger(live) && live >= 0) reader.reorgBufferBlocks = live;
        this._reader = reader;
        return reader;
    }

    // One shared hub-to-indexer key covers every chain (btcIndexerHeaders is the
    // hub's single header builder, despite the name). Tolerates a hub stub that
    // does not define it so a read never dies on a missing header.
    headers() {
        if (this.hub && typeof this.hub.btcIndexerHeaders === 'function') return this.hub.btcIndexerHeaders();
        return { 'Content-Type': 'application/json' };
    }

    // Latest committed height on a chain's indexer. Null when unreadable; the
    // caller turns that into `unavailable` rather than guessing a height.
    async latestBlock(chain, url) {
        try {
            let res = await this._axios.post(url, {
                jsonrpc: '2.0', id: Date.now(), method: 'getlatestblock', params: {}
            }, { headers: this.headers(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return null;
            let blk = Number(result.block_index);
            return Number.isInteger(blk) && blk >= 0 ? blk : null;
        } catch (err) {
            return null;
        }
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

module.exports = Object.assign(StakeShareWatcher, {
    DEFAULT_CAPABILITIES,
    DEFAULT_POLL_MS,
    LEVELS
});
