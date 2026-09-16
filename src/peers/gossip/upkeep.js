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
 * XChain Hub - P2P Upkeep
 *
 * The periodic work that keeps the mesh honest: the heartbeat that
 * advertises this hub's rules digest, liveness pings, and the bounded dedup
 * and rate-limit caches the pruner keeps from growing forever.
 *
 ********************************************************************/

const rulesDigest = require('../../consensus_rules_digest.js');
const WebSocket = require('ws');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

class PeerUpkeep {

    startHeartbeat() {
        let interval = this.config.P2P_HEARTBEAT_INTERVAL || 15000;
        let version = '0.0.0';
        try { version = require('../../../package.json').version; } catch(e) {}
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

    startDedupPruner() {
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

    startPingInterval() {
        this.pingTimer = setInterval(() => {
            // Ping outbound dialed peers only. Inbound peers also live in this.peers
            // (after registerInboundPeer) but are pinged via wss.clients below.
            // Pinging them here as well would race the two loops and terminate the
            // inbound ws.
            for (let [addr, peer] of this.peers) {
                if (peer.inbound) continue;
                if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
                    if (peer.ws._isAlive === false) {
                        logger.info('Peer ' + addr + ' failed ping/pong; terminating');
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
    addToDedup(id) {
        if (this.seenIds.size >= this.dedupCacheMax) {
            let oldest = this.seenIds.keys().next().value;
            this.seenIds.delete(oldest);
        }
        this.seenIds.set(id, Date.now() + (this.config.P2P_MSG_DEDUP_TTL || 60000));
    }

    checkMsgRate(addr, limit) {
        let max = (limit != null) ? limit : this.msgRateLimit;
        let now = Date.now();
        let entry = this.peerMsgCounts.get(addr);
        if (!entry || (now - entry.windowStart) > 60000) {
            // Hard size cap as a backstop to the interval pruner: evict the oldest
            // bucket if the map is full so a burst of distinct keys between prune
            // cycles cannot grow it without bound (mirrors addToDedup).
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
    recordPeer(addr, validatorId, isSeed) {
        if (!this.db) return;
        this.db.setP2pPeer(addr, validatorId, isSeed ? 1 : 0)
            .catch(e => logger.error(nodeUtil.format('Error recording peer:', e)));
    }
}

module.exports = PeerUpkeep;
