'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which connected peers peer catch-up may read from: open sessions whose pubkey is in the
// effective signer set or the validator registry, each with the feed URL to page from.

// An inbound peer has no dialed address, so its announced validator address is the only
// feed URL; accept it only when it is an absolute URL carrying no credentials.
function dialableAnnouncedFeedUrl(value) {
    if (typeof value !== 'string' || !/^(?:wss?|https?):\/\//i.test(value)) return null;
    try {
        const url = new URL(value);
        return url.hostname && !url.username && !url.password ? value : null;
    } catch (e) { return null; }
}

function connectedSignerPeers(peerManager) {
    if (!peerManager || !peerManager.peers || !peerManager.validatorPubkeys) return [];
    const signerSet = peerManager.effectiveSignerSet;
    const peers = [];
    for (const [addr, peer] of peerManager.peers) {
        if (!peer || (peer.state !== 'open' && peer.state !== 'connected')) continue;
        const identity = peer.validatorAddr || addr;
        const pubkey = peerManager.validatorPubkeys.get(identity) || peer.signing_pubkey;
        if (!pubkey) continue;
        const normalizedPubkey = String(pubkey).toLowerCase();
        const inSignerSet = signerSet && signerSet.has(normalizedPubkey);
        const inRegistry = typeof peerManager.registryHasPubkey === 'function' &&
            peerManager.registryHasPubkey(normalizedPubkey);
        if (!inSignerSet && !inRegistry) continue;
        const feedUrl = peer.feedUrl ||
            (peerManager.validatorFeedUrls && peerManager.validatorFeedUrls.get(identity)) ||
            (peer.inbound ? dialableAnnouncedFeedUrl(identity) : addr);
        peers.push({ addr, identity, feedUrl });
    }
    return peers;
}

module.exports = { connectedSignerPeers, dialableAnnouncedFeedUrl };
