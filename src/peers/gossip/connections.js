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
 * XChain Hub - P2P Connections
 *
 * The listener and the dial side of the gossip mesh: opening the port
 * (which also carries the read-only mirror feed), accepting inbound sockets
 * under the per-IP cap, dialing seeds, and the reconnect backoff that
 * decides how loudly an unreachable peer is reported.
 *
 ********************************************************************/

const http = require('http');
const WebSocket = require('ws');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// What the P2P port answers over plain HTTP: the mirror-snapshot reads api.js
// wired, and 404 for everything else.
function serveFeedRequest(pm, req, res) {
    if (pm.feedRequestHandler && pm.isFeedRequest(req)) {
        // Stamp the request as having arrived on the PUBLIC port. api.js
        // reads this to hold a stamped request to the indexer push
        // allowlist; an unstamped request (the private API port) keeps the
        // full method surface. Set here rather than inferred from a port
        // number downstream, so the two entrances can never be confused.
        req.xchainFeedOrigin = true;
        pm.feedRequestHandler(req, res);
        return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
}

// One accepted inbound socket: the per-IP cap, the connection bookkeeping the
// rate limiter keys on, and the socket handlers.
function acceptInboundSocket(pm, ws, req) {
    // Per-IP connection limit
    let remoteIp = req.socket.remoteAddress || 'unknown';
    let ipCount = pm.ipConnectionCounts.get(remoteIp) || 0;
    if (ipCount >= pm.maxConnectionsPerIp) {
        logger.warn('P2P: Connection limit per IP exceeded for ' + remoteIp + '; rejecting');
        ws.close(1008, 'too many connections');
        return;
    }
    pm.ipConnectionCounts.set(remoteIp, ipCount + 1);

    ws._peerAddr  = null;
    ws._isAlive   = true;
    ws._remoteIp  = remoteIp;

    ws.on('message', (raw) => pm.handleInbound(ws, raw, null));
    ws.on('pong', () => { ws._isAlive = true; });
    ws.on('close', (code, reason) => {
        let reasonStr = reason && reason.length ? reason.toString() : '';
        logger.info('Inbound ws closed from ' + (ws._peerAddr || 'unknown') + ' (code=' + code + ', reason="' + reasonStr + '")');
        pm.removeInboundPeer(ws);
    });
    ws.on('error', (e) => logger.error(nodeUtil.format('Inbound peer error:', e)));
}

// Dial the configured seeds, or the network default bootstrap peers when the
// operator configured none.
function dialSeedPeers(pm, host) {
    // A hub with no SEED_NODES dials nobody and joins no gossip mesh, while
    // running and looking healthy. Fall back to the bootstrap peers.
    // regtest gets none: a local venue must never dial public seeds.
    let seeds = pm.config.SEED_NODES || [];
    if (seeds.length === 0) {
        const defaults = pm.constructor.bootstrapSeeds(pm.config.HUB_NETWORK);
        if (defaults.length) {
            // Never dial ourselves: one of the five IS one of the five.
            seeds = defaults.filter(a => !host || host === '0.0.0.0' ? true : !a.includes(host));
            logger.info('PeerManager: no SEED_NODES configured; using the ' + seeds.length +
                        ' default bootstrap seed(s) for ' + pm.config.HUB_NETWORK);
        }
    }
    for (let addr of seeds) {
        pm.connectToPeer(addr);
        // Record seed in DB (fire and forget). validator_id is the peer's own addr,
        // not ours; we are recording the peer, not ourselves.
        pm.recordPeer(addr, addr, true);
    }
}

// The outbound socket handlers: they own the peer record this dial created.
function wireOutboundSocket(pm, addr, peer, ws) {
    ws.on('open', () => {
        peer.ws    = ws;
        peer.state = 'open';
        peer.reconnectDelay = pm.config.P2P_RECONNECT_BASE || 2000;
        // A reached peer is no longer unreachable: drop it back to the fast
        // ceiling so the next real outage is noticed promptly.
        peer.failures  = 0;
        peer.lastError = null;
        pm.emit('peer:connect', addr);
        logger.info('Connected to peer: ' + addr);
    });

    ws.on('message', (raw) => pm.handleInbound(ws, raw, addr));
    ws.on('pong', () => { ws._isAlive = true; });

    ws.on('close', (code, reason) => {
        if (peer.state === 'open') {
            pm.emit('peer:disconnect', addr);
            let reasonStr = reason && reason.length ? reason.toString() : '';
            logger.info('Peer disconnected: ' + addr + ' (code=' + code + ', reason="' + reasonStr + '")');
        }
        peer.state = 'closed';
        peer.ws = null;
        pm.scheduleReconnect(addr);
    });

    // Do NOT log here. A dial that is refused by design (a federation port
    // whose peers are staged but not launched) emits one of these per peer per
    // retry, and at error level that buries everything real in the same log.
    // The message is stashed and reported once per backoff step instead, by
    // scheduleReconnect, which is the only place that knows how many times in
    // a row this peer has failed and how long the next wait is.
    ws.on('error', (e) => {
        peer.lastError = (e && e.message) ? e.message : String(e);
    });
}

class PeerConnections {

    async start() {
        let port = this.config.P2P_PORT || 10001;
        let host = this.config.P2P_HOST || '0.0.0.0';

        // Plain HTTP on this port answers ONLY the mirror-snapshot reads, and only
        // once api.js has wired them. Everything else gets 404 rather than being
        // left to hang on an open socket (the pre-feed behaviour of a handler-less
        // server), so a stray probe cannot hold a connection open.
        this.httpServer = http.createServer((req, res) => serveFeedRequest(this, req, res));
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: this.config.P2P_MAX_PAYLOAD || 1048576 });

        this.httpServer.on('upgrade', (req, socket, head) => {
            // Mirror subscribers are handed to the API's own upgrade path (auth,
            // then HubDbBroadcaster). They never enter the gossip WebSocket server,
            // so a feed client is never in this.peers: it cannot be broadcast to,
            // relayed to, counted in any quorum, or pinged as a peer.
            if (this.isFeedUpgrade(req)) {
                if (this.feedUpgradeHandler) this.feedUpgradeHandler(req, socket, head);
                else socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
        });

        this.wss.on('connection', (ws, req) => acceptInboundSocket(this, ws, req));

        await new Promise((resolve, reject) => {
            this.httpServer.listen(port, host, () => {
                logger.info('P2P listening on ' + host + ':' + port);
                resolve();
            });
            this.httpServer.on('error', reject);
        });

        this.running = true;
        dialSeedPeers(this, host);

        this.startHeartbeat();
        this.startDedupPruner();
        this.startPingInterval();
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

    connectToPeer(addr) {
        // Validate peer address format: optional ws:// or wss:// prefix, then host:port
        if (!/^(wss?:\/\/)?[\w.\-]+:\d+$/.test(addr)) {
            logger.warn('P2P: Invalid peer address format: ' + addr);
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
            logger.error(nodeUtil.format('Failed to create WebSocket to ' + addr + ':', e));
            this.scheduleReconnect(addr);
            return;
        }

        ws._isAlive = true;

        wireOutboundSocket(this, addr, peer, ws);

        peer.ws = ws;
    }

    scheduleReconnect(addr) {
        if (!this.running) return;

        let peer = this.peers.get(addr);
        if (!peer || peer.inbound) return;

        let delay = peer.reconnectDelay || (this.config.P2P_RECONNECT_BASE || 2000);
        let jitter = Math.floor(Math.random() * delay * 0.25);
        let totalDelay = delay + jitter;

        peer.failures = (peer.failures || 0) + 1;

        peer.reconnectTimer = setTimeout(() => {
            peer.reconnectTimer = null;
            this.connectToPeer(addr);
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
        logger.warn('P2P: peer ' + addr + ' unreachable (' + peer.failures +
            ' consecutive failure' + (peer.failures === 1 ? '' : 's') +
            (peer.lastError ? ', last error: ' + peer.lastError : '') +
            '); next attempt in ' + Math.round(totalDelay / 1000) + 's');
    }
}

module.exports = PeerConnections;
