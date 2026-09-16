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
 * XChain Hub - ROLLCALL round (validator liveness presence proof)
 *
 * Every validator signs a canonical bound to a BITCOIN epoch block's
 * `ledger_hash`, gossips the signature, and an elected leader lands the
 * collected signatures on DOGECOIN as a ROLLCALL action. The BTC indexer closes
 * the epoch, proves the DOGE roll call, and evicts sources that were absent for
 * K consecutive rolled epochs.
 *
 * Binding the message to `ledger_hash(E)` is the whole liveness claim: it cannot
 * be signed before the epoch block is mined, so a valid signature shows the key
 * was operating with a synced view of BTC inside the accept window. A pre-signed
 * stack of future heartbeats is impossible.
 *
 * NOTHING HERE IS CONSENSUS. This engine decides only WHEN and BY WHOM an action
 * is published. Which signatures count, which epochs exist, who is absent and
 * who is evicted is decided BTC-side at the epoch close, which re-verifies every
 * signature against its OWN ledger_hash. So the hub applies no stake floor and
 * computes no quorum: it verifies each signature cryptographically, keeps the
 * signers that are in its own whole-federation snapshot, and stops. Its set is
 * advisory and a superset of the chain's responsible set.
 *
 * Shape borrowed, deliberately, from two neighbours:
 *   - FullNodeChallengeRound: the sign-and-gossip skeleton, the abstain-on-
 *     unresolved-snapshot branch, and the durable spend-intent record that makes
 *     a restart unable to double-publish.
 *   - StateAnchorPublisher: hashOrder election, the rank-unlock failover ladder,
 *     SpendGuard, the DOGE_LOW_BALANCE_THRESHOLD floor, and the borrowed DOGE
 *     signer (resolveSigner).
 *
 * FOUR PUBLISH ROLES, one job each:
 *   rank 0 (leader)  publishes EVERY rolled epoch; the publish reward attaches
 *                    to it and to nobody else, so this is the rational policy
 *                    and not an "on demand" one that no chain rule could enforce.
 *   ranks 1..n       sweepers, unlocking one ROLLCALL_ELECTION_TOLERANCE_BLOCKS
 *                    apart, publishing only what the ranks before them left out.
 *                    This is the LIVENESS failover: a dead or censoring leader
 *                    costs the epoch nothing while one honest eligible hub is up,
 *                    and it is why a validator with no DOGE wallet still gets
 *                    rolled.
 *   self-publish     a hub whose OWN signature is not on chain by
 *                    E + ROLLCALL_SELF_PUBLISH_BLOCKS lands a one-signature roll
 *                    call itself. This is the CENSORSHIP escape hatch, not the
 *                    liveness failover.
 *
 * An inert federation (no elected key whose hub can publish, or every publisher
 * wallet under the balance floor) publishes nothing: every epoch closes unrolled,
 * nobody is evicted, and the unrolled-epochs monitor is the detector. That is
 * correct behaviour, not an error path.
 *
 * TWO WIRE FORMS, chosen by the EPOCH height. At or above
 * ROLLCALL_GATES_ACTIVATION an epoch is published as ROLLCALL v1, carrying a
 * GATES field (this build's knownGateKeys(), comma-joined) that the canonical
 * commits to as sha256(GATES); below it, v0 exactly as before. Signers sign over
 * the PUBLISHER's list, so a validator whose build knows a different list signs
 * different bytes and is recorded absent for that epoch: roll the fleet BETWEEN
 * epochs, never across one.
 *
 * A ROLLCALL is always a two-phase P2SH publish (the header alone is past the
 * 80-byte OP_RETURN limit), and the built-in encoder pipeline fails closed on
 * P2SH, so this engine publishes ONLY through a signer module that exports
 * `broadcast(payload)`. A hand-built module exporting just `walletSign` can sign
 * roll calls and never publish one; `getrollcallstatus.broadcast_capable` and the
 * oracle_publish self-test both say so rather than leaving it silent.
 *
 ********************************************************************/

'use strict';

const axios = require('axios');

const EncoderClient              = require('../peers/encoder_client.js');
const SpendGuard                 = require('../lib/spend_guard.js');
const rca                        = require('../consensus/gates/rollcall_gate.js');
const rga                        = require('../consensus/gates/rollcall_gates_gate.js');
const { knownGateKeys }          = require('../consensus_rules_digest.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

// One part per job, each an object of methods installed on
// RollcallRound.prototype below. The class file keeps the construction, the
// lifecycle, the GATES field and the two indexer transports.
const wirePart     = require('./round/wire.js');
const epochPart    = require('./round/epoch.js');
const gossipPart   = require('./round/gossip.js');
const electionPart = require('./round/election.js');
const publishPart  = require('./round/publish.js');
const railPart     = require('./round/doge_rail.js');
const recordsPart  = require('./round/records.js');
const { MAX_PAIRS_PER_ACTION, ACTION_DATA_CEILING, BYTES_PER_PAIR, XROLLCALL_SIGN } = wirePart;

// Per-network defaults for the three publish tunables. These are hub POLICY, not
// consensus: no §3.3/§3.4 chain rule reads any of them, which is why they live
// here and in CONFIGURATION.md rather than in rollcall_gate.js beside the
// values that decide what the ledger says.
//
// The ordering PUBLISH_DELAY < SELF_PUBLISH < ACCEPT_WINDOW - 24 is the part
// that binds (pinned by test/unit/rollcall/rollcall_round_invariants.test.js): the 24 BTC
// blocks of margin cover the DOGE landing plus the two-hour miner timestamp
// slack, so a self-publish issued at the last moment still lands inside the
// accept window instead of arriving after the chain has stopped counting.
const PUBLISH_DELAY_DEFAULTS      = { mainnet: 12,  testnet: 12,  regtest: 1 };
// A SEPARATE knob from ANCHOR_ELECTION_TOLERANCE_BLOCKS on purpose: the two
// ladders climb against different anchors, and sharing one env would mean a
// roll-call cadence change could silently re-inert the anchor ladder.
const ELECTION_TOLERANCE_DEFAULTS = { mainnet: 36,  testnet: 36,  regtest: 3 };
// The regtest pair is 3 and 9, not the spec's first-draft 2 and 6, and the
// reason is that 6 collides with CANONICAL_REORG_BUFFER. A round cannot exist
// before tip - E >= 6, so at the very first tick a self-publish deadline of 6
// has ALREADY passed: every non-leader would self-publish immediately, the
// sweeper path would never run, and the rank ladder would never demonstrate
// the failover it exists to provide. Correctness is untouched either way (the
// union rule absorbs a duplicate), but the acceptance venue would be unable to
// show a sweeper filling a gap, which is one of the things it has to show. At
// 3 and 9 the first tick has ranks 0-1 unlocked and the deadline three blocks
// out, so sweep happens first and self-publish is the fallback it is meant to
// be. These are hub policy, not consensus: no chain rule reads them.
const SELF_PUBLISH_DEFAULTS       = { mainnet: 100, testnet: 100, regtest: 9 };

class RollcallRound {

    constructor(hub){
        this.hub  = hub;
        let cfg   = (hub && hub.p2pConfig) || {};
        this.cfg  = cfg;
        this.peerManager        = hub && hub.peerManager;
        this.identity           = hub && hub.identity;
        this.capabilitySnapshot = hub && hub.capabilitySnapshot;
        this.network            = (hub && hub.network) || cfg.HUB_NETWORK || '';

        // CONSENSUS constants come from the byte-identical twin of the indexer's
        // rollcall_gate.js and have no env surface at all. Reading any of
        // them from the environment would let one hub sign for epochs another
        // hub does not believe exist.
        this.interval     = rca.ROLLCALL_INTERVAL_BLOCKS[this.network];
        this.acceptWindow = rca.ROLLCALL_ACCEPT_WINDOW_BLOCKS[this.network];

        // Operational knobs: this hub's own timing and participation only.
        this.enabled = String(hubConfig.ROLLCALL_ENABLED || cfg.ROLLCALL_ENABLED || 'true') !== 'false';
        this.pollMs  = parseInt(hubConfig.ROLLCALL_POLL_MS || cfg.ROLLCALL_POLL_MS || '30000');

        this.publishDelayBlocks      = this.resolveTunable('ROLLCALL_PUBLISH_DELAY_BLOCKS',      PUBLISH_DELAY_DEFAULTS);
        this.electionToleranceBlocks = this.resolveTunable('ROLLCALL_ELECTION_TOLERANCE_BLOCKS', ELECTION_TOLERANCE_DEFAULTS);
        this.selfPublishBlocks       = this.resolveTunable('ROLLCALL_SELF_PUBLISH_BLOCKS',       SELF_PUBLISH_DEFAULTS);

        // BTC indexer (ledger_hash + tip) and DOGE indexer (what is already on
        // chain for the epoch). Same env surface the rest of the hub uses.
        this.indexerUrl = hubConfig.BTC_INDEXER_URL || cfg.BTC_INDEXER_URL || '';
        this.indexerKey = hubConfig.BTC_INDEXER_API_KEY || cfg.BTC_INDEXER_API_KEY || '';
        this.dogeIndexerUrl = hubConfig.DOGE_INDEXER_API_URL || hubConfig.DOGE_INDEXER_URL ||
                              cfg.DOGE_INDEXER_URL || '';
        this.dogeIndexerKey = hubConfig.DOGE_INDEXER_API_KEY || cfg.DOGE_INDEXER_API_KEY || '';


        initPublishRail(this, cfg);
        initRoundState(this);
    }

    // Env, then p2pConfig, then the per-network default. Garbage or a negative
    // value falls back to the default rather than disabling the gate it feeds:
    // a NaN publish delay would compare false forever and publish nothing, which
    // is exactly the silent inertness this engine must not have.
    resolveTunable(name, defaults){
        let fallback = defaults[this.network];
        if(!Number.isFinite(fallback)) fallback = defaults.mainnet;
        let env = hubConfig.env();
        let raw = env[name] !== undefined ? env[name] : this.cfg[name];
        if(raw === undefined || raw === null || raw === '') return fallback;
        let n = parseInt(raw, 10);
        if(!Number.isFinite(n) || n < 0){
            logger.warn('RollcallRound: ' + name + ' "' + raw + '" is not a non-negative integer; ' +
                         'using the ' + this.network + ' default (' + fallback + ')');
            return fallback;
        }
        return n;
    }

    // Standard publisher setters, so signer-loader's applySignerHooks wires this
    // engine exactly as it wires the price and anchor publishers.
    setBroadcastHook(fn){  this.broadcastFn  = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setBalanceHook(fn){    this.getBalanceFn = fn; }
    setEncoder(enc){       this.encoder      = enc; }

    async start(){
        if(!this.enabled){
            logger.info('RollcallRound: disabled');
            return;
        }
        if(!Number.isFinite(this.interval) || this.interval <= 0){
            logger.warn('RollcallRound: no ROLLCALL_INTERVAL_BLOCKS for network ' +
                         JSON.stringify(this.network) + '; the engine stays idle');
            return;
        }
        // Do not start on a network whose activation height is the INERT
        // placeholder. Every epoch would fail isRollcallActive and the tick would
        // do nothing, but it would still poll the BTC indexer forever, and on a
        // hub with no BTC indexer configured (which is every mainnet hub today,
        // since nothing there needs one yet) each of those polls throws and logs.
        // A feature the operator has not armed should cost nothing and say
        // nothing, not emit a recurring warning that reads as a fault.
        let armedAt = rca.ROLLCALL_ACTIVATION[this.network];
        if(!Number.isFinite(armedAt)){
            logger.info('RollcallRound: inert on ' + JSON.stringify(this.network) +
                        ' (no activation height set); the engine stays idle');
            return;
        }
        if(this.peerManager) this.peerManager.on('message', this._handler);
        // Both logs must be consumed BEFORE the first tick: the recovered epochs
        // gate the very round that tick reconstructs.
        this.loadSignLog();
        this.loadSpendLog();
        this.spendGuard.persistTo();
        let tick = async () => {
            try { await this.tick(); }
            catch(e){ logger.warn(nodeUtil.format('RollcallRound tick:', e && e.message ? e.message : e)); }
        };
        this._timer = setInterval(tick, this.pollMs);
        await tick();
        logger.info('RollcallRound started (interval=' + this.interval + ' blocks, window=' + this.acceptWindow +
                    ', publish delay=' + this.publishDelayBlocks + ', ladder step=' + this.electionToleranceBlocks +
                    ', self-publish=' + this.selfPublishBlocks +
                    ', broadcast=' + (this.broadcastCapable() ? 'yes' : 'NO (sign-and-gossip only)') + ', ' +
                    this._signatures.size + ' signature(s) recovered)');
    }

    async stop(){
        if(this._timer) clearInterval(this._timer);
        this._timer = null;
        if(this.peerManager) this.peerManager.removeListener('message', this._handler);
    }

    // ── canonical + wire ─────────────────────────────────────────────────────

    // The GATES field this hub publishes for `epochHeight`, or null below
    // ROLLCALL_GATES_ACTIVATION (a v0 epoch). The list is what THIS build knows,
    // active or not, so a signer's list stays a true superset comparand at any
    // later request block; the sorted comma-joined form is the wire field and the
    // canonical hashes it.
    gatesFor(epochHeight){
        if(!rga.isRollcallGatesActive(epochHeight, this.network)) return null;
        return knownGateKeys().join(',');
    }

    // ── indexer transports ───────────────────────────────────────────────────

    async indexerCall(method, params){
        let url = this.indexerUrl;
        if(this.hub && typeof this.hub.resolveBtcIndexerUrl === 'function'){
            try { url = (await this.hub.resolveBtcIndexerUrl()) || this.indexerUrl; } catch(_){}
        }
        if(!url) throw new Error('no BTC indexer URL (set BTC_INDEXER_API_URL / BTC_INDEXER_URL)');
        let headers = (this.hub && typeof this.hub.btcIndexerHeaders === 'function')
            ? this.hub.btcIndexerHeaders()
            : Object.assign({ 'Content-Type': 'application/json' }, this.indexerKey ? { 'x-api-key': this.indexerKey } : {});
        let resp = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        let result = resp.data ? resp.data.result : null;
        // The indexer reports failures in-band as result.error (a 200 carrying an
        // error object), not the JSON-RPC envelope, so gate on it here or a poll
        // error is returned as a valid result.
        if(result && result.error) throw new Error('indexer in-band error: ' + JSON.stringify(result.error));
        return result;
    }

    async dogeIndexerCall(method, params){
        if(!this.dogeIndexerUrl) throw new Error('no DOGE indexer URL (set DOGE_INDEXER_API_URL / DOGE_INDEXER_URL)');
        let headers = { 'Content-Type': 'application/json' };
        if(this.dogeIndexerKey) headers['x-api-key'] = this.dogeIndexerKey;
        let resp = await axios.post(this.dogeIndexerUrl, { jsonrpc: '2.0', method, params: params || {}, id: 1 },
                                    { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        let result = resp.data ? resp.data.result : null;
        if(result && result.error) throw new Error('indexer in-band error: ' + JSON.stringify(result.error));
        return result;
    }
}

// The DOGE publish rail and the two durable logs, in a function rather than
// constructor lines so the constructor stays inside the readability limit.
function initPublishRail(self, cfg){
    // DOGE publish rail, identical to the anchor rail's: same address, same
    // encoder, same balance floor. Hooks left null here are borrowed from the
    // price publisher at send time (resolveSigner).
    self.dogeAddress = hubConfig.DOGE_ADDRESS || cfg.DOGE_ADDRESS || '';
    let encoderUrl   = hubConfig.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
    let encoderKey   = hubConfig.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
    self.encoder     = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;
    self.broadcastFn  = null;
    self.walletSignFn = null;
    self.getBalanceFn = null;

    self.lowBalanceThreshold = parseFloat(hubConfig.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');
    self.spendGuard = new SpendGuard('ROLLCALL', cfg, 'RollcallRound');
    self.spendGuard.minBalance = self.lowBalanceThreshold;

    // Durable spend audit for the fee-bearing publish, the shape every other
    // hub effector uses. The intent line is written and fsync'd BEFORE the
    // money moves and the broadcast is gated on it, so a crash mid-flight
    // still leaves a recoverable trace that DOGE may have been spent.
    self.spendLogPath = hubConfig.ROLLCALL_SPEND_LOG_PATH || cfg.ROLLCALL_SPEND_LOG_PATH ||
                        './data/rollcall-publish.spend.jsonl';
    // Durable signature store. A restart inside the accept window must
    // re-emit the SAME signature rather than mint a second one: the epoch's
    // ledger_hash is fixed, so a fresh signature would be redundant gossip,
    // and a hub whose indexer has gone dark since would otherwise fall silent
    // for an epoch it had already answered.
    self.signLogPath = hubConfig.ROLLCALL_SIGN_LOG_PATH || cfg.ROLLCALL_SIGN_LOG_PATH ||
                       './data/rollcall-signatures.jsonl';
}

// The empty round state a fresh engine starts from, and the one gossip handler
// binding the peer manager is given at start().
function initRoundState(self){
    self.rounds       = new Map();   // epoch -> round state
    self._signatures  = new Map();   // epoch -> { ledgerHash, sig } recovered from disk
    // Gossip that arrived for an epoch this hub has not opened yet. A peer
    // broadcasts its signature ONCE, when it signs, and never again; a hub
    // that ticks later would otherwise lose every earlier signer for good
    // and lead with a partial set. Drained into the round when it opens.
    self._earlySigs   = new Map();   // epoch -> Map(pubkey -> sig)
    // Epochs whose publish fee a PRIOR process already committed, and the
    // separate self-publish commitments. The rounds map is empty after a
    // restart, so it cannot answer either question.
    self._committed     = new Set();  // key: <epoch> | <epoch>:self
    self._timer         = null;
    self._ticking       = false;
    self._loggedNoBroadcast = false;
    self._handler       = (env) => self.handleMessage(env);
}


// The parts go on with enumerable false, NOT Object.assign, for the reason
// src/db/index.js gives at its own install: class methods are non-enumerable, so
// assigned members would be the only ones for...in and Object.keys(prototype) can
// see, which changes what the prototype enumerates. writable and configurable stay
// true so a test can still stub and restore a moved method. The size statics go on
// the class the same way, where they have always been read from.
function installParts(target, parts) {
    for(const part of parts) {
        const descriptors = {};
        for(const name of Object.keys(part)) {
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate rollcall method: ' + name + ' is already defined on ' +
                    'RollcallRound. Two parts, or a part and the class, claim the same name.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

wirePart.bindRoundClass(RollcallRound);
installParts(RollcallRound.prototype, [wirePart.methods, epochPart, gossipPart, electionPart,
                                       publishPart, railPart, recordsPart]);
installParts(RollcallRound, [wirePart.statics]);

module.exports = Object.assign(RollcallRound, {
    XROLLCALL_SIGN,
    MAX_PAIRS_PER_ACTION,
    ACTION_DATA_CEILING,
    BYTES_PER_PAIR,
    PUBLISH_DELAY_DEFAULTS,
    ELECTION_TOLERANCE_DEFAULTS,
    SELF_PUBLISH_DEFAULTS
});
