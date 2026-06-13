/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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

class PeerManager extends EventEmitter {

    constructor(config, db) {
        super();
        this.config        = config;
        this.db            = db;
        this.validatorAddr = config.P2P_VALIDATOR_ADDR;

        // Validator identity (set via setIdentity, used for signing/verification)
        this.identity         = null;   // ValidatorIdentity instance
        this.validatorPubkeys = null;   // Map<addr, pubkeyHex> — loaded from DB
        this.requireSigs      = config.REQUIRE_SIGNATURES !== false;

        // Option A transport auth: chain-effective signer set (lowercased pubkey
        // hex), pushed in by XChainHub from the on-chain validator snapshot so
        // transport auth follows on-chain key rotation. ADDITIVE to the registry
        // (a pubkey in EITHER is admitted); null until the first refresh. Never
        // cleared to empty on an upstream failure — the registry is the floor.
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
        this.peerMsgCounts  = new Map();

        // Dedup cache size bound
        this.dedupCacheMax  = parseInt(config.P2P_DEDUP_CACHE_MAX) || 100000;

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

    // Set the validator identity for signing outgoing messages
    setIdentity(identity) {
        this.identity = identity;
    }

    // Set the validator pubkey registry for verifying incoming messages
    setValidatorPubkeys(pubkeyMap) {
        this.validatorPubkeys = pubkeyMap;  // Map<addr, pubkeyHex>
    }

    // Set the chain-effective signer set (Option A). Pubkeys must be lowercase
    // hex. Additive to the registry — a pubkey in EITHER set is admitted. The
    // caller (XChainHub._refreshTransportSignerSet) never clears this to empty
    // on an upstream failure, so the registry stays the authorization floor.
    setEffectiveSignerSet(set) {
        this.effectiveSignerSet = set;  // Set<pubkeyHex> | null
    }

    // Start the P2P layer
    async start() {
        let port = this.config.P2P_PORT || 10001;
        let host = this.config.P2P_HOST || '0.0.0.0';

        // Create HTTP server and WebSocket server
        this.httpServer = http.createServer();
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: this.config.P2P_MAX_PAYLOAD || 1048576 });

        // Handle WebSocket upgrades
        this.httpServer.on('upgrade', (req, socket, head) => {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
        });

        // Handle inbound connections
        this.wss.on('connection', (ws, req) => {
            // Per-IP connection limit
            let remoteIp = req.socket.remoteAddress || 'unknown';
            let ipCount = this.ipConnectionCounts.get(remoteIp) || 0;
            if (ipCount >= this.maxConnectionsPerIp) {
                console.warn('P2P: Connection limit per IP exceeded for ' + remoteIp + ' — rejecting');
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

        // Bind server
        await new Promise((resolve, reject) => {
            this.httpServer.listen(port, host, () => {
                console.log('P2P listening on ' + host + ':' + port);
                resolve();
            });
            this.httpServer.on('error', reject);
        });

        this.running = true;

        // Connect to seed nodes
        let seeds = this.config.SEED_NODES || [];
        for (let addr of seeds) {
            this._connectToPeer(addr);
            // Record seed in DB (fire and forget). validator_id is the peer's own addr,
            // not ours — we are recording the peer, not ourselves.
            this._recordPeer(addr, addr, true);
        }

        // Start heartbeat
        this._startHeartbeat();

        // Start dedup cache pruner
        this._startDedupPruner();

        // Start WS ping/pong for dead connection detection
        this._startPingInterval();
    }

    // Stop the P2P layer gracefully
    async stop() {
        this.running = false;

        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        if (this.dedupTimer)     { clearInterval(this.dedupTimer);     this.dedupTimer = null; }
        if (this.pingTimer)      { clearInterval(this.pingTimer);      this.pingTimer = null; }

        // Clear reconnect timers and close connections
        for (let [addr, peer] of this.peers) {
            if (peer.reconnectTimer) clearTimeout(peer.reconnectTimer);
            if (peer.ws && peer.ws.readyState <= WebSocket.OPEN) {
                peer.ws.close(1000, 'shutdown');
            }
        }
        this.peers.clear();

        // Close WebSocket server
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }

        // Close HTTP server
        if (this.httpServer) {
            await new Promise((resolve) => this.httpServer.close(resolve));
            this.httpServer = null;
        }
    }

    // Broadcast a message to all connected peers
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

    // Send a message to a specific peer
    sendToPeer(addr, type, data) {
        let peer = this.peers.get(addr);
        if (!peer || !peer.ws || peer.ws.readyState !== WebSocket.OPEN) return false;

        let envelope = this._buildEnvelope(type, data);

        this._addToDedup(envelope.id);
        this._send(peer.ws, JSON.stringify(envelope));
        return true;
    }

    // Get current peer status for diagnostics
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

    // --- Private methods ---

    // Generate a unique message ID
    _makeId() {
        return 'v1:' + this.validatorAddr + ':' + Date.now() + ':' + crypto.randomUUID();
    }

    // Build an envelope with optional Ed25519 signature
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
        // static addr→pubkey map). Set BEFORE signing so it is in the canonical.
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
    // Backward-compat (no sig_pubkey): fall back to TODAY's path — the static
    // addr→pubkey registry — so pre-A and A hubs interoperate during a rolling
    // deploy.
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
            // Not a member: reject when sigs are required (fail closed), preserve
            // the permissive mode otherwise — matching the unknown-sender path.
            if (!inSet) return !this.requireSigs;
            return ValidatorIdentity.verify(
                ValidatorIdentity.getSignablePayload(envelope), envelope.sig, pk);
        }

