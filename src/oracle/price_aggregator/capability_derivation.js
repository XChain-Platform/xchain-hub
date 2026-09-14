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
 * XChain Hub - Price Aggregator: derived capability snapshots
 *
 * NOTHING wrote a capability snapshot of ANY kind on a hub that does not run oracle
 * consensus. For `price` the sole writer was OracleConsensus._persistCapabilitySnapshot on the
 * round-FINALIZATION path, which only a validator hub reaches, so a chain-only node
 * (an indexer whose only price source is the on-chain batch, pointed at its own
 * standalone hub) mirrored an empty capability_snapshots and recorded EVERY landed
 * batch `invalid: insufficient signer stake`: off BTC the indexer resolves the price
 * set from the hub-mirrored table alone (xchain-indexer db/index.js usesCapabilitySnapshot),
 * so the qualified set was empty, S summed to zero and the strict bar could not be
 * met by signatures that all verify. Measured on the real testnet chain-only node
 * 2026-09-09: 60 batches parsed, 60 refusals, capability_snapshots empty in all three
 * of its databases while its Bitcoin view answered HTTP 200.
 *
 * THE ORDERING IS WHY THIS IS A TIMER AND NOT AN INGEST HOOK. The indexer validates a
 * parsed batch BEFORE it pushes it to the hub, so a fix that filled the snapshot when
 * a VALID batch arrived could never fire: no snapshot means invalid, invalid means no
 * push, no push means no snapshot. Nothing on the receive path may be the trigger.
 * The hub therefore DERIVES the set for a WINDOW of BTC heights straight from the
 * configured Bitcoin indexer (operator ruling 2026-09-09), on its own clock, before
 * and independently of any batch, and persists it through the same shared writer the
 * consensus path uses so both paths produce byte-identical rows.
 *
 * Validator identity still goes through Bitcoin: every row here comes from
 * CapabilitySnapshot's `getcapabilityvalidators` / `getstakeweightsbycapability` read
 * against the BTC indexer at a BTC height, exactly as the consensus path resolves it.
 * Nothing is invented locally, and an unreachable or truncated read writes NOTHING.
 *
 * THE SAME HOLE EXISTS FOR EVERY OTHER CAPABILITY, and each has its own refusal.
 * `price` was simply the one the batch rail surfaced first. On the same measured
 * chain-only node, of 13 verdict divergences against origin, five were ATTEST actions
 * refused `invalid: insufficient signer stake` for a missing `attestation` snapshot
 * and one was an ANCHOR archive head stored `unverified` for a missing
 * `oracle_publish` snapshot (xchain-indexer actions/anchor.js:519 documents that
 * exact behaviour). So the pass derives every name in DERIVED_CAPABILITIES, on the
 * same window, the same clock and the same shared writer.
 *
 ********************************************************************/

const { positiveIntConfig } = require('../../lib/config_int.js');
const { DERIVED_CAPABILITIES, CAPABILITY_CONSENSUS_ENGINES, PRICE_CAP_DERIVE_LOOKBACK_BLOCKS,
        PRICE_CAP_DERIVE_INTERVAL_S, PRICE_CAP_DERIVE_MAX_PER_TICK } = require('./derived_capabilities.js');
