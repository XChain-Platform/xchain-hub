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
const { positiveIntConfig } = require('./lib/config_int.js');

// Bootstrap peers every new hub can reach. One hostname per validator; the
// PORT selects the network, so a seed on the wrong port reaches the wrong
// federation. Hostnames, not IPs, so a validator can move boxes.
const BOOTSTRAP_VALIDATOR_HOSTS = [
    'validator01.xchain.io', 'validator02.xchain.io', 'validator03.xchain.io',
    'validator04.xchain.io', 'validator05.xchain.io'
];
const BOOTSTRAP_PORT_BY_NETWORK = { mainnet: 10001, testnet: 10002 };

class PeerManager extends EventEmitter {
    // Default seed list for a network, or [] when there is none to offer
    // (regtest is a local venue and must never dial public seeds).
    static bootstrapSeeds(network) {
        const port = BOOTSTRAP_PORT_BY_NETWORK[String(network || '').toLowerCase()];
        if (!port) return [];
        return BOOTSTRAP_VALIDATOR_HOSTS.map(h => 'ws://' + h + ':' + port);
    }


    constructor(config, db) {
        super();
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

        // Peer connections: Map<addr, { ws, state, lastSeen, reconnectDelay, reconnectTimer, inbound }>
        this.peers = new Map();

        // Message deduplication: Map<id, expiresAt>
        this.seenIds = new Map();

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

        this.httpServer = http.createServer();
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: this.config.P2P_MAX_PAYLOAD || 1048576 });

        this.httpServer.on('upgrade', (req, socket, head) => {
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

    broadcast(type, data) {
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
    _verifySignature(envelope) {
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
            if (!inSet) return !this.requireSigs;
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
            // Unknown sender: accept if sigs not required, reject if required
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
            return;
        }

        if (!this._verifySignature(envelope)) {
            console.warn('P2P: Invalid signature from ' + envelope.sender + '; dropping message');
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

        this.emit('message', envelope);
        if (envelope.type === 'HEARTBEAT') {
            this.emit('heartbeat', envelope.sender, envelope.timestamp);
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
                inbound:        false
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

        ws.on('error', (e) => {
            console.error('Outbound peer error (' + addr + '):', e.message);
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

        peer.reconnectTimer = setTimeout(() => {
            peer.reconnectTimer = null;
            this._connectToPeer(addr);
        }, totalDelay);

        let maxDelay = this.config.P2P_RECONNECT_MAX || 60000;
        peer.reconnectDelay = Math.min(delay * 2, maxDelay);
    }

    _startHeartbeat() {
        let interval = this.config.P2P_HEARTBEAT_INTERVAL || 15000;
        let version = '0.0.0';
        try { version = require('../package.json').version; } catch(e) {}
        this.heartbeatTimer = setInterval(() => {
            this.broadcast('HEARTBEAT', { version: version });
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
