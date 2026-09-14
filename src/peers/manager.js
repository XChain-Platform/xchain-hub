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
 * XChain Hub - P2P Gossip Layer
 *
 * Maintains WebSocket connections to peer validators and provides
 * message broadcast, relay, and deduplication. Higher layers (PBFT,
 * oracle) subscribe to events emitted by this class.
 *
 ********************************************************************/

const EventEmitter     = require('events');
const coins            = require('../coins');
const { positiveIntConfig } = require('../lib/config_int.js');
// The roster below credits RollcallRound only where the engine would really start,
// so it reads the engine's own activation source rather than a copy of it.
const rollcallActivation = require('../rollcall_activation.js');
const PeerConnections = require('./gossip/connections.js');
const PeerMessages    = require('./gossip/messages.js');
const PeerInbound     = require('./gossip/inbound.js');
const PeerRules       = require('./gossip/rules.js');
const PeerUpkeep      = require('./gossip/upkeep.js');

// Bootstrap peers every new hub can reach. One hostname per validator; the
// PORT selects the network, so a seed on the wrong port reaches the wrong
// federation. Hostnames, not IPs, so a validator can move boxes.
const BOOTSTRAP_VALIDATOR_HOSTS = [
    'validator01.xchain.io', 'validator02.xchain.io', 'validator03.xchain.io',
    'validator04.xchain.io', 'validator05.xchain.io'
];
const BOOTSTRAP_PORT_BY_NETWORK = { mainnet: 10001, testnet: 10002 };

// The two request shapes the read-only mirror feed occupies on the P2P port. They
// MUST stay byte-identical to what the API server mounts (api.js
// '/hub-db/snapshot' routes, '/hub-db/subscribe' upgrade) and to what the indexer
// asks for (xchain-indexer src/hub/hub_db_sync.js _httpGet / _connectWebSocket): the
// same client code reaches a validator over this port and a private hub over the
// API port, so a path that differs on one side silently disables the mirror.
const FEED_SNAPSHOT_PREFIX = '/hub-db/snapshot';
const FEED_SUBSCRIBE_PATH  = '/hub-db/subscribe';

// Every SUBSCRIPTION to the PeerManager 'message' fan-out that a full boot creates,
// one entry each. The ceiling below is derived from this roster instead of being a
// hand-picked number, so it cannot drift away from what actually subscribes;
// peer_manager_listener_ceiling.test.js re-derives the roster from the sources and
// fails when the two disagree.
//
// Most entries are a bare module name, because most subscribers are singletons and
// their module registers exactly one handler. CrossChainDexConsensus is not: it is a
// parameterized PBFT channel and the hub boots one instance per round family, so its
// extra channels are named `<module>:<channel>` and each one is a listener of its own.
// peer_manager_listener_ceiling.test.js recovers the module from an entry by splitting on
// the first ':' when it compares the roster against the sources.
//
// Two of the subscribers are a CONFIGURATION question rather than a constant, so the
// roster is computed per hub (messageSubscribers below) instead of being one frozen
// list: RollcallRound attaches nothing on a network with no activation height and one
// listener wherever a height is set, and the relay's PBFT channel exists only when
// ATTEST_RELAY_ENABLED is on. A roster that guessed either way is wrong on some real
// hub, and because the ceiling IS the roster length, a roster one short of what
// attaches turns the MaxListenersExceededWarning permanently on, which is the
// condition the per-hub roster exists to prevent.
//
// The subscribers here attach at every boot that reaches their start(): nothing in
// the configuration removes one.
const UNCONDITIONAL_SUBSCRIBERS = Object.freeze([
    'AttestationBatchPublisher', 'AttestationConsensus', 'AttestationResponseMirror',
    'Consensus', 'CrossChainDexConsensus',
    'CrossChainDexConsensus:XBRIDGE_TRANSFER', 'CrossChainDexConsensus:XCALL_RELAY',
    'CrossChainDexConsensus:XPOLICY_SNAPSHOT',
    'CrossChainEngine', 'FullNodeChallengeRound',
    'Governance', 'OracleBatchSigner', 'OracleConsensus', 'OracleRound', 'ReorgHandler',
    'RetractionConsensus', 'StateAnchorPublisher', 'StateCheckpointEngine'
]);

