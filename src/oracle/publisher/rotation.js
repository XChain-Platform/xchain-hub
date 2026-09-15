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
 * XChain Hub - Oracle Publisher: leader rotation and the v0 payload
 *
 * Who publishes: this hub's rank in the block-pinned oracle_publish snapshot, and
 * the degenerate local-signature fallback with the v0 wire it builds.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Determine this node's rank in the sorted oracle_publish validator list, or null if not active
    // Sort order: signing_pubkey ascending (deterministic across all nodes that share the active set)
    async getMyRank(blockIndex) {
        if (!this.identity) return null;
        let myPubkey = String(this.identity.getPubkeyHex()).toLowerCase();
        let pubkeys = await this.getActiveOraclePublishPubkeys(blockIndex);
        let idx = pubkeys.indexOf(myPubkey);
        return idx >= 0 ? idx : null;
    },

    // Transition-only warn for the capability-snapshot fail-closed paths. Called
    // once per finalized round, so a persistent fault would otherwise log every
    // round; emit only on the transition INTO dark and reset on the next successful
    // resolution. The fail-closed [] return itself is never changed by this.
    logSnapshotDark(detail, err) {
        if (this._snapshotDark) return;
        this._snapshotDark = true;
        let suffix = err ? (': ' + (err && err.message ? err.message : err)) : '';
        logger.warn('OraclePublisher: oracle_publish capability snapshot ' + detail +
            '; failing closed, this hub will not publish until it resolves' + suffix);
    },

    // Get the count of active oracle_publish validators
    async getActiveOraclePublishCount(blockIndex) {
        let pubkeys = await this.getActiveOraclePublishPubkeys(blockIndex);
        return pubkeys.length;
    },

    // Get the sorted list of active oracle_publish validator signing pubkeys at
    // the given block boundary. Uses the on-chain snapshot (via CapabilitySnapshot)
    // so every hub that has processed identical on-chain data through blockIndex
    // returns the same array regardless of when gossip messages arrived.
    // Fails closed (returns []) when the block-pinned snapshot is unresolved.
    // Returns: array of 64-hex pubkey strings, sorted ascending.
    async getActiveOraclePublishPubkeys(blockIndex) {
        if (!this.hub) return [];

        // Primary: deterministic on-chain snapshot at blockIndex
        if (this.hub.capabilitySnapshot && blockIndex !== undefined && blockIndex !== null) {
            try {
                let snapshot = await this.hub.capabilitySnapshot.getSnapshot('oracle_publish', blockIndex);
                if (snapshot && Array.isArray(snapshot.validators)) {
                    this._snapshotDark = false;
                    return snapshot.validators
                        .map(v => String(v.pubkey).toLowerCase())
                        .sort();
                }
                // Snapshot resolved to null. This is the dominant dark path:
                // CapabilitySnapshot.getSnapshot returns null (does NOT throw) when the
                // indexer is unreachable, the result is an error, or the echoed block
                // mismatches, so it never reaches the catch below. Left silent, the
                // publisher stops publishing with no trace. Log the transition so a dark
                // publisher is distinguishable in the hub log from a hub that legitimately
                // is not an oracle_publish validator. The [] return is unchanged.
                this.logSnapshotDark('resolved to null at block ' + blockIndex, null);
            } catch (err) {
                // Fail closed: fall through to []. Log the transition (once per dark
                // spell) so a persistent throw leaves a trace instead of failing silent.
                this.logSnapshotDark('threw at block ' + blockIndex, err);
            }
        }

        // Fail closed on a pinned-block miss. The old live-registry fallback
        // (capabilityRegistry.getActiveValidators) is block-unpinned and filtered on
        // qualified/self_test_ok/enabled over gossip-driven rows, so it is a per-hub
        // view of "now": two hubs would rank/size the round-robin over different sets
        // (duplicate PRICE v0 broadcast + duplicate DOGE fee, or a dropped round). The
        // caller already treats myRank === null as "not a publisher". Matches the
        // accepted fix for #686/#925/#930.
        return [];
    },

    // Fallback: build a single-validator signature locally if the round event didn't carry any.
    // Only used in degenerate cases; normal operation collects sigs from consensus prepare/commit.
    buildLocalSigOnly(event) {
        if (!this.identity) return [];
        try {
            let payload = this.buildSignablePayload(event.round, event.btcBlockTime, event.prices, event.btcBlockHeight);
            let sigHex  = this.identity.sign(payload);
            return [{ pubkey: this.identity.getPubkeyHex(), sig: sigHex }];
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: failed to build local sig:', e));
            return [];
        }
    },

    // Build the canonical signable payload. Must match indexer's ed25519.buildPriceV0Payload
    // (including the EQUIV header gate on the round's BTC block height, #4232). The height
    // is part of the signed content; only the bare-JSON branch is built here because this
    // local-sig fallback is degenerate (no EQUIV-era round reaches it on a real federation),
    // and the canonical-byte equality with the indexer is enforced by the consensus path.
    buildSignablePayload(round, timestamp, prices, btcBlockHeight) {
        let pairs = prices.map(p => ({ pair: p.coinPair, price: String(p.price) }));
        let sortedPairs = pairs.sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
        return JSON.stringify({
            round:            parseInt(round),
            timestamp:        parseInt(timestamp),
            btc_block_height: parseInt(btcBlockHeight),
            pairs:            sortedPairs
        });
    },

    // Build the on-wire PRICE v0 payload as a pipe-delimited string
    // Format: PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...
    // BTC_BLOCK_HEIGHT is the round's BTC anchor (the EQUIV gate input, in the signed payload).
    buildPriceV0Wire(round, timestamp, prices, sigs, btcBlockHeight) {
        let parts = ['PRICE', '0', String(round), String(timestamp), String(parseInt(btcBlockHeight)), String(prices.length)];
        for (let p of prices) {
            parts.push(p.coinPair || p.pair);
            parts.push(String(p.price));
        }
        parts.push(String(sigs.length));
        for (let s of sigs) {
            parts.push(s.pubkey);
            parts.push(s.sig);
        }
        return parts.join('|');
    },

};
