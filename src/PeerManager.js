/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
        this.requireSigs      = config.REQUIRE_SIGNATURES || false;

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
            ws._peerAddr = null;
            ws._isAlive  = true;

            ws.on('message', (raw) => this._handleInbound(ws, raw, null));
            ws.on('pong', () => { ws._isAlive = true; });
            ws.on('close', () => this._removeInboundPeer(ws));
            ws.on('error', (e) => console.error('Inbound peer error:', e.message));
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
            // Record seed in DB (fire and forget)
            this._recordPeer(addr, this.validatorAddr, true);
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

        // Mark own message as seen
        this.seenIds.set(envelope.id, Date.now() + (this.config.P2P_MSG_DEDUP_TTL || 60000));

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

        this.seenIds.set(envelope.id, Date.now() + (this.config.P2P_MSG_DEDUP_TTL || 60000));
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
        // Sign if identity is available
        if (this.identity) {
            envelope.sig = this.identity.signEnvelope(envelope);
        }
        return envelope;
    }

    // Verify an envelope's signature against the validator registry
    _verifySignature(envelope) {
        // If signatures not required, accept unsigned messages
        if (!this.requireSigs && !envelope.sig) return true;
        // If signatures required but missing, reject
        if (this.requireSigs && !envelope.sig) return false;
        // If no validator registry loaded, accept (bootstrap mode)
        if (!this.validatorPubkeys) return true;
        // Look up sender's pubkey
        let pubkeyHex = this.validatorPubkeys.get(envelope.sender);
        if (!pubkeyHex) {
            // Unknown sender — accept if sigs not required, reject if required
            return !this.requireSigs;
        }
        // Verify the signature
        return ValidatorIdentity.verifyEnvelope(envelope, pubkeyHex);
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
            return; // Invalid JSON — silently discard
        }

        // Guard against non-object JSON values (null, number, string, boolean)
        if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return;

        // Validate envelope fields
        if (!envelope.type || typeof envelope.type !== 'string') return;
        if (!envelope.id   || typeof envelope.id !== 'string')   return;
        if (!envelope.sender || typeof envelope.sender !== 'string') return;
        if (typeof envelope.timestamp !== 'number') return;

        // Self-connection guard
        if (envelope.sender === this.validatorAddr) {
            if (ws._peerAddr === null) {
                ws.close(1000, 'self-connection');
            }
            return;
        }

        // Deduplication
        if (this.seenIds.has(envelope.id)) return;
        this.seenIds.set(envelope.id, Date.now() + (this.config.P2P_MSG_DEDUP_TTL || 60000));

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

        // Update DB (fire and forget)
        this._recordPeer(peerAddr, envelope.sender, false);

        // Emit events
        this.emit('message', envelope);
        if (envelope.type === 'HEARTBEAT') {
            this.emit('heartbeat', envelope.sender, envelope.timestamp);
        }

        // Relay to other peers
        this._relay(envelope, ws);
    }

    // Relay a message to all peers except the source
    _relay(envelope, sourceWs) {
        let serialized = JSON.stringify(envelope);
        for (let [addr, peer] of this.peers) {
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
    }

    // Connect to an outbound peer
    _connectToPeer(addr) {
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
        let ws;
        try {
            ws = new WebSocket('ws://' + addr, { maxPayload: maxPayload });
        } catch (e) {
            console.error('Failed to create WebSocket to ' + addr + ':', e.message);
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

        ws.on('close', () => {
            if (peer.state === 'open') {
                this.emit('peer:disconnect', addr);
                console.log('Peer disconnected: ' + addr);
            }
            peer.state = 'closed';
            peer.ws = null;
            this._scheduleReconnect(addr);
        });

        ws.on('error', (e) => {
            // Error is followed by close event — don't double-handle
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
        }, 30000);
    }

    // Start WS ping/pong interval for dead connection detection
    _startPingInterval() {
        this.pingTimer = setInterval(() => {
            // Ping outbound connections
            for (let [addr, peer] of this.peers) {
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
        }, 30000);
    }

    // Record/update a peer in the database (fire and forget)
    _recordPeer(addr, validatorId, isSeed) {
        if (!this.db) return;
        let query = `INSERT INTO p2p_peers (addr, validator_id, last_seen_at, is_seed)
                     VALUES (?, ?, NOW(), ?)
                     ON DUPLICATE KEY UPDATE validator_id = ?, last_seen_at = NOW()`;
        this.db.doQuery(query, [addr, validatorId, isSeed ? 1 : 0, validatorId])
            .catch(e => console.error('Error recording peer:', e.message));
    }
}

module.exports = PeerManager;