// Does RollcallRound reach the fan-out registration in its start()? Three gates come
// first (RollcallRound.js start()), and this reads those same three inputs from the
// same places, so the credit follows the engine rather than a copy of its rules:
// ROLLCALL_ENABLED not switched off, a cadence for the network, and an activation
// height for it (mainnet and testnet carry one, regtest only when the venue arms it
// via XC_ROLLCALL_REGTEST_ACTIVATION).
//
// Written without the registration call spelled out, deliberately: the source-parity
// derivation in peer_manager_listener_ceiling.test.js scans these files for that call
// and would read a comment quoting it as a subscriber PeerManager itself registers.
//
// An unresolvable network is CREDITED, not skipped. PeerManager sees only its own
// config, while the engine resolves the network from `hub.network`, which XChainHub
// will also take from opts.network. A hub whose p2p config names no network may still
// be running on one this PeerManager cannot see, and may therefore start the engine.
// Over-counting there costs a softer leak signal on a hub nobody named a network for;
// under-counting costs the warning on every boot of a live one.
function rollcallRoundAttaches(config, env) {
    const cfg = config || {};
    if (String(env.ROLLCALL_ENABLED || cfg.ROLLCALL_ENABLED || 'true') === 'false') return false;
    const network = String(cfg.HUB_NETWORK || '');
    if (!network) return true;
    const interval = rollcallActivation.ROLLCALL_INTERVAL_BLOCKS[network];
    if (!Number.isFinite(interval) || interval <= 0) return false;
    return Number.isFinite(rollcallActivation.ROLLCALL_ACTIVATION[network]);
}

// Does AttestationRelay reach its consensus channel's start()? The engine constructs
// that channel either way, but start() returns on the opt-in check before starting it,
// and an unstarted channel subscribes to nothing. Read here exactly as
// AttestationRelay.js reads it: env first, then config, default off.
function attestRelayAttaches(config, env) {
    const cfg = config || {};
    return String(env.ATTEST_RELAY_ENABLED || cfg.ATTEST_RELAY_ENABLED || '0') === '1';
}

// The subscribers a configuration can add or remove, each paired with the predicate
// that reads the same inputs its engine reads.
const CONDITIONAL_SUBSCRIBERS = Object.freeze([
    { entry: 'RollcallRound',                     attaches: rollcallRoundAttaches },
    { entry: 'CrossChainDexConsensus:ATTEST_RELAY', attaches: attestRelayAttaches }
]);

// The limits an operator sets on a peer: who is refused outright, how many
// connections one IP may hold, and how many messages a known or unknown peer
// may send in a window.
function initPeerLimits(pm, config) {
    // Consensus-rule agreement, keyed by envelope.sender:
    //   { digest, version, at }  (digest null for a pre-0.12.3 peer that sends none)
    // Bounded by the federation size, and only ever written for a sender whose
    // signature already verified, so an unauthenticated peer cannot grow it.
    pm.peerRules = new Map();
    // Throttle for the two upgrade alarms. Without it a mismatch reprints every
    // heartbeat (15s x every peer), which buries the line it is trying to raise.
    pm._rulesWarnedAt = new Map();
    pm.rulesWarnIntervalMs = parseInt(pm.config.RULES_WARN_INTERVAL_MS) || (30 * 60 * 1000);
    // Optional operator denylist of signing pubkeys (comma-separated hex).
    pm.denyPubkeys = new Set(
        String(config.P2P_DENY_PUBKEYS || '')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    );

    // Per-IP connection limits
    pm.maxConnectionsPerIp = parseInt(config.P2P_MAX_CONNECTIONS_PER_IP) || 3;
    pm.ipConnectionCounts  = new Map();

    // Per-peer message rate limiting: Map<addr, { count, windowStart }>
    pm.msgRateLimit   = parseInt(config.P2P_MSG_RATE_LIMIT) || 100;
    // Established federation peers carry legitimate high-volume consensus
    // traffic: concurrent PBFT rounds across every engine (oracle, xcall, dex,
    // attestation, anchor, checkpoint, ...) can burst well past the anti-spam
    // limit, which is meant for UNKNOWN peers. Dropping a known peer's PBFT
    // message stalls consensus liveness (a round can miss quorum and, absent
    // re-propose, wedge), so known peers get a much higher ceiling while
    // unknown/unestablished peers keep the tight spam limit.
    pm.knownMsgRateLimit = parseInt(config.P2P_MSG_RATE_LIMIT_KNOWN) || Math.max(pm.msgRateLimit * 20, 2000);
    pm.peerMsgCounts  = new Map();

    // Dedup cache size bound; a non-positive value would evict the entry just
    // inserted, leaving the cache holding one id and gossip dedup
    // effectively off, so re-broadcast loops amplify across the mesh.
    pm.dedupCacheMax  = positiveIntConfig(config.P2P_DEDUP_CACHE_MAX, 100000,
        'P2P_DEDUP_CACHE_MAX');
}

