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

const crypto            = require('crypto');
const EventEmitter     = require('events');
const http             = require('http');
const WebSocket        = require('ws');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const rulesDigest = require('./consensus_rules_digest.js');
const coins            = require('./coins');
const { positiveIntConfig } = require('./lib/config_int.js');
const { notePeerReject, stampRemoteIp } = require('./consensusDiagnostics');
// The roster below credits RollcallRound only where the engine would really start,
// so it reads the engine's own activation source rather than a copy of it.
const rollcallActivation = require('./rollcall_activation.js');

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
// asks for (xchain-indexer src/hub_db_sync.js _httpGet / _connectWebSocket): the
// same client code reaches a validator over this port and a private hub over the
// API port, so a path that differs on one side silently disables the mirror.
const FEED_SNAPSHOT_PREFIX = '/hub-db/snapshot';
const FEED_SUBSCRIBE_PATH  = '/hub-db/subscribe';

// Every SUBSCRIPTION to the PeerManager 'message' fan-out that a full boot creates,
// one entry each. The ceiling below is derived from this roster instead of being a
// hand-picked number, so it cannot drift away from what actually subscribes;
// PeerManagerListenerCeiling.test.js re-derives the roster from the sources and
// fails when the two disagree.
//
// Most entries are a bare module name, because most subscribers are singletons and
// their module registers exactly one handler. CrossChainDexConsensus is not: it is a
// parameterized PBFT channel and the hub boots one instance per round family, so its
// extra channels are named `<module>:<channel>` and each one is a listener of its own.
// PeerManagerListenerCeiling.test.js recovers the module from an entry by splitting on
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
// derivation in PeerManagerListenerCeiling.test.js scans these files for that call
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
    // what the source-parity derivation in PeerManagerListenerCeiling.test.js compares
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

        // Consensus-rule agreement, keyed by envelope.sender:
        //   { digest, version, at }  (digest null for a pre-0.12.3 peer that sends none)
        // Bounded by the federation size, and only ever written for a sender whose
        // signature already verified, so an unauthenticated peer cannot grow it.
        this.peerRules = new Map();
        // Throttle for the two upgrade alarms. Without it a mismatch reprints every
        // heartbeat (15s x every peer), which buries the line it is trying to raise.
        this._rulesWarnedAt = new Map();
        this.rulesWarnIntervalMs = parseInt(this.config.RULES_WARN_INTERVAL_MS) || (30 * 60 * 1000);
        // Optional operator denylist of signing pubkeys (comma-separated hex).
        this.denyPubkeys = new Set(
            String(config.P2P_DENY_PUBKEYS || '')
                .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        );

        // Per-IP connection limits
        this.maxConnectionsPerIp = parseInt(config.P2P_MAX_CONNECTIONS_PER_IP) || 3;
        this.ipConnectionCounts  = new Map();

        // Per-peer message rate limiting: Map<addr, { count, windowStart }>
        this.msgRateLimit   = parseInt(config.P2P_MSG_RATE_LIMIT) || 100;
        // Established federation peers carry legitimate high-volume consensus
        // traffic: concurrent PBFT rounds across every engine (oracle, xcall, dex,
        // attestation, anchor, checkpoint, ...) can burst well past the anti-spam
        // limit, which is meant for UNKNOWN peers. Dropping a known peer's PBFT
        // message stalls consensus liveness (a round can miss quorum and, absent
        // re-propose, wedge), so known peers get a much higher ceiling while
        // unknown/unestablished peers keep the tight spam limit.
        this.knownMsgRateLimit = parseInt(config.P2P_MSG_RATE_LIMIT_KNOWN) || Math.max(this.msgRateLimit * 20, 2000);
        this.peerMsgCounts  = new Map();

        // Dedup cache size bound; a non-positive value would evict the entry just
        // inserted, leaving the cache holding one id and gossip dedup
        // effectively off, so re-broadcast loops amplify across the mesh.
        this.dedupCacheMax  = positiveIntConfig(config.P2P_DEDUP_CACHE_MAX, 100000,
            'P2P_DEDUP_CACHE_MAX');

        // Outbound membership gate (authoringHeld). Cached against the Set object
        // and the identity it was computed from, so the check costs one reference
        // compare per send and is recomputed only when the signer set is refreshed.
        this._holdVerdict    = false;
        this._holdVerdictSet = undefined;
        this._holdVerdictId  = undefined;
        // { held, fp } of the last announcement, so the line follows the SET rather
        // than the round. Null until the first resolved set.
        this._holdAnnounced  = null;

        // Peer connections:
        // Map<addr, { ws, state, lastSeen, reconnectDelay, reconnectTimer, inbound,
        //             failures, lastError }>
        // failures counts consecutive failed dials since the last successful open;
        // it drives both the backoff ceiling and the retry log line.
        this.peers = new Map();

        // Message deduplication: Map<id, expiresAt>
        this.seenIds = new Map();

        // Read-only mirror feed served on the P2P port beside gossip (see
        // setFeedHandlers). Null until api.js wires it; null means the port serves
        // gossip only, exactly as before.
        this.feedRequestHandler = null;
        this.feedUpgradeHandler = null;

        // Server state
        this.httpServer     = null;
        this.wss            = null;
        this.heartbeatTimer = null;
        this.dedupTimer     = null;
        this.pingTimer      = null;
        this.running        = false;
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
    // Only two shapes are ever delegated (_isFeedRequest / FEED_SUBSCRIBE_PATH):
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
    _isFeedRequest(req) {
        if (!req || !req.url) return false;
        if (req.method === 'GET') {
            return req.url === FEED_SNAPSHOT_PREFIX || req.url.startsWith(FEED_SNAPSHOT_PREFIX + '/');
        }
        if (req.method === 'POST') {
            return req.url === '/' || req.url.startsWith('/?');
        }
        return false;
    }

    _isFeedUpgrade(req) {
        return !!(req && req.url && req.url.startsWith(FEED_SUBSCRIBE_PATH));
    }

    setValidatorPubkeys(pubkeyMap) {
        this.validatorPubkeys = pubkeyMap;  // Map<addr, pubkeyHex>
    }

    // Set the chain-effective signer set (Option A). Pubkeys must be lowercase
    // hex. Additive to the registry: a pubkey in EITHER set is admitted. The
    // caller (XChainHub._refreshTransportSignerSet) never clears this to empty
    // on an upstream failure, so the registry stays the authorization floor.
    setEffectiveSignerSet(set) {
        this.effectiveSignerSet = set;  // Set<pubkeyHex> | null
    }

    async start() {
        let port = this.config.P2P_PORT || 10001;
        let host = this.config.P2P_HOST || '0.0.0.0';

        // Plain HTTP on this port answers ONLY the mirror-snapshot reads, and only
        // once api.js has wired them. Everything else gets 404 rather than being
        // left to hang on an open socket (the pre-feed behaviour of a handler-less
        // server), so a stray probe cannot hold a connection open.
        this.httpServer = http.createServer((req, res) => {
            if (this.feedRequestHandler && this._isFeedRequest(req)) {
                // Stamp the request as having arrived on the PUBLIC port. api.js
                // reads this to hold a stamped request to the indexer push
                // allowlist; an unstamped request (the private API port) keeps the
                // full method surface. Set here rather than inferred from a port
                // number downstream, so the two entrances can never be confused.
                req.xchainFeedOrigin = true;
                this.feedRequestHandler(req, res);
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{"error":"not found"}');
        });
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: this.config.P2P_MAX_PAYLOAD || 1048576 });

        this.httpServer.on('upgrade', (req, socket, head) => {
            // Mirror subscribers are handed to the API's own upgrade path (auth,
            // then HubDbBroadcaster). They never enter the gossip WebSocket server,
            // so a feed client is never in this.peers: it cannot be broadcast to,
            // relayed to, counted in any quorum, or pinged as a peer.
            if (this._isFeedUpgrade(req)) {
                if (this.feedUpgradeHandler) this.feedUpgradeHandler(req, socket, head);
                else socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
        });

        this.wss.on('connection', (ws, req) => {
            // Per-IP connection limit
            let remoteIp = req.socket.remoteAddress || 'unknown';
            let ipCount = this.ipConnectionCounts.get(remoteIp) || 0;
            if (ipCount >= this.maxConnectionsPerIp) {
                console.warn('P2P: Connection limit per IP exceeded for ' + remoteIp + '; rejecting');
                ws.close(1008, 'too many connections');
                return;
            }
            this.ipConnectionCounts.set(remoteIp, ipCount + 1);

            ws._peerAddr  = null;
            ws._isAlive   = true;
            ws._remoteIp  = remoteIp;

            ws.on('message', (raw) => this._handleInbound(ws, raw, null));
            ws.on('pong', () => { ws._isAlive = true; });
            ws.on('close', (code, reason) => {
                let reasonStr = reason && reason.length ? reason.toString() : '';
                console.log('Inbound ws closed from ' + (ws._peerAddr || 'unknown') + ' (code=' + code + ', reason="' + reasonStr + '")');
                this._removeInboundPeer(ws);
            });
            ws.on('error', (e) => console.error('Inbound peer error:', e));
        });

        await new Promise((resolve, reject) => {
            this.httpServer.listen(port, host, () => {
                console.log('P2P listening on ' + host + ':' + port);
                resolve();
            });
            this.httpServer.on('error', reject);
        });

        this.running = true;

        // A hub with no SEED_NODES dials nobody and joins no gossip mesh, while
        // running and looking healthy. Fall back to the bootstrap peers.
        // regtest gets none: a local venue must never dial public seeds.
        let seeds = this.config.SEED_NODES || [];
        if (seeds.length === 0) {
            const defaults = PeerManager.bootstrapSeeds(this.config.HUB_NETWORK);
            if (defaults.length) {
                // Never dial ourselves: one of the five IS one of the five.
                seeds = defaults.filter(a => !host || host === '0.0.0.0' ? true : !a.includes(host));
                console.log('PeerManager: no SEED_NODES configured; using the ' + seeds.length +
                            ' default bootstrap seed(s) for ' + this.config.HUB_NETWORK);
            }
        }
        for (let addr of seeds) {
            this._connectToPeer(addr);
            // Record seed in DB (fire and forget). validator_id is the peer's own addr,
            // not ours; we are recording the peer, not ourselves.
            this._recordPeer(addr, addr, true);
        }

        this._startHeartbeat();
        this._startDedupPruner();
        this._startPingInterval();
    }

    async stop() {
        this.running = false;

        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        if (this.dedupTimer)     { clearInterval(this.dedupTimer);     this.dedupTimer = null; }
        if (this.pingTimer)      { clearInterval(this.pingTimer);      this.pingTimer = null; }

        for (let [addr, peer] of this.peers) {
            if (peer.reconnectTimer) clearTimeout(peer.reconnectTimer);
            if (peer.ws && peer.ws.readyState <= WebSocket.OPEN) {
                peer.ws.close(1000, 'shutdown');
            }
        }
        this.peers.clear();

        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.httpServer) {
            await new Promise((resolve) => this.httpServer.close(resolve));
            this.httpServer = null;
        }
    }

    // Should a message this hub AUTHORS be held back?
    //
    // The mirror image of the membership test _verifySignature applies to an
    // arriving envelope: a hub whose signing key is outside the chain-effective
    // signer set is an observer, so every peer drops what it authors before the
    // handler runs. Proposing, preparing, committing, voting or asking for a
    // co-signature from there is pure noise (a re-admitted testnet service hub
    // cost each of five validators one PEER_REJECT every 4 s). Relay, inbound
    // handling and the mirror feed are deliberately not routed through here.
    //
    // Fails OPEN in every state that is not a definite absence, so a real
    // validator can never go silent on a transient set read: no identity, no set
    // yet, an empty set (boot, or an upstream that answered with nothing), a key
    // that will not render, or a mesh that does not require signatures at all
    // (there a peer admits an unknown sender anyway, so the send would land).
    authoringHeld() {
        if (!this.requireSigs || !this.identity) return false;
        let set = this.effectiveSignerSet;
        if (!set || typeof set.has !== 'function' || set.size === 0) return false;
        if (this._holdVerdictSet === set && this._holdVerdictId === this.identity) return this._holdVerdict;

        this._holdVerdictSet = set;
        this._holdVerdictId  = this.identity;
        let me = null;
        try { me = String(this.identity.getPubkeyHex()).toLowerCase(); }
        catch (e) { me = null; }
        this._holdVerdict = me ? !set.has(me) : false;
        this._announceAuthoringHold(set, me);
        return this._holdVerdict;
    }

    // One info line per signer-set CHANGE, never per round. Keyed on the set's
    // members rather than the Set object, because the refresh installs a new
    // object every poll and announcing per object would print every 30s.
    _announceAuthoringHold(set, me) {
        let held = this._holdVerdict;
        let fp   = [...set].sort().join(',');
        let prev = this._holdAnnounced;
        if (prev && prev.held === held && (!held || prev.fp === fp)) return;
        this._holdAnnounced = { held: held, fp: fp };
        if (held) {
            console.log('PeerManager: this hub is not in the ' + set.size + '-member chain-effective ' +
                'signer set, so it will not author consensus messages or checkpoint rounds ' +
                '(peers would drop them); receiving, relay and the mirror feed are unaffected' +
                (me ? ' (pubkey ' + me + ')' : ''));
            return;
        }
        // A member hub says nothing at boot; only the return from a hold is news.
        if (prev) {
            console.log('PeerManager: this hub is in the ' + set.size + '-member chain-effective ' +
                'signer set; it is authoring consensus messages again');
        }
    }

    broadcast(type, data) {
        // Observer hold (authoringHeld): no envelope is built, so nothing reaches
        // the wire and no dedup slot is spent. Null rather than an envelope; no
        // caller in src/ reads the return.
        if (this.authoringHeld()) return null;

        let envelope = this._buildEnvelope(type, data);

        // Mark own message as seen (with cache bound)
        this._addToDedup(envelope.id);

        let serialized = JSON.stringify(envelope);

        for (let [addr, peer] of this.peers) {
            if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
                this._send(peer.ws, serialized);
            }
        }

        return envelope;
    }

    sendToPeer(addr, type, data) {
        // Same observer hold as broadcast: false is the existing "did not send".
        if (this.authoringHeld()) return false;

        let peer = this.peers.get(addr);
        if (!peer || !peer.ws || peer.ws.readyState !== WebSocket.OPEN) return false;

        let envelope = this._buildEnvelope(type, data);

        this._addToDedup(envelope.id);
        this._send(peer.ws, JSON.stringify(envelope));
        return true;
    }

    getPeerStatus() {
        let status = [];
        for (let [addr, peer] of this.peers) {
            status.push({
                addr:     addr,
                state:    peer.state,
                lastSeen: peer.lastSeen,
                inbound:  peer.inbound || false
            });
        }
        return status;
    }

    _makeId() {
        return 'v1:' + this.validatorAddr + ':' + Date.now() + ':' + crypto.randomUUID();
    }

    _buildEnvelope(type, data) {
        let envelope = {
            type:      type,
            id:        this._makeId(),
            sender:    this.validatorAddr,
            timestamp: Date.now(),
            data:      data || {}
        };
        // Sign if identity is available. Option A: carry the signing pubkey so
        // verifiers can authenticate by chain-effective-set membership (not by a
        // static addr->pubkey map). Set BEFORE signing so it is in the canonical.
        if (this.identity) {
            envelope.sig_pubkey = this.identity.getPubkeyHex();
            envelope.sig        = this.identity.signEnvelope(envelope);
        }
        return envelope;
    }

    // Verify an envelope's signature.
    //
    // Option A (sig_pubkey present): authenticate by MEMBERSHIP in the union of
    // the chain-effective signer set and the validator registry's pubkey set,
    // then verify the Ed25519 signature against the carried key. This makes
    // transport auth follow on-chain key rotation without manual registry edits.
    //
    // Backward-compat (no sig_pubkey): fall back to the static addr->pubkey
    // registry so pre-A and A hubs interoperate during a rolling deploy.
    //
    // `outcome` is an optional caller-owned object that classifies a rejection.
    // A membership miss sets outcome.reason = 'not_in_signer_set'; every other
    // rejection leaves it unset, so the caller's default (a real signature
    // failure) still applies. It is an out-param rather than a richer return
    // because every caller and test treats this method as a predicate, and the
    // boolean is the security-critical value.
    _verifySignature(envelope, outcome) {
        // If signatures not required, accept unsigned messages
        if (!this.requireSigs && !envelope.sig) return true;
        // If signatures required but missing, reject
        if (this.requireSigs && !envelope.sig) return false;

        // --- Option A: envelope carries its signing pubkey ---
        if (envelope.sig_pubkey && typeof envelope.sig_pubkey === 'string') {
            let pk = envelope.sig_pubkey.toLowerCase();
            // Denylist: reject outright, BEFORE any expensive Ed25519 verify.
            if (this.denyPubkeys.has(pk)) return false;
            // Membership check BEFORE verify (DoS guard: never burn a verify on
            // a key we'd reject anyway). Admit iff the key is in the chain
            // effective set OR the registry's pubkey set (addr-independent).
            let inSet = (this.effectiveSignerSet && this.effectiveSignerSet.has(pk))
                     || this._registryHasPubkey(pk);
            // Not a member: reject when sigs are required (fail closed); preserve
            // the permissive mode otherwise, matching the unknown-sender path.
            // The reason is reported separately from a crypto failure: a joining
            // validator whose STAKE has not activated yet signs perfectly well, and
            // telling it its SIGNATURE is bad sends its operator hunting keys.
            if (!inSet) {
                if (outcome) outcome.reason = 'not_in_signer_set';
                return !this.requireSigs;
            }
            if (!ValidatorIdentity.verify(
                ValidatorIdentity.getSignablePayload(envelope), envelope.sig, pk))
                return false;
            // Sender<->key binding (fail closed, CONSENSUS-CRITICAL). A valid
            // signature proves the KEY signed, but the message is attributed to
            // envelope.sender, and every count-mode PBFT tally (Consensus /
            // OracleConsensus / AttestationConsensus / DEX / XCALL) plus the oracle
            // submission map key their integrity-critical sets on sender. Option A
            // membership alone is addr-BLIND: without this check one authorized key
            // could sign envelopes naming every OTHER validator's addr and forge a
            // full quorum (or stuff the oracle median that all hubs then co-sign).
            // If the registry knows this sender, the signing key MUST be the pubkey
            // registered to it (the same addr<->pubkey binding _handleCapabilityMessage
            // enforces). A sender the registry doesn't know still passes here (an
            // on-chain-active key not yet in the manual registry, or a relayed gossip
            // origin), but its votes are dropped downstream by _isKnownSender, so
            // consensus attribution stays bound to a registered key either way.
            if (this.validatorPubkeys) {
                let registeredPk = this.validatorPubkeys.get(envelope.sender);
                if (registeredPk && String(registeredPk).toLowerCase() !== pk) return false;
            }
            return true;
        }

        // --- Backward-compat path (pre-A envelope, no sig_pubkey) ---
        // No validator registry loaded: fail closed. A null registry means we
        // cannot authenticate any sender, so a self-signed envelope from an
        // unknown peer must be rejected rather than trusted. (Defense in depth:
        // the hub also refuses to open the P2P listener with a null registry;
        // see XChainHub.startP2P.) When signatures are not required the hub is
        // not authenticating peers at all, so preserve that mode's permissive
        // behavior, matching the unknown-sender handling below.
        if (!this.validatorPubkeys) return !this.requireSigs;
        // Look up sender's pubkey
        let pubkeyHex = this.validatorPubkeys.get(envelope.sender);
        if (!pubkeyHex) {
            // Unknown sender: accept if sigs not required, reject if required.
            // A membership miss on this path too (the registry is the only signer
            // set a pre-A envelope is checked against), so it reports the same
            // reason rather than blaming the peer's signature.
            if (outcome) outcome.reason = 'not_in_signer_set';
            return !this.requireSigs;
        }
        // Verify the signature
        return ValidatorIdentity.verifyEnvelope(envelope, pubkeyHex);
    }

    // True iff the validator registry maps some addr to this pubkey hex. The
    // registry is Map<addr, pubkeyHex>; Option A uses it as an addr-independent
    // pubkey SET so a rotated key is admitted as soon as the registry carries it
    // under any addr.
    _registryHasPubkey(pubkeyHexLower) {
        if (!this.validatorPubkeys) return false;
        for (let v of this.validatorPubkeys.values()) {
            if (v && v.toLowerCase() === pubkeyHexLower) return true;
        }
        return false;
    }

    _send(ws, serialized) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(serialized, (err) => {
                if (err) console.error('WS send error:', err.message);
            });
        }
    }

    _handleInbound(ws, rawData, knownAddr) {
        let envelope;
        try {
            envelope = JSON.parse(rawData);
        } catch (e) {
            console.warn('P2P: Invalid JSON from peer:', e);
            return;
        }

        // Guard against non-object JSON values (null, number, string, boolean)
        if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return;

        if (!envelope.type || typeof envelope.type !== 'string') return;
        if (!envelope.id   || typeof envelope.id !== 'string')   return;
        if (!envelope.sender || typeof envelope.sender !== 'string') return;
        if (typeof envelope.timestamp !== 'number') return;

        // Timestamp freshness: drop envelopes too far from our clock in either
        // direction. maxSkew is capped at the dedup TTL so the [dedup-expiry,
        // maxSkew] window cannot be used to replay a signed envelope after its
        // dedup entry is pruned. (Anti-replay for the Option A signed-envelope
        // surface.) Default dedup TTL is 60s; default skew is also 60s.
        let dedupTTL = parseInt(this.config.P2P_MSG_DEDUP_TTL) || 60000;
        let maxSkew  = Math.min(parseInt(this.config.P2P_MSG_MAX_SKEW_MS) || dedupTTL, dedupTTL);
        if (Math.abs(Date.now() - envelope.timestamp) > maxSkew) return;

        // Self-connection guard
        if (envelope.sender === this.validatorAddr) {
            if (ws._peerAddr === null) {
                ws.close(1000, 'self-connection');
            }
            return;
        }

        if (this.seenIds.has(envelope.id)) return;
        this._addToDedup(envelope.id);

        // Per-peer rate limiting: established federation peers get the higher
        // known-peer ceiling so a consensus burst is never dropped (a dropped PBFT
        // message is a liveness hazard); unknown/unestablished peers keep the tight
        // anti-spam limit.
        //
        // The CEILING is derived from transport-verified identifiers only (knownAddr
        // set by the WS handshake, ws._peerAddr set after the first successfully
        // verified message). envelope.sender is intentionally excluded here because
        // the signature has not been checked yet: using it would let an attacker name
        // a known peer's address in the envelope to claim the higher ceiling for
        // otherwise-unverified traffic (~20x headroom amplification).
        //
        // The bucket KEY is also a transport-verified identifier (ws._remoteIp), never
        // envelope.sender: an unverified connection could otherwise mint a brand-new
        // bucket per message by rotating envelope.sender, so every message would be the
        // first in its window (count=1) and the anti-spam ceiling would never trigger,
        // while peerMsgCounts grew one permanent entry per forged sender. Keying on the
        // connection's remote IP forces all of one connection's pre-verification traffic
        // through a single bucket.
        let ratePeer = knownAddr || ws._peerAddr || ws._remoteIp || envelope.sender;
        let rateCeil = this.peers.has(knownAddr || ws._peerAddr) ? this.knownMsgRateLimit : this.msgRateLimit;
        if (!this._checkMsgRate(ratePeer, rateCeil)) {
            console.warn('P2P: Rate limit exceeded for peer ' + ratePeer + '; dropping message');
            notePeerReject({ peer: ratePeer, reason: 'rate_limit' });
            return;
        }

        // Two very different faults share this return path: a key we do not
        // authenticate at all (never staked, stake not yet activated, wrong key)
        // and a signature that fails to verify. The peer being dropped only ever
        // sees OUR log line, so the two are named apart; the drop itself, and the
        // membership-before-crypto order that produces it, are unchanged. No extra
        // throttling here: the per-peer rate limit above already bounds this line,
        // exactly as it did for the single invalid-signature message.
        let verdict = {};
        if (!this._verifySignature(envelope, verdict)) {
            let peer = ws._remoteIp || envelope.sender;
            if (verdict.reason === 'not_in_signer_set') {
                let blocks = PeerManager.stakeActivationBlocks(this.config.HUB_NETWORK);
                console.warn('P2P: sender not in signer set (no active stake or registry entry): ' +
                    envelope.sender + '; dropping message' +
                    (blocks === null ? '' : ' (a STAKE activates ' + blocks +
                        ' blocks after the transaction confirms)'));
                notePeerReject({ peer: peer, reason: 'not_in_signer_set' });
                return;
            }
            console.warn('P2P: Invalid signature from ' + envelope.sender + '; dropping message');
            notePeerReject({ peer: peer, reason: 'invalid_signature' });
            return;
        }

        if (knownAddr === null && ws._peerAddr === null) {
            ws._peerAddr = envelope.sender;
            this._registerInboundPeer(ws, envelope.sender);
        }

        let peerAddr = knownAddr || ws._peerAddr || envelope.sender;
        let peer = this.peers.get(peerAddr);
        if (peer) {
            peer.lastSeen = Date.now();
        }

        // Update DB (fire and forget). validator_id is peerAddr (the immediate ws peer
        // that delivered the message), NOT envelope.sender. The latter is the original
        // publisher and will diverge from peerAddr on relayed messages.
        this._recordPeer(peerAddr, peerAddr, false);

        // Consensus sees only the envelope, never the socket, so the one
        // identity a remote cannot mint is stamped on here. Non-enumerable and
        // Symbol-keyed, so it cannot reach a persisted row, a re-broadcast
        // payload or a signature preimage through JSON.stringify.
        stampRemoteIp(envelope, ws._remoteIp);
        this.emit('message', envelope);
        if (envelope.type === 'HEARTBEAT') {
            this.emit('heartbeat', envelope.sender, envelope.timestamp, envelope.data);
            this._notePeerRules(envelope);
        }
        // Capability gossip; see CapabilityRegistry.
        if (envelope.type === 'CAPABILITY_ACTIVATED' ||
            envelope.type === 'CAPABILITY_DEACTIVATED' ||
            envelope.type === 'CAPABILITY_SELF_TEST') {
            this.emit('capability', envelope);
        }

        this._relay(envelope, ws);
    }

    // Relay a message to all peers except the source ws and the original sender.
    // Skipping the sender prevents the message from echoing back to the originator
    // via a different ws (e.g., our outbound to a peer who reached us via their
    // outbound), which both wastes bandwidth and trips the self-connection guard
    // on the other side when the receiving ws is freshly opened.
    _relay(envelope, sourceWs) {
        let serialized = JSON.stringify(envelope);
        for (let [addr, peer] of this.peers) {
            if (addr === envelope.sender) continue;
            if (peer.ws && peer.ws !== sourceWs && peer.ws.readyState === WebSocket.OPEN) {
                this._send(peer.ws, serialized);
            }
        }
    }

    _registerInboundPeer(ws, addr) {
        let existing = this.peers.get(addr);

        // If we already have an outbound connection to this peer, keep the outbound
        // and close the inbound to avoid duplicates
        if (existing && existing.ws && existing.ws.readyState === WebSocket.OPEN && !existing.inbound) {
            ws._peerAddr = addr;
            // Use the inbound ws for receiving but don't replace the outbound
            return;
        }

        this.peers.set(addr, {
            ws:             ws,
            state:          'open',
            lastSeen:       Date.now(),
            reconnectDelay: this.config.P2P_RECONNECT_BASE || 2000,
            reconnectTimer: null,
            inbound:        true
        });

        this.emit('peer:connect', addr);
        console.log('Inbound peer connected: ' + addr);
    }

    _removeInboundPeer(ws) {
        // Only the peers-map cleanup is gated on ws._peerAddr. That field is set in
        // _registerInboundPeer, which runs only once an inbound frame has cleared the
        // JSON/type/timestamp/rate/signature checks, whereas the per-IP count is
        // incremented for EVERY accepted socket. Gating the decrement on it too leaked
        // the increment on every pre-auth close (self-connection guard, rate-limited
        // drop, malformed frame, bad signature, connect-then-idle, port scan), so
        // ipConnectionCounts climbed monotonically until the IP reached
        // maxConnectionsPerIp and was refused inbound peering for the rest of the
        // process lifetime: a per-IP partition of the gossip mesh every consensus
        // engine rides, and co-located validators behind one egress IP hit it first.
        let addr = ws._peerAddr;
        if (addr) {
            let peer = this.peers.get(addr);
            if (peer && peer.ws === ws) {
                peer.state = 'closed';
                peer.ws = null;
                this.emit('peer:disconnect', addr);
                console.log('Inbound peer disconnected: ' + addr);

                // Clean up if it was inbound-only (no reconnect for inbound)
                if (peer.inbound) {
                    this.peers.delete(addr);
                }
            }
        }

        // Decrement per-IP connection count. Clearing ws._remoteIp makes the release
        // idempotent: a counter decremented twice under-counts just as permanently as
        // one never decremented at all, and nothing reads the field after close (the
        // rate-key read in _handleInbound is message-time only).
        if (ws._remoteIp) {
            let count = (this.ipConnectionCounts.get(ws._remoteIp) || 1) - 1;
            if (count <= 0) this.ipConnectionCounts.delete(ws._remoteIp);
            else this.ipConnectionCounts.set(ws._remoteIp, count);
            ws._remoteIp = null;
        }
    }

    _connectToPeer(addr) {
        // Validate peer address format: optional ws:// or wss:// prefix, then host:port
        if (!/^(wss?:\/\/)?[\w.\-]+:\d+$/.test(addr)) {
            console.warn('P2P: Invalid peer address format: ' + addr);
            return;
        }

        let existing = this.peers.get(addr);
        if (existing && (existing.state === 'open' || existing.state === 'connecting')) return;

        if (!existing) {
            this.peers.set(addr, {
                ws:             null,
                state:          'connecting',
                lastSeen:       null,
                reconnectDelay: this.config.P2P_RECONNECT_BASE || 2000,
                reconnectTimer: null,
                inbound:        false,
                failures:       0,
                lastError:      null
            });
        }

        let peer = this.peers.get(addr);
        peer.state = 'connecting';

        let maxPayload = this.config.P2P_MAX_PAYLOAD || 1048576;
        let url = /^wss?:\/\//.test(addr) ? addr : 'ws://' + addr;
        let ws;
        try {
            ws = new WebSocket(url, { maxPayload: maxPayload });
        } catch (e) {
            console.error('Failed to create WebSocket to ' + addr + ':', e);
            this._scheduleReconnect(addr);
            return;
        }

        ws._isAlive = true;

        ws.on('open', () => {
            peer.ws    = ws;
            peer.state = 'open';
            peer.reconnectDelay = this.config.P2P_RECONNECT_BASE || 2000;
            // A reached peer is no longer unreachable: drop it back to the fast
            // ceiling so the next real outage is noticed promptly.
            peer.failures  = 0;
            peer.lastError = null;
            this.emit('peer:connect', addr);
            console.log('Connected to peer: ' + addr);
        });

        ws.on('message', (raw) => this._handleInbound(ws, raw, addr));
        ws.on('pong', () => { ws._isAlive = true; });

        ws.on('close', (code, reason) => {
            if (peer.state === 'open') {
                this.emit('peer:disconnect', addr);
                let reasonStr = reason && reason.length ? reason.toString() : '';
                console.log('Peer disconnected: ' + addr + ' (code=' + code + ', reason="' + reasonStr + '")');
            }
            peer.state = 'closed';
            peer.ws = null;
            this._scheduleReconnect(addr);
        });

        // Do NOT log here. A dial that is refused by design (a federation port
        // whose peers are staged but not launched) emits one of these per peer per
        // retry, and at error level that buries everything real in the same log.
        // The message is stashed and reported once per backoff step instead, by
        // _scheduleReconnect, which is the only place that knows how many times in
        // a row this peer has failed and how long the next wait is.
        ws.on('error', (e) => {
            peer.lastError = (e && e.message) ? e.message : String(e);
        });

        peer.ws = ws;
    }

    _scheduleReconnect(addr) {
        if (!this.running) return;

        let peer = this.peers.get(addr);
        if (!peer || peer.inbound) return;

        let delay = peer.reconnectDelay || (this.config.P2P_RECONNECT_BASE || 2000);
        let jitter = Math.floor(Math.random() * delay * 0.25);
        let totalDelay = delay + jitter;

        peer.failures = (peer.failures || 0) + 1;

        peer.reconnectTimer = setTimeout(() => {
            peer.reconnectTimer = null;
            this._connectToPeer(addr);
        }, totalDelay);

        // Two ceilings, and the second is why this hub stops shouting. A peer that
        // drops once and comes back is a blip, and P2P_RECONNECT_MAX (a minute) is
        // the right ceiling for it. A peer that has refused every dial in a row is
        // not coming back on its own schedule - it is a host that is down, or a
        // federation port whose validators have not been launched yet - and
        // retrying it every minute forever buys nothing while costing a log line
        // per peer per minute. After P2P_RECONNECT_ESCALATE_AFTER consecutive
        // failures the backoff is allowed to grow past a minute, up to
        // P2P_RECONNECT_UNREACHABLE_MAX.
        let escalateAfter = this.config.P2P_RECONNECT_ESCALATE_AFTER || 5;
        let maxDelay = (peer.failures >= escalateAfter)
            ? (this.config.P2P_RECONNECT_UNREACHABLE_MAX || 900000)
            : (this.config.P2P_RECONNECT_MAX || 60000);
        peer.reconnectDelay = Math.min(delay * 2, maxDelay);

        // One line per backoff step, at warn, not one per dial at error. The rate
        // decays with the backoff itself, so an indefinitely dead peer settles at a
        // line per ceiling interval rather than a line a minute.
        console.warn('P2P: peer ' + addr + ' unreachable (' + peer.failures +
            ' consecutive failure' + (peer.failures === 1 ? '' : 's') +
            (peer.lastError ? ', last error: ' + peer.lastError : '') +
            '); next attempt in ' + Math.round(totalDelay / 1000) + 's');
    }

