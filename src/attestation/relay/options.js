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
 * XChain Hub - Attestation cross-chain relay: construction
 *
 * The relay's constructor in named steps, called in the order the fields were
 * assigned before the split so an instance carries the same properties in the same
 * order. Each takes the relay as `self` and the resolved p2p config, and they are
 * plain functions rather than prototype methods: nothing outside construction may
 * call them.
 *
 ********************************************************************/

'use strict';

const EncoderClient          = require('../../peers/encoder_client.js');
const SpendGuard             = require('../../lib/spend_guard.js');
const CrossChainDexConsensus = require('../../cross_chain/dex_consensus.js');
const { AtMostOnce } = require('../../lib/idempotent_broadcast.js');
const coins     = require('../../coins');
const hubConfig = require('../../config');
const { HOME_CHAIN, ORIGIN_CHAINS, DEFAULT_POLL_MS, DEFAULT_FAILOVER_WINDOW_MS,
        DEFAULT_EVICTION_GRACE_BLOCKS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// The opt-in switch, the poll and failover cadences, the eviction grace and the
// per-coin indexer endpoints.
function initRelayPolling(self, cfg){
    // Opt-in, not a kill switch: a fleet that has merely DEPLOYED this code must
    // run nothing at all. See the deploy-order note in the header of src/attestation/relay.js.
    self.enabled = String(hubConfig.ATTEST_RELAY_ENABLED || cfg.ATTEST_RELAY_ENABLED || '0') === '1';

    self.pollMs = parseInt(hubConfig.ATTEST_RELAY_POLL_MS || cfg.ATTEST_RELAY_POLL_MS || DEFAULT_POLL_MS);

    // Per-chain confirmation depth, shared with the swap/XCALL engines so an
    // operator tunes ONE depth per chain (mainnet floor-clamped).
    self.confirmations = coins.resolveConfirmations(cfg, self.network);

    self.failoverWindowMs = parseInt(hubConfig.ATTEST_RELAY_FAILOVER_MS ||
                                     cfg.ATTEST_RELAY_FAILOVER_MS || DEFAULT_FAILOVER_WINDOW_MS);

    // Origin blocks past a request's deadline before its records are evicted.
    // A garbage or negative value falls back rather than shrinking the
    // window: this is the guard that stops an early eviction from re-spending.
    self.evictGraceBlocks = parseInt(hubConfig.ATTEST_RELAY_EVICT_GRACE_BLOCKS ||
                                     cfg.ATTEST_RELAY_EVICT_GRACE_BLOCKS || DEFAULT_EVICTION_GRACE_BLOCKS);
    if(!Number.isFinite(self.evictGraceBlocks) || self.evictGraceBlocks < 0)
        self.evictGraceBlocks = DEFAULT_EVICTION_GRACE_BLOCKS;

    // Per-coin indexer endpoints; filled from the hub's configs-aware resolver
    // in start() for hubs provisioned without env vars.
    self.indexers = {};
    for(let coin of [HOME_CHAIN, ...ORIGIN_CHAINS]){
        self.indexers[coin] = {
            url: process.env[coin + '_INDEXER_API_URL'] || process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
            key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
        };
    }
}

// The home (BTC) broadcast rail, the per-origin rails and the spend guard.
function initRelayRails(self, cfg){
    // BTC (home) broadcast rail, for the v3 request leg. Mirrors
    // AttestationPublisher: an operator signer hook wins, otherwise the
    // encoder + wallet-sign pipeline.
    let encoderUrl = hubConfig.BTC_ENCODER_URL || cfg.BTC_ENCODER_URL || '';
    let encoderKey = hubConfig.BTC_ENCODER_API_KEY || cfg.BTC_ENCODER_API_KEY || '';
    self.encoder      = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;
    self.btcAddress   = hubConfig.BTC_ADDRESS    || cfg.BTC_ADDRESS    || '';
    self.btcPubkeyHex = hubConfig.BTC_PUBKEY_HEX || cfg.BTC_PUBKEY_HEX || '';
    self.broadcastFn  = null;
    self.walletSignFn = null;

    // ORIGIN-chain broadcast rails, for the v4 response leg. Every other hub
    // publisher is single-chain (the oracle publishes on DOGE, the attestation
    // publisher on BTC), so this is the first rail that has to pick a chain at
    // send time, and it is deliberately kept SEPARATE from the home rail rather
    // than generalized over it. An operator's HUB_SIGNER_MODULE broadcast hook
    // does its own build/sign/send on the ONE chain it was configured for; handing
    // it an LTC payload would put a v4 on BTC, where it is rejected outright
    // ('relay responses land on origin chains only') after burning a real BTC fee.
    // So the home hooks never serve an origin chain: an origin rail exists only
    // where the operator configured <COIN>_ENCODER_URL + <COIN>_ADDRESS, or wired
    // setChainBroadcastHook(coin, fn) explicitly.
    //
    // The wallet-sign hook DOES fall back to the shared one, because signing is
    // chain-agnostic in shape and the config above is already the explicit opt-in.
    // It is called as fn(psbtHex, coin) so a multi-chain operator module can pick
    // the right key; a single-key module ignores the argument and produces a
    // signature the origin node rejects, which surfaces as an 'Encoder RPC error'
    // and is therefore classified NOT ambiguous and stays retryable.
    self.chainRails = {};
    for(let coin of ORIGIN_CHAINS){
        let url = process.env[coin + '_ENCODER_URL'] || cfg[coin + '_ENCODER_URL'] || '';
        let key = process.env[coin + '_ENCODER_API_KEY'] || cfg[coin + '_ENCODER_API_KEY'] || '';
        self.chainRails[coin] = {
            encoder:      url ? new EncoderClient(url, key) : null,
            address:      process.env[coin + '_ADDRESS']    || cfg[coin + '_ADDRESS']    || '',
            pubkeyHex:    process.env[coin + '_PUBKEY_HEX'] || cfg[coin + '_PUBKEY_HEX'] || '',
            broadcastFn:  null,
            walletSignFn: null
        };
    }

    self.spendGuard = new SpendGuard('ATTEST_RELAY', cfg, 'AttestationRelay');
}

// The WAL path and the per-leg at-most-once and in-flight sets.
function initRelayAtMostOnce(self, cfg){
    // Durable at-most-once record of v3 broadcasts. A duplicate v3 is rejected
    // on-chain ('REQUEST_ID already present'), so replaying one only burns a real
    // BTC fee; the WAL is what stops a restart from doing that. See loadWal for
    // why a crash between intent and outcome is treated as sent.
    self.walPath   = hubConfig.ATTEST_RELAY_QUEUE_PATH || cfg.ATTEST_RELAY_QUEUE_PATH || './data/attest-relay-queue.jsonl';
    self._published = new AtMostOnce();

    // The response leg's own at-most-once set. Idempotency keys on
    // (request_id, phase), so the two legs never share a slot: one request_id
    // legitimately gets one v3 AND one v4.
    self._publishedResponses = new AtMostOnce();

    // Rounds finalized but not yet observed on their destination chain:
    // request_id -> { wire, rid, coin, phase, finalizedAt, rank }. Drives the
    // rank-ordered failover step-in. One map per leg, same reason as above.
    self._finalizedWire     = new Map();
    self._finalizedResponse = new Map();

    // Round ids in PBFT but not yet finalized (mirrors CrossChainCallEngine).
    self._inflight = new Set();

    // request_ids currently present in the home chain's pending queue, refreshed
    // once per poll: a v3 that lands shows up here immediately.
    self._homePending = new Set();

    // request_ids the home chain holds as a materialized relay leg at ANY status,
    // from the relayed-requests read. This is the authoritative "already
    // materialized" answer and _homePending is the narrower one: a fulfilled or
    // expired BTC row leaves the pending queue while the ORIGIN row stays pending
    // until the v4 lands, and on the pending view alone that window reads as never
    // materialized and draws a duplicate v3 (rejected on chain, fee spent). Both
    // are kept and OR'd because each is refreshed independently and each fails
    // closed by retaining its previous value, so either surviving a failed read
    // still suppresses the duplicate.
    //
    // ANY status EXCEPT a refusal, once ATTEST_RELAY_REJECT_SLOT is armed: a
    // refused row names a request that was never materialized. See
    // withoutRefusedRows for why that exclusion had to wait for the arm.
    self._homeRelayed = new Set();
}

// The per-origin pending views and the deadline index eviction measures against.
function initRelayViews(self){
    // Per-origin pending views, request_id -> row, same role for the response leg:
    // a v4 that lands flips its origin request out of 'pending', so this is the
    // authoritative "already relayed back" signal and it also catches a PEER's
    // broadcast. The rows are kept, not just the ids, so the leg can be checked
    // against the ORIGIN's own copy of the request before a round is proposed.
    // null means "not refreshed this tick": that chain's response leg is then
    // skipped entirely rather than acted on blind.
    self._originPending = {};
    for(let coin of ORIGIN_CHAINS) self._originPending[coin] = null;

    // request_id -> { coin, block }: the ABSOLUTE deadline_block of the
    // origin request behind a leg, on the chain that issued it. This is what the
    // at-most-once sets are evicted against, and it is deliberately keyed on the
    // request rather than on (leg, request): one request has ONE origin deadline,
    // and when it passes, both of its legs are equally dead.
    self._deadlines = new Map();

    // Last tip observed on each origin chain, from the same paged read the pending
    // views come from. Only ever written from a SUCCESSFUL read: an unread chain
    // must stall eviction, never advance it.
    self._originLatest = {};
}

// The PBFT rail both legs run on, and the two round outcomes it reports.
function initRelayConsensus(self){
    self.consensus = new CrossChainDexConsensus(self, {
        messageTypes: {
            PROPOSE:     'ATTEST_RELAY_PROPOSE',
            PREPARE:     'ATTEST_RELAY_PREPARE',
            COMMIT:      'ATTEST_RELAY_COMMIT',
            VIEW_CHANGE: 'ATTEST_RELAY_VIEW_CHANGE',
            NEW_VIEW:    'ATTEST_RELAY_NEW_VIEW',
            FINAL_SYNC:  'ATTEST_RELAY_FINAL_SYNC'
        },
        controlTags: { vc: 'ATTRELAYVC', nv: 'ATTRELAYNV' },
        idField: 'round_id'
    });
    self.consensus.on('match:finalized', (ev) => {
        self.onRoundFinalized(ev).catch(err =>
            logger.error('AttestationRelay: finalize handler error: ' + (err && err.message)));
    });
    // An abandoned round must release its inflight slot or the request wedges:
    // the poll's inflight guard would skip it forever.
    self.consensus.on('match:abandoned', (ev) => {
        self._inflight.delete(String(ev.matchId));
    });
}

module.exports = {
    initRelayPolling,
    initRelayRails,
    initRelayAtMostOnce,
    initRelayViews,
    initRelayConsensus
};
