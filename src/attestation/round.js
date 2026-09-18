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
 * XChain Hub - Attestation Round Manager
 *
 * Per-request lifecycle on the validator side of the External Attestation
 * Framework. Unlike OracleRound (wall-clock cadence), AttestationRound is
 * event-driven: it polls the indexer for new ATTEST v0 (request) rows in
 * 'pending' status, decides whether this validator is in the request's
 * responsible set, fetches the payload via the provider module, and gossips
 * an ATTEST_PROPOSE for AttestationConsensus to drive to quorum.
 *
 * Leader / responsible-set selection (spec §8.2):
 *   1. Filter to validators qualifying for `attestation` at the request's
 *      block_index (snapshot via CapabilitySnapshot).
 *   2. Sort by SHA-256(request_id || pubkey) ascending. (Spec calls for
 *      keccak256; SHA-256 has equivalent ordering properties; see plan §1.)
 *   3. Top REDUNDANCY are responsible; lowest-hash is leader.
 *
 ********************************************************************/

const axios  = require('axios');
const wid    = require('../consensus/gates/attest_responsible_widening_gate.js');
// The zero-confirmation flag day. Selects the effective confirmation count for a
// request (confirmationsFor) and carries the boot-time ordering assertion the
// constructor runs; keyed on the REQUEST's own block, never on the tip.
const zc     = require('./attest_zero_conf_gate.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();
// The parts this class is assembled from. Each exports plain methods that are
// installed on the prototype below, so a caller, a stub or a walk over an
// instance sees exactly the class it saw before the split.
const options        = require('./round/options.js');
const poll           = require('./round/poll.js');
const fetchCache     = require('./round/fetch_cache.js');
const leader         = require('./round/leader.js');
const responsibleSet = require('./round/responsible_set.js');
const providerPins   = require('./round/provider_pins.js');
const startRound     = require('./round/start_round.js');
const stats          = require('./round/stats.js');

const ATTEST_PROPOSE = 'ATTEST_PROPOSE';

class AttestationRound {

    constructor(hub, providerRegistry){
        this.hub              = hub;
        this.peerManager      = hub.getPeerManager();
        this.db               = hub.db;
        this.identity         = hub.getIdentity ? hub.getIdentity() : null;
        this.providerRegistry = providerRegistry;
        this.config           = hub.p2pConfig || {};
        this.initRoundState();
        this.initRoundTimings();
        this.initRoundCounters();

        // Boot-time ordering assertion for the zero-confirmation flag day (spec
        // §3.2 a): zero-conf must sit at or above both the mirror and the widening
        // heights, or a request between the heights is served at the tip under rules
        // that still expect the wait, with no headroom behind it. Throws on mainnet
        // and testnet, warns on regtest and standalone; a hub with no network string
        // is standalone and the seam returns without a word. Deliberately NOT caught:
        // a misordered map is a consensus misconfiguration and must stop the boot.
        zc.assertZeroConfOrdering(this.hub && this.hub.network ? this.hub.network : '');
    }

    // The confirmation depth this hub waits before it starts a round for a request
    // admitted at `requestBlock`. Above ATTEST_ZERO_CONF_ACTIVATION it is 0: the hub
    // serves the request the block it is mined in (operator ruling 2026-09-07; the
    // provider spend on a request that later reorgs is an accepted cost of business).
    // Below it, it is the operator's legacy-era ATTESTATION_CONFIRMATIONS tunable.
    //
    // Keyed on the REQUEST's own block rather than the tip, so the rule for a given
    // request is fixed the moment it is admitted and cannot move under it mid-window.
    // Every site that shapes what a peer sees must read THIS and not this.confirmations:
    // the effective count feeds the leader slot and the model index, and two hubs that
    // disagree on it elect different leaders and fetch with different models, which
    // stalls the round on the equivalence check.
    confirmationsFor(requestBlock){
        return zc.isZeroConfActive(requestBlock, this.hub ? this.hub.network : undefined)
            ? 0
            : this.confirmations;
    }

    setConsensus(consensus){
        this.consensus = consensus;
    }

    async start(){
        if(!this.peerManager){
            logger.info('AttestationRound: no peer manager; skipping start');
            return;
        }
        this._pollTimer = setInterval(() => {
            this.pollPending().catch(e => logger.error(nodeUtil.format('AttestationRound: poll error:', e)));
        }, this.pollMs);
        // Kick the first poll without waiting for the interval
        this.pollPending().catch(e => logger.error(nodeUtil.format('AttestationRound: initial poll error:', e)));
        logger.info('AttestationRound: started (poll=' + this.pollMs + 'ms, confirmations=' + this.confirmations + ')');
    }

    async stop(){
        if(this._pollTimer){
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        this.rounds.clear();
        this.seen.clear();
        this.leaderSilence.clear();
        this.pollCursor = null;
        this.observedTip = null;
        this._pollRunning = false;
    }

    // The BTC tip the last successful poll reported, or null. A copy, so a reader
    // cannot move the round's own record.
    getObservedBtcTip(){
        return this.observedTip ? Object.assign({}, this.observedTip) : null;
    }

    async pollPending(){
        if(!this.identity) return;  // observer-only hub; nothing to propose
        // In-flight guard: if a prior poll is still awaiting the
        // indexer, skip this tick rather than stack a concurrent run that races
        // this.pollCursor. The finally clears the flag across every early return.
        if(this._pollRunning) return;
        this._pollRunning = true;
        try {
        let url = await this.resolveBtcIndexerUrl();
        if(!url) return;

        // Drop `seen` entries older than the retry window so transiently-skipped
        // requests can be re-evaluated once their blocking condition clears.
        this.evictStaleSeen();

        // Same window, durable half: drop recorded fetches whose
        // retry window has lapsed so the table cannot grow with request volume.
        await this.evictStaleFetchCache();

        // Drop `rounds` entries older than the round TTL so completed/abandoned
        // round state doesn't accumulate for the process lifetime.
        this.evictStaleRounds();

        // Same TTL, same reason, for the per-request leader-silence observation.
        this.evictStaleLeaderSilence();

        let params = this.pollPageParams();

        let res;
        try {
            res = await axios.post(url, {
                jsonrpc: '2.0', id: Date.now(),
                method:  'getpendingattestation_requests',
                params:  params
            }, { headers: this.hub.btcIndexerHeaders(), timeout: 5000 });
        } catch (e) {
            this.notePollFailure(e, url);
            return;
        }

        this.admitPendingPage(res, url);
        } finally {
            this._pollRunning = false;
        }
    }

    async resolveBtcIndexerUrl(){
        if(typeof this.hub.resolveBtcIndexerUrl === 'function'){
            return await this.hub.resolveBtcIndexerUrl();
        }
        return null;
    }
}

// The parts are installed as NON-ENUMERABLE prototype methods, the descriptor a
// class body gives its own, so the split cannot change what a for-in walk, a deep
// compare or a sinon stub over an instance sees.
for (const part of [options, poll, fetchCache, leader, responsibleSet, providerPins, startRound, stats]) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(part))) {
        Object.defineProperty(AttestationRound.prototype, name, Object.assign(descriptor, { enumerable: false }));
    }
}

module.exports = Object.assign(AttestationRound, {
    ATTEST_PROPOSE
});