// Record a peer's advertised consensus rules and raise the two alarms this
    // module exists for. Called only after _verifySignature passed, so `sender` is
    // an authenticated staked key and `data.rules` is covered by that signature.
    //
    // TWO ALARMS, and the second is the one that matters. Telling an operator that
    // some peer disagrees is mildly useful; telling them that THEIR OWN hub is the
    // odd one out is the message that gets a node upgraded, and it is the message
    // nothing in the platform sent before this.
    _notePeerRules(envelope) {
        let sender = envelope && envelope.sender;
        if (!sender) return;
        let data   = envelope.data || {};
        let digest = (typeof data.rules === 'string' && /^[0-9a-f]{64}$/.test(data.rules)) ? data.rules : null;
        this.peerRules.set(sender, {
            digest:  digest,
            version: (typeof data.version === 'string') ? data.version : null,
            at:      Date.now()
        });

        let mine = rulesDigest.computeConsensusRulesDigest().digest;

        // A peer that advertises no digest is running a build from before this field
        // existed. That is worth saying once per throttle window, but it is NOT a
        // mismatch: it carries no claim to disagree with.
        if (digest === null) {
            this._warnRulesOnce('legacy:' + sender, 'P2P: peer ' + sender + ' advertises no consensus-rules digest' +
                ' (version ' + (this.peerRules.get(sender).version || 'unknown') + '); it predates the digest and cannot be' +
                ' checked for flag-day agreement. Ask its operator to upgrade.');
            return;
        }
        if (digest === mine) return;

        this._warnRulesOnce('peer:' + sender, 'P2P: CONSENSUS-RULE MISMATCH with peer ' + sender +
            ' (its version ' + (this.peerRules.get(sender).version || 'unknown') + '). It applies different flag-day' +
            ' heights than this hub, so the two will disagree about which actions are valid once a differing gate is' +
            ' reached. peer=' + digest.substring(0, 16) + '... ours=' + mine.substring(0, 16) + '...');

        // Am I the minority? Count DISTINCT senders seen inside the staleness window,
        // so a peer that has gone away stops voting. Strictly more peers agreeing with
        // each other than with me means this hub is the one that needs upgrading.
        let cutoff = Date.now() - (2 * (parseInt(this.config.P2P_HEARTBEAT_INTERVAL) || 15000) * 4);
        let tally = new Map();
        let live  = 0;
        for (let [, r] of this.peerRules) {
            if (!r || !r.digest || r.at < cutoff) continue;
            live++;
            tally.set(r.digest, (tally.get(r.digest) || 0) + 1);
        }
        if (live === 0) return;
        let topDigest = null, topCount = 0;
        for (let [d, n] of tally) if (n > topCount) { topCount = n; topDigest = d; }
        let mineCount = (tally.get(mine) || 0) + 1;   // +1: this hub's own vote
        if (topDigest && topDigest !== mine && topCount >= mineCount) {
            this._warnRulesOnce('self', 'P2P: THIS HUB IS RUNNING CONSENSUS RULES THE FEDERATION DOES NOT SHARE. ' +
                topCount + ' of ' + (live + 1) + ' peers agree on ' + topDigest.substring(0, 16) + '... while this hub has ' +
                mine.substring(0, 16) + '... Once the chain reaches a gate where they differ, this hub will judge actions' +
                ' differently from the federation and its state will diverge. UPGRADE THIS NODE.');
        }
    }

    _warnRulesOnce(key, message) {
        let now  = Date.now();
        let last = this._rulesWarnedAt.get(key) || 0;
        if (now - last < this.rulesWarnIntervalMs) return;
        this._rulesWarnedAt.set(key, now);
        console.warn(message);
    }

    // Snapshot for the operator-facing surfaces (hub status / health). `agree` is the
    // count of live peers on this hub's own digest, so a monitor can alarm on it
    // without re-deriving the comparison.
    getConsensusRulesReport() {
        let mine = rulesDigest.computeConsensusRulesDigest();
        let peers = [];
        for (let [addr, r] of this.peerRules) {
            peers.push({ peer: addr, digest: r.digest, version: r.version, at: r.at,
                         agrees: r.digest === mine.digest });
        }
        return {
            digest:    mine.digest,
            gates:     mine.gates,
            peers:     peers,
            agree:     peers.filter(p => p.agrees).length,
            disagree:  peers.filter(p => p.digest && !p.agrees).length,
            unknown:   peers.filter(p => !p.digest).length
        };
    }

    _startHeartbeat() {
        let interval = this.config.P2P_HEARTBEAT_INTERVAL || 15000;
        let version = '0.0.0';
        try { version = require('../package.json').version; } catch(e) {}
        this.heartbeatTimer = setInterval(() => {
            // `rules` rides INSIDE data, not beside it, because getSignablePayload's
            // preimage is a fixed field list (id/type/sender/timestamp/data/sig_pubkey)
            // that hashes `data` verbatim: a key added here is covered by the signature,
            // while a new TOP-LEVEL envelope field would be unsigned and so spoofable by
            // anyone who can reach the socket. Safe across a rolling deploy in both
            // directions: an older hub verifies a newer sender's signature over the data
            // it actually received and simply ignores the key it does not know, and a
            // newer hub reports `rules: null` for an older sender rather than a mismatch.
            this.broadcast('HEARTBEAT', { version: version, rules: rulesDigest.computeConsensusRulesDigest().digest });
        }, interval);
    }

    _startDedupPruner() {
        this.dedupTimer = setInterval(() => {
            let now = Date.now();
            for (let [id, expiresAt] of this.seenIds) {
                if (now >= expiresAt) this.seenIds.delete(id);
            }
            // Prune rate buckets whose 60s window has elapsed. A never-reused key
            // (e.g. a churned remote IP) would otherwise persist forever, so this
            // is what keeps peerMsgCounts bounded to the active-peer set.
            for (let [addr, entry] of this.peerMsgCounts) {
                if ((now - entry.windowStart) > 60000) this.peerMsgCounts.delete(addr);
            }
        }, this.config.P2P_DEDUP_PRUNE_INTERVAL || 30000);
    }

    _startPingInterval() {
        this.pingTimer = setInterval(() => {
            // Ping outbound dialed peers only. Inbound peers also live in this.peers
            // (after _registerInboundPeer) but are pinged via wss.clients below.
            // Pinging them here as well would race the two loops and terminate the
            // inbound ws.
            for (let [addr, peer] of this.peers) {
                if (peer.inbound) continue;
                if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
                    if (peer.ws._isAlive === false) {
                        console.log('Peer ' + addr + ' failed ping/pong; terminating');
                        peer.ws.terminate();
                        return;
                    }
                    peer.ws._isAlive = false;
                    peer.ws.ping();
                }
            }

            if (this.wss) {
                this.wss.clients.forEach((ws) => {
                    if (ws._isAlive === false) {
                        ws.terminate();
                        return;
                    }
                    ws._isAlive = false;
                    ws.ping();
                });
            }
        }, this.config.P2P_WS_PING_INTERVAL || 30000);
    }

    // Add a message ID to the dedup cache, enforcing the size bound
    _addToDedup(id) {
        if (this.seenIds.size >= this.dedupCacheMax) {
            let oldest = this.seenIds.keys().next().value;
            this.seenIds.delete(oldest);
        }
        this.seenIds.set(id, Date.now() + (this.config.P2P_MSG_DEDUP_TTL || 60000));
    }

    _checkMsgRate(addr, limit) {
        let max = (limit != null) ? limit : this.msgRateLimit;
        let now = Date.now();
        let entry = this.peerMsgCounts.get(addr);
        if (!entry || (now - entry.windowStart) > 60000) {
            // Hard size cap as a backstop to the interval pruner: evict the oldest
            // bucket if the map is full so a burst of distinct keys between prune
            // cycles cannot grow it without bound (mirrors _addToDedup).
            if (!entry && this.peerMsgCounts.size >= this.dedupCacheMax) {
                let oldest = this.peerMsgCounts.keys().next().value;
                this.peerMsgCounts.delete(oldest);
            }
            this.peerMsgCounts.set(addr, { count: 1, windowStart: now });
            return true;
        }
        entry.count++;
        return entry.count <= max;
    }

    // Record/update a peer in the database (fire and forget)
    _recordPeer(addr, validatorId, isSeed) {
        if (!this.db) return;
        let query = `INSERT INTO p2p_peers (addr, validator_id, last_seen_at, is_seed)
                     VALUES (?, ?, NOW(), ?)
                     ON DUPLICATE KEY UPDATE validator_id = ?, last_seen_at = NOW()`;
        this.db.doQuery(query, [addr, validatorId, isSeed ? 1 : 0, validatorId])
            .catch(e => console.error('Error recording peer:', e));
    }
}

module.exports = PeerManager;
