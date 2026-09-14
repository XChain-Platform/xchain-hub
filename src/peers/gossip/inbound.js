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
 * XChain Hub - P2P Inbound Messages
 *
 * Everything an arriving frame passes before the fan-out sees it: JSON and
 * shape, replay freshness, the per-peer rate ceiling, signature verification
 * and its two distinct rejections, peer registration, and the relay onward.
 *
 ********************************************************************/

const WebSocket = require('ws');
const nodeUtil = require('node:util');
const { notePeerReject, stampRemoteIp } = require('../../consensus/diagnostics');
const { getLogger } = require('../../observability');
const logger = getLogger();

// The envelope a frame carries, or null when it is not one this hub will look
// at: unparseable, the wrong shape, or timestamped outside the replay window.
function parseInboundEnvelope(pm, rawData) {
    let envelope;
    try {
        envelope = JSON.parse(rawData);
    } catch (e) {
        logger.warn(nodeUtil.format('P2P: Invalid JSON from peer:', e));
        return null;
    }

    // Guard against non-object JSON values (null, number, string, boolean)
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return null;

    if (!envelope.type || typeof envelope.type !== 'string') return null;
    if (!envelope.id   || typeof envelope.id !== 'string')   return null;
    if (!envelope.sender || typeof envelope.sender !== 'string') return null;
    if (typeof envelope.timestamp !== 'number') return null;

    // Timestamp freshness: drop envelopes too far from our clock in either
    // direction. maxSkew is capped at the dedup TTL so a signed envelope
    // cannot be replayed inside the [dedup-expiry, maxSkew] window after its
    // dedup entry is pruned. (Anti-replay for the Option A signed-envelope
    // surface.) Default dedup TTL is 60s; default skew is also 60s.
    let dedupTTL = parseInt(pm.config.P2P_MSG_DEDUP_TTL) || 60000;
    let maxSkew  = Math.min(parseInt(pm.config.P2P_MSG_MAX_SKEW_MS) || dedupTTL, dedupTTL);
    if (Math.abs(Date.now() - envelope.timestamp) > maxSkew) return null;
    return envelope;
}

// The per-peer rate ceiling. False means the message was dropped by it.
function admitMessageRate(pm, ws, envelope, knownAddr) {
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
    let rateCeil = pm.peers.has(knownAddr || ws._peerAddr) ? pm.knownMsgRateLimit : pm.msgRateLimit;
    if (!pm.checkMsgRate(ratePeer, rateCeil)) {
        logger.warn('P2P: Rate limit exceeded for peer ' + ratePeer + '; dropping message');
        notePeerReject({ peer: ratePeer, reason: 'rate_limit' });
        return false;
    }
    return true;
}

// The two faults that share the drop path, named apart for the operator whose
// peer is being dropped.
function reportUnverified(pm, ws, envelope, verdict) {
    let peer = ws._remoteIp || envelope.sender;
    if (verdict.reason === 'not_in_signer_set') {
        let blocks = pm.constructor.stakeActivationBlocks(pm.config.HUB_NETWORK);
        logger.warn('P2P: sender not in signer set (no active stake or registry entry): ' +
            envelope.sender + '; dropping message' +
            (blocks === null ? '' : ' (a STAKE activates ' + blocks +
                ' blocks after the transaction confirms)'));
        notePeerReject({ peer: peer, reason: 'not_in_signer_set' });
        return;
    }
    logger.warn('P2P: Invalid signature from ' + envelope.sender + '; dropping message');
    notePeerReject({ peer: peer, reason: 'invalid_signature' });
    return;
}

// The fan-out itself, plus the two typed side channels that ride it.
function emitInboundEvents(pm, ws, envelope) {
    // Consensus sees only the envelope, never the socket, so the one
    // identity a remote cannot mint is stamped on here. Non-enumerable and
    // Symbol-keyed, so it cannot reach a persisted row, a re-broadcast
    // payload or a signature preimage through JSON.stringify.
    stampRemoteIp(envelope, ws._remoteIp);
    pm.emit('message', envelope);
    if (envelope.type === 'HEARTBEAT') {
        pm.emit('heartbeat', envelope.sender, envelope.timestamp, envelope.data);
        pm.notePeerRules(envelope);
    }
    // Capability gossip; see CapabilityRegistry.
    if (envelope.type === 'CAPABILITY_ACTIVATED' ||
        envelope.type === 'CAPABILITY_DEACTIVATED' ||
        envelope.type === 'CAPABILITY_SELF_TEST') {
        pm.emit('capability', envelope);
    }
}