// The state the connection layer keeps: the outbound authoring hold, the peer
// table, the dedup cache, the mirror-feed handlers and the server handles.
function initConnectionState(pm) {
    // Outbound membership gate (authoringHeld). Cached against the Set object
    // and the identity it was computed from, so the check costs one reference
    // compare per send and is recomputed only when the signer set is refreshed.
    pm._holdVerdict    = false;
    pm._holdVerdictSet = undefined;
    pm._holdVerdictId  = undefined;
    // { held, fp } of the last announcement, so the line follows the SET rather
    // than the round. Null until the first resolved set.
    pm._holdAnnounced  = null;

    // Peer connections:
    // Map<addr, { ws, state, lastSeen, reconnectDelay, reconnectTimer, inbound,
    //             failures, lastError }>
    // failures counts consecutive failed dials since the last successful open;
    // it drives both the backoff ceiling and the retry log line.
    pm.peers = new Map();

    // Message deduplication: Map<id, expiresAt>
    pm.seenIds = new Map();

    // Read-only mirror feed served on the P2P port beside gossip (see
    // setFeedHandlers). Null until api.js wires it; null means the port serves
    // gossip only, exactly as before.
    pm.feedRequestHandler = null;
    pm.feedUpgradeHandler = null;

    // Server state
    pm.httpServer     = null;
    pm.wss            = null;
    pm.heartbeatTimer = null;
    pm.dedupTimer     = null;
    pm.pingTimer      = null;
    pm.running        = false;
}

class PeerManager extends EventEmitter {
    // Every 'message' listener a hub with THIS configuration creates at boot, one entry
    // each. The ceiling is this list's length: Node's default of 10 sits far below it, so
    // an unsized ceiling leaves every hub logging a MaxListenersExceededWarning at boot
    // and a genuine listener leak with nowhere to announce itself. Sized to the roster exactly
    // rather than to Infinity, so one subscriber that registers twice is still one
    // listener too many and still warns.
    static messageSubscribers(config, env) {
        const e      = env || process.env;
        const roster = [...UNCONDITIONAL_SUBSCRIBERS];
        for (const sub of CONDITIONAL_SUBSCRIBERS) {
            if (sub.attaches(config, e)) roster.push(sub.entry);
        }
        return Object.freeze(roster);
    }

    // The roster of a PeerManager carrying no configuration of its own, under this
    // process's environment: every unconditional subscriber, plus each conditional one
    // whose gate is open or unresolvable. It is the roster's widest honest reading, and
    // what the source-parity derivation in peer_manager_listener_ceiling.test.js compares
    // module names against. A CONFIGURED hub's ceiling comes from messageSubscribers().
    static get MESSAGE_SUBSCRIBERS()   { return PeerManager.messageSubscribers(null, process.env); }
    static get MAX_MESSAGE_LISTENERS() { return PeerManager.MESSAGE_SUBSCRIBERS.length; }

    // Default seed list for a network, or [] when there is none to offer
    // (regtest is a local venue and must never dial public seeds).
    static bootstrapSeeds(network) {
        const port = BOOTSTRAP_PORT_BY_NETWORK[String(network || '').toLowerCase()];
        if (!port) return [];
        return BOOTSTRAP_VALIDATOR_HOSTS.map(h => 'ws://' + h + ':' + port);
    }

    // Blocks a confirmed STAKE waits before it joins the chain-effective signer set.
    // Read from the canonical coins registry (staking is BTC-anchored, the same path
    // _assertCanonicalMinStakes uses) so an operator-facing hint can never quote a
    // delay the chain does not enforce. Null when the network cannot be resolved;
    // callers then omit the hint rather than print an invented number.
    static stakeActivationBlocks(network) {
        try {
            const cfg = coins.getCoinConfig('BTC', String(network || '').toLowerCase());
            const n = (cfg && cfg.STAKING) ? cfg.STAKING.ACTIVATION_DELAY_BLOCKS : null;
            return Number.isFinite(n) ? n : null;
        } catch (e) {
            return null;
        }
    }