const hubConfig = require('../../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// FAIL CLOSED, LOUDLY. _resolveBtcLatestBlock returns null for an unreachable
// indexer, a stale pushed tip and an over-lagged direct tip alike, and every
// one of those means this hub cannot know the qualifying set at any height.
// Deriving from a guessed height would mirror a set nobody can verify.
function warnNoBtcTip() {
    logger.error('PriceAggregator: cannot derive capability snapshots: the '
        + 'configured Bitcoin view returned no usable tip. Nothing written. Until it '
        + 'answers, every on-chain PRICE batch and every ATTEST this node parses reads '
        + '`invalid: insufficient signer stake` and every ANCHOR archive head is stored '
        + '`unverified`.');
}

// Bound every memory set to the window. Pruning by HEIGHT rather than by
// insertion order is what makes them bounded and exact at once: a height that
// has fallen out of the window is never revisited, so forgetting it costs
// nothing, and nothing inside the window is ever forgotten and re-derived.
function pruneCoveredBlocks(capabilities, from) {
    for (let capability of capabilities) {
        let done = this.coveredBlocks(this._capDerivedBlocks, capability);
        let warned = this.coveredBlocks(this._capWarnedBlocks, capability);
        for (let b of [...done])   if (b < from) done.delete(b);
        for (let b of [...warned]) if (b < from) warned.delete(b);
    }
}

// Newest first, and ALL capabilities at a height before stepping back one: the
// tip is the height the next landed batch, ATTEST or archive head anchors
// nearest, so a cold hub covers everything it needs now before it walks the
// backfill. The cap counts RPC units, so widening the capability list spends no
// more indexer budget per tick than the price-only pass did.
function heightsToCover(capabilities, t, from) {
    let todo = [];
    for (let b = t; b >= from && todo.length < PRICE_CAP_DERIVE_MAX_PER_TICK; b--) {
        for (let capability of capabilities) {
            if (todo.length >= PRICE_CAP_DERIVE_MAX_PER_TICK) break;
            if (!this.coveredBlocks(this._capDerivedBlocks, capability).has(b))
                todo.push({ capability: capability, block: b });
        }
    }
    return todo;
}

// Per-capability tallies, so an operator reading one pass can see WHICH
// capability is stuck rather than a single number that hides three healthy
// ones behind a fourth.
function newPassTally(capabilities) {
    let byCapability = {};
    for (let capability of capabilities)
        byCapability[capability] = { written: 0, rows: 0, empty: 0, failed: 0 };
    return { written: 0, rows: 0, empty: 0, failed: 0, byCapability: byCapability };
}

// Fold one (capability, height) outcome into the pass tally and the coverage sets.
function recordCoverageResult(item, res, pass) {
    let capability = item.capability, block = item.block;
    let tally = pass.byCapability[capability];
    if (res.status === 'written') {
        // Covered: remember it so the next pass spends no RPC on it.
        this.coveredBlocks(this._capDerivedBlocks, capability).add(block);
        this.coveredBlocks(this._capWarnedBlocks, capability).delete(block);
        pass.written += 1;  tally.written += 1;
        pass.rows    += res.rows;  tally.rows += res.rows;
    } else if (res.status === 'empty') {
        // A genuinely empty qualifying set at this height. Nothing to mirror
        // and nothing wrong: the read succeeded, so the height is covered and
        // an off-BTC verifier reading zero rows fails closed, which is the
        // same verdict this hub would reach.
        this.coveredBlocks(this._capDerivedBlocks, capability).add(block);
        pass.empty += 1;  tally.empty += 1;
    } else {
        // 'unresolved', 'truncated' or 'error': NOT covered, so the next pass
        // retries it. The warning fires once per capability per height per
        // process so a stuck indexer names itself without drowning the log
        // every minute.
        pass.failed += 1;  tally.failed += 1;
        let warned = this.coveredBlocks(this._capWarnedBlocks, capability);
        if (!warned.has(block)) {
            warned.add(block);
            logger.warn('PriceAggregator: no `' + capability + '` capability snapshot written at '
                + 'BTC block ' + block + ' (' + res.status + (res.detail ? ': ' + res.detail : '') + '). '
                + 'An action anchored there that needs the `' + capability + '` set will read '
                + '`invalid: insufficient signer stake` (or be stored `unverified`) until this '
                + 'resolves; retrying each pass.');
        }
    }
}

// One line per pass that wrote something, naming which capabilities moved.
function logDerivationPass(capabilities, pass, from, t) {
    if (pass.written > 0) {
        let per = capabilities
            .filter(c => pass.byCapability[c].written > 0)
            .map(c => c + ' ' + pass.byCapability[c].written)
            .join(', ');
        logger.info('PriceAggregator: derived capability snapshots for ' + pass.written
            + ' (capability, BTC block) pair(s) (' + pass.rows + ' rows) in [' + from + ', ' + t + ']'
            + (per ? ' [' + per + ']' : '')
            + (pass.empty ? ', ' + pass.empty + ' pair(s) resolved empty' : '')
            + (pass.failed ? ', ' + pass.failed + ' pair(s) unresolved' : ''));
    }
}

module.exports = {

    // The kill switch. Any value but 'off' (case-insensitive) leaves derivation on,
    // because a hub that silently stops writing these rows is the failure this whole
    // path exists to close: an operator must have to spell the word to lose it.
    priceCapabilityDerivationEnabled() {
        return String(hubConfig.HUB_PRICE_CAPABILITY_DERIVE || '').trim().toLowerCase() !== 'off';
    },

    // True when THIS hub holds a signing identity, the precondition every consensus
    // writer of a capability snapshot has: each of them persists on a path that
    // finalizes, co-signs or publishes under this hub's own key, so a hub that signs
    // nothing can never reach one however many engines its boot built. startP2P sets
    // `identity` from SIGNING_PRIVKEY_HEX BEFORE it constructs the peer manager, and
    // every start*() that builds an engine is awaited after that, so this signal is
    // settled earlier in boot than any engine and closes the boot race on its own.
    hasSigningIdentity() {
        if (!this.hub) return false;
        if (this.hub.identity) return true;
        try {
            if (typeof this.hub.getIdentity === 'function' && this.hub.getIdentity()) return true;
        } catch (e) { /* a hub double without an identity accessor signs nothing */ }
        return false;
    },

    // True when the consensus path ON THIS HUB already writes `capability`'s snapshot,
    // in which case the derivation pass leaves that capability alone.
    //
    // PER CAPABILITY, never one answer for all four. The previous gate asked a single
    // question ("does this hub run oracle consensus?") and answered it from the PEER
    // MANAGER, which made the whole pass disarm on any hub in the mesh. That is exactly
    // the shape the public tier runs: a peer manager so it receives federation frames,
    // no signing key, so no round it sees is ever finalized under its key and NOTHING
    // writes oracle_publish, cross_chain or attestation on it. Those three stayed
    // uncovered on every such hub, which is the ATTEST refusal and the `unverified`
    // ANCHOR archive head the chain-only node measured.
    //
    // Engine presence refines the identity signal rather than replacing it: a validator
    // that holds one capability's writer and not another's derives only the missing one.
    // A spurious derive costs nothing if a slow boot has not yet built an engine: the
    // rows are byte-identical to the consensus writer's and INSERT IGNORE makes either
    // order a no-op for the other (see persistDerivedCapabilitySnapshot).
    runsConsensusFor(capability) {
        if (!this.hub) return false;
        if (!this.hasSigningIdentity()) return false;
        let engines = CAPABILITY_CONSENSUS_ENGINES[capability] || [];
        return engines.some(name => Boolean(this.hub[name]));
    },

    // The `price` question under its original name; XChainHub's arming comment points
    // here for why a validator hub needs no derivation pass.
    runsOracleConsensus() {
        return this.runsConsensusFor('price');
    },

    // The capabilities this hub must derive for itself: every name whose consensus
    // writer does not run here. Empty means the consensus path covers all four and the
    // pass has nothing left to do.
    capabilitiesToDerive() {
        return DERIVED_CAPABILITIES.filter(c => !this.runsConsensusFor(c));
    },

    // Arm the derivation pass. Called from XChainHub.start() unconditionally: the
    // pass itself decides whether this hub needs it, because start() runs BEFORE
    // startP2P/startOracle and cannot yet tell a validator from a standalone hub.
    startPriceCapabilityDerivation() {
        if (this._priceCapDeriveTimer) return false;
        if (!this.priceCapabilityDerivationEnabled()) {
            logger.warn('PriceAggregator: HUB_PRICE_CAPABILITY_DERIVE=off, so this hub will not derive '
                + 'capability snapshots (' + DERIVED_CAPABILITIES.join(', ') + '). For every one of them '
                + 'whose consensus writer does not run here, nothing else writes them: every on-chain '
                + 'PRICE batch and every ATTEST its '
                + 'indexer parses will read `invalid: insufficient signer stake`, and every ANCHOR archive '
                + 'head will be stored `unverified`.');
            return false;
        }
        let intervalS = positiveIntConfig(hubConfig.HUB_PRICE_CAPABILITY_DERIVE_INTERVAL_S,
            PRICE_CAP_DERIVE_INTERVAL_S, 'HUB_PRICE_CAPABILITY_DERIVE_INTERVAL_S');
        // The FIRST pass waits a full interval rather than firing now: start() has not yet
        // been followed by startP2P/startOracle, so a pass at t=0 would run on a validator
        // hub before the signals that identify it exist. See runsOracleConsensus.
        this._priceCapDeriveTimer = setInterval(() => {
            this.runPriceCapabilityDerivation().catch(e => {
                logger.error(nodeUtil.format('PriceAggregator: `price` capability derivation pass failed:',
                    e && e.message ? e.message : e));
            });
        }, intervalS * 1000);
        // Never hold the process open: this is a background repair, not work anyone waits on.
        if (typeof this._priceCapDeriveTimer.unref === 'function') this._priceCapDeriveTimer.unref();
        return true;
    },

    stopPriceCapabilityDerivation() {
        if (this._priceCapDeriveTimer) {
            clearInterval(this._priceCapDeriveTimer);
            this._priceCapDeriveTimer = null;
        }
    },

    // One derivation pass. Resolves the BTC tip, covers the newest uncovered heights in
    // the lookback window, and returns what it did so a test or an operator RPC can read
    // the pass rather than infer it from logs.
    async runPriceCapabilityDerivation() {
        if (this._priceCapDeriveRunning) return { ran: false, reason: 'pass already running' };
        if (!this.priceCapabilityDerivationEnabled()) return { ran: false, reason: 'disabled' };
        // A hub whose consensus path writes EVERY derived capability keeps its existing
        // behaviour exactly: those writers own these rows there, and this pass disarms
        // itself for the process. One covered capability disarms nothing: the pass runs
        // for the rest, which is the whole of
        let capabilities = this.capabilitiesToDerive();
        if (capabilities.length === 0) {
            this.stopPriceCapabilityDerivation();
            return { ran: false, reason: 'hub runs consensus for every derived capability' };
        }

        this._priceCapDeriveRunning = true;
        try {
            let tip = await this.hub._resolveBtcLatestBlock();
            let t   = Number(tip);
            if (!Number.isFinite(t) || t <= 0) {
                warnNoBtcTip();
                return { ran: false, reason: 'no btc tip' };
            }
            t = Math.floor(t);

            let lookback = positiveIntConfig(hubConfig.HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS,
                PRICE_CAP_DERIVE_LOOKBACK_BLOCKS, 'HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS');
            let from = Math.max(0, t - lookback + 1);

            pruneCoveredBlocks.call(this, capabilities, from);
            let todo = heightsToCover.call(this, capabilities, t, from);
            let pass = newPassTally(capabilities);

            for (let item of todo) {
                let res = await this.persistDerivedCapabilitySnapshot(item.capability, item.block);
                recordCoverageResult.call(this, item, res, pass);
            }

            this.priceCapabilityBlocksDerived += pass.written;
            this.priceCapabilityRowsDerived   += pass.rows;
            logDerivationPass(capabilities, pass, from, t);
            return { ran: true, tip: t, from: from, considered: todo.length,
                     written: pass.written, rows: pass.rows, empty: pass.empty, failed: pass.failed,
                     capabilities: capabilities.slice(), byCapability: pass.byCapability };
        } finally {
            this._priceCapDeriveRunning = false;
        }
    },

    // The per-capability height set inside one of the two Maps, created on first use.
    // Split out so the pass, the prune and the tests all reach the same object rather
    // than each re-deriving "does this Map already have a Set for this capability".
    coveredBlocks(map, capability) {
        let set = map.get(capability);
        if (!set) { set = new Set(); map.set(capability, set); }
        return set;
    }

};