class PeerInbound {

    handleInbound(ws, rawData, knownAddr) {
        const envelope = parseInboundEnvelope(this, rawData);
        if (!envelope) return;

        // Self-connection guard
        if (envelope.sender === this.validatorAddr) {
            if (ws._peerAddr === null) {
                ws.close(1000, 'self-connection');
            }
            return;
        }

        if (this.seenIds.has(envelope.id)) return;
        this.addToDedup(envelope.id);
        if (!admitMessageRate(this, ws, envelope, knownAddr)) return;

        // Two very different faults share this return path: a key we do not
        // authenticate at all (never staked, stake not yet activated, wrong key)
        // and a signature that fails to verify. The peer being dropped only ever
        // sees OUR log line, so the two are named apart; the drop itself, and the
        // membership-before-crypto order that produces it, are unchanged. No extra
        // throttling here: the per-peer rate limit above already bounds this line,
        // exactly as it did for the single invalid-signature message.
        let verdict = {};
        if (!this.verifySignature(envelope, verdict)) {
            reportUnverified(this, ws, envelope, verdict);
            return;
        }

        if (knownAddr === null && ws._peerAddr === null) {
            ws._peerAddr = envelope.sender;
            this.registerInboundPeer(ws, envelope.sender);
        }

        let peerAddr = knownAddr || ws._peerAddr || envelope.sender;
        let peer = this.peers.get(peerAddr);
        if (peer) {
            peer.lastSeen = Date.now();
        }

        // Update DB (fire and forget). validator_id is peerAddr (the immediate ws peer
        // that delivered the message), NOT envelope.sender. The latter is the original
        // publisher and will diverge from peerAddr on relayed messages.
        this.recordPeer(peerAddr, peerAddr, false);
        emitInboundEvents(this, ws, envelope);

        this.relay(envelope, ws);
    }

    // Relay a message to all peers except the source ws and the original sender.
    // Skipping the sender prevents the message from echoing back to the originator
    // via a different ws (e.g., our outbound to a peer who reached us via their
    // outbound), which both wastes bandwidth and trips the self-connection guard
    // on the other side when the receiving ws is freshly opened.
    relay(envelope, sourceWs) {
        let serialized = JSON.stringify(envelope);
        for (let [addr, peer] of this.peers) {
            if (addr === envelope.sender) continue;
            if (peer.ws && peer.ws !== sourceWs && peer.ws.readyState === WebSocket.OPEN) {
                this._send(peer.ws, serialized);
            }
        }
    }

    registerInboundPeer(ws, addr) {
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
        logger.info('Inbound peer connected: ' + addr);
    }

    removeInboundPeer(ws) {
        // Only the peers-map cleanup is gated on ws._peerAddr. That field is set in
        // registerInboundPeer, which runs only once an inbound frame has cleared the
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
                logger.info('Inbound peer disconnected: ' + addr);

                // Clean up if it was inbound-only (no reconnect for inbound)
                if (peer.inbound) {
                    this.peers.delete(addr);
                }
            }
        }

        // Decrement per-IP connection count. Clearing ws._remoteIp makes the release
        // idempotent: a counter decremented twice under-counts just as permanently as
        // one never decremented at all, and nothing reads the field after close (the
        // rate-key read in handleInbound is message-time only).
        if (ws._remoteIp) {
            let count = (this.ipConnectionCounts.get(ws._remoteIp) || 1) - 1;
            if (count <= 0) this.ipConnectionCounts.delete(ws._remoteIp);
            else this.ipConnectionCounts.set(ws._remoteIp, count);
            ws._remoteIp = null;
        }
    }
}

module.exports = PeerInbound;