    constructor(config, db) {
        super();
        // Sized to THIS hub's roster, not to the widest one: the ceiling is the number
        // of listeners its own configuration will attach, so a hub that arms roll call
        // or the relay makes room for them and a hub that does not still hears about
        // the first listener past its real boot load.
        this.setMaxListeners(PeerManager.messageSubscribers(config, process.env).length);
        this.config        = config;
        this.db            = db;
        this.validatorAddr = config.P2P_VALIDATOR_ADDR;

        // Validator identity (set via setIdentity, used for signing/verification)
        this.identity         = null;   // ValidatorIdentity instance
        this.validatorPubkeys = null;   // Map<addr, pubkeyHex>; loaded from DB
        this.requireSigs      = config.REQUIRE_SIGNATURES !== false;

        // Option A transport auth: chain-effective signer set (lowercased pubkey
        // hex), pushed in by XChainHub from the on-chain validator snapshot so
        // transport auth follows on-chain key rotation. ADDITIVE to the registry
        // (a pubkey in EITHER is admitted); null until the first refresh. Never
        // cleared to empty on an upstream failure; the registry is the floor.
        this.effectiveSignerSet = null;   // Set<pubkeyHex> | null

        initPeerLimits(this, config);
        initConnectionState(this);
    }

    setIdentity(identity) {
        this.identity = identity;
    }

    // Serve the hub's READ-ONLY mirror feed on this same public P2P port, so an
    // indexer reads its capability/price/checkpoint mirror from the validators
    // themselves. A validator exposes ONE public port per network (10001 mainnet,
    // 10002 testnet); anything an indexer needs has to arrive there, because the
    // JSON-RPC API port is private to the box and there is no separate hub.
    //
    // Both handlers come from api.js, so this is a second ENTRANCE to the existing
    // routes, never a second implementation: no SQL, no auth rule and no schema
    // version is restated here, and the API's own HUB_API_KEY gate runs unchanged.
    // Only two shapes are ever delegated (isFeedRequest / FEED_SUBSCRIBE_PATH):
    // GET of a mirror snapshot, and the mirror subscribe upgrade. Every other
    // request on this port is answered 404 and every other upgrade stays gossip,
    // so the write methods on the private API are not reachable from here.
    setFeedHandlers(requestHandler, upgradeHandler) {
        this.feedRequestHandler = requestHandler || null;
        this.feedUpgradeHandler = upgradeHandler || null;
    }

    // Feed traffic is exactly two shapes. A mirror-snapshot read: GET only (the
    // bootstrap is a paged GET), under the snapshot prefix. And the JSON-RPC
    // endpoint: POST to the root, which is how an indexer reports what landed on
    // its chain (pushpricebatch and its siblings). WHICH rpc methods are allowed
    // there is decided in api.js, on the request stamp set below, because the
    // method name lives in a body this layer has not read yet.
    isFeedRequest(req) {
        if (!req || !req.url) return false;
        if (req.method === 'GET') {
            return req.url === FEED_SNAPSHOT_PREFIX || req.url.startsWith(FEED_SNAPSHOT_PREFIX + '/');
        }
        if (req.method === 'POST') {
            return req.url === '/' || req.url.startsWith('/?');
        }
        return false;
    }

    isFeedUpgrade(req) {
        return !!(req && req.url && req.url.startsWith(FEED_SUBSCRIBE_PATH));
    }

    setValidatorPubkeys(pubkeyMap) {
        this.validatorPubkeys = pubkeyMap;  // Map<addr, pubkeyHex>
    }

    // Set the chain-effective signer set (Option A). Pubkeys must be lowercase
    // hex. Additive to the registry: a pubkey in EITHER set is admitted. The
    // caller (XChainHub.refreshTransportSignerSet) never clears this to empty
    // on an upstream failure, so the registry stays the authorization floor.
    setEffectiveSignerSet(set) {
        this.effectiveSignerSet = set;  // Set<pubkeyHex> | null
    }
}

// Installed from the part files rather than written in the class body above:
// each part holds one behaviour of this class, and its members land here with
// the descriptors a class body would give them.
for (const Part of [PeerConnections, PeerMessages, PeerInbound, PeerRules, PeerUpkeep]) {
    for (const [from, to] of [[Part.prototype, PeerManager.prototype], [Part, PeerManager]]) {
        for (const key of Object.getOwnPropertyNames(from)) {
            if (key === 'constructor' || key === 'length' || key === 'name' || key === 'prototype') continue;
            Object.defineProperty(to, key, Object.getOwnPropertyDescriptor(from, key));
        }
    }
}

module.exports = PeerManager;