        // --- Backward-compat path (pre-A envelope, no sig_pubkey) ---
        // No validator registry loaded: fail closed. A null registry means we
        // cannot authenticate any sender, so a self-signed envelope from an
        // unknown peer must be rejected rather than trusted. (Defense in depth:
        // the hub also refuses to open the P2P listener with a null registry —
        // see XChainHub.startP2P.) When signatures are not required the hub is
        // not authenticating peers at all, so preserve that mode's permissive
        // behavior, matching the unknown-sender handling below.
        if (!this.validatorPubkeys) return !this.requireSigs;
        // Look up sender's pubkey
        let pubkeyHex = this.validatorPubkeys.get(envelope.sender);
        if (!pubkeyHex) {
            // Unknown sender — accept if sigs not required, reject if required
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

    // Send a serialized message on a WebSocket
    _send(ws, serialized) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(serialized, (err) => {
                if (err) console.error('WS send error:', err.message);
            });
        }
    }

    // Handle an inbound message (from any peer)
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

        // Validate envelope fields
        if (!envelope.type || typeof envelope.type !== 'string') return;
        if (!envelope.id   || typeof envelope.id !== 'string')   return;
        if (!envelope.sender || typeof envelope.sender !== 'string') return;
        if (typeof envelope.timestamp !== 'number') return;

        // Timestamp freshness — drop envelopes too far from our clock in either
        // direction. The dedup cache TTL is only ~60s, so without this a signed
        // envelope replayed after its dedup entry expires would re-enter as new.
        // (Anti-replay for the Option A signed-envelope surface.)
        let maxSkew = parseInt(this.config.P2P_MSG_MAX_SKEW_MS) || 300000;
        if (Math.abs(Date.now() - envelope.timestamp) > maxSkew) return;

        // Self-connection guard
        if (envelope.sender === this.validatorAddr) {
            if (ws._peerAddr === null) {
                ws.close(1000, 'self-connection');
            }
            return;
        }

        // Deduplication
        if (this.seenIds.has(envelope.id)) return;
        this._addToDedup(envelope.id);

        // Per-peer rate limiting
        let ratePeer = knownAddr || ws._peerAddr || envelope.sender;
        if (!this._checkMsgRate(ratePeer)) {
            console.warn('P2P: Rate limit exceeded for peer ' + ratePeer + ' — dropping message');
            return;
        }

        // Signature verification
        if (!this._verifySignature(envelope)) {
            console.warn('P2P: Invalid signature from ' + envelope.sender + ' — dropping message');
            return;
        }

        // Register inbound peer if unknown
        if (knownAddr === null && ws._peerAddr === null) {
            ws._peerAddr = envelope.sender;
            this._registerInboundPeer(ws, envelope.sender);
        }

        // Update last-seen timestamp
        let peerAddr = knownAddr || ws._peerAddr || envelope.sender;
        let peer = this.peers.get(peerAddr);
        if (peer) {
            peer.lastSeen = Date.now();
        }

        // Update DB (fire and forget). validator_id is peerAddr (the immediate ws peer
        // that delivered the message), NOT envelope.sender — the latter is the original
        // publisher and will diverge from peerAddr on relayed messages.
        this._recordPeer(peerAddr, peerAddr, false);

        // Emit events
        this.emit('message', envelope);
        if (envelope.type === 'HEARTBEAT') {
            this.emit('heartbeat', envelope.sender, envelope.timestamp);
        }
        // Capability gossip — see CapabilityRegistry / spec 2026-05-24_capability-staking-model.md
        if (envelope.type === 'CAPABILITY_ACTIVATED' ||
            envelope.type === 'CAPABILITY_DEACTIVATED' ||
            envelope.type === 'CAPABILITY_SELF_TEST') {
            this.emit('capability', envelope);
        }

        // Relay to other peers
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

    // Register an inbound peer
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

    // Remove an inbound peer on disconnect
    _removeInboundPeer(ws) {
        let addr = ws._peerAddr;
        if (!addr) return;

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

        // Decrement per-IP connection count
        if (ws._remoteIp) {
            let count = (this.ipConnectionCounts.get(ws._remoteIp) || 1) - 1;
            if (count <= 0) this.ipConnectionCounts.delete(ws._remoteIp);
            else this.ipConnectionCounts.set(ws._remoteIp, count);
        }
    }

    // Connect to an outbound peer
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

    // Schedule a reconnection attempt with exponential backoff
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

        // Exponential backoff
        let maxDelay = this.config.P2P_RECONNECT_MAX || 60000;
        peer.reconnectDelay = Math.min(delay * 2, maxDelay);
    }

    // Start heartbeat broadcasts
    _startHeartbeat() {
        let interval = this.config.P2P_HEARTBEAT_INTERVAL || 15000;
        let version = '0.0.0';
        try { version = require('../package.json').version; } catch(e) {}
        this.heartbeatTimer = setInterval(() => {
            this.broadcast('HEARTBEAT', { version: version });
        }, interval);
    }

    // Start dedup cache pruner
    _startDedupPruner() {
        this.dedupTimer = setInterval(() => {
            let now = Date.now();
            for (let [id, expiresAt] of this.seenIds) {
                if (now >= expiresAt) this.seenIds.delete(id);
            }
        }, this.config.P2P_DEDUP_PRUNE_INTERVAL || 30000);
    }

    // Start WS ping/pong interval for dead connection detection
    _startPingInterval() {
        this.pingTimer = setInterval(() => {
            // Ping outbound dialed peers only. Inbound peers also live in this.peers
            // (after _registerInboundPeer) but are pinged via wss.clients below — pinging
            // them here as well would race the two loops and terminate the inbound ws.
            for (let [addr, peer] of this.peers) {
                if (peer.inbound) continue;
                if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
                    if (peer.ws._isAlive === false) {
                        console.log('Peer ' + addr + ' failed ping/pong — terminating');
                        peer.ws.terminate();
                        return;
                    }
                    peer.ws._isAlive = false;
                    peer.ws.ping();
                }
            }

            // Ping inbound connections
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

    // Check per-peer message rate (returns true if within limit)
    _checkMsgRate(addr) {
        let now = Date.now();
        let entry = this.peerMsgCounts.get(addr);
        if (!entry || (now - entry.windowStart) > 60000) {
            this.peerMsgCounts.set(addr, { count: 1, windowStart: now });
            return true;
        }
        entry.count++;
        return entry.count <= this.msgRateLimit;
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
