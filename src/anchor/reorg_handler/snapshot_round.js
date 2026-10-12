/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Reorg handler - stamped federation snapshot and pubkey vote helpers
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const nodeUtil = require('node:util');
const { REORG_ALERT } = require('./message_types.js');
const snapshotLock = require('./snapshot_lock.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    reorgRoundDigest(reorgId, chain, reorgHeight, timestamp, oldHash, newHash, btcBlockHeight) {
        if (btcBlockHeight === null || btcBlockHeight === undefined)
            return this.digest(reorgId, chain, reorgHeight, timestamp, oldHash, newHash);
        let payload = JSON.stringify({
            reorgId, chain, reorgHeight, timestamp, oldHash, newHash, btcBlockHeight
        });
        return crypto.createHash('sha256').update(payload).digest('hex');
    },

    reorgVoteCount(pending, phase) {
        if (pending && pending.snapshotActive) {
            let votes = phase === 'commit' ? pending.commitPubkeys : pending.preparePubkeys;
            return votes instanceof Set ? votes.size : 0;
        }
        let votes = phase === 'commit' ? pending.commits : pending.prepares;
        return votes instanceof Set ? votes.size : 0;
    },

    selfReorgPubkey() {
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        let pubkey = identity && identity.getPubkeyHex ? identity.getPubkeyHex() : null;
        if (snapshotLock.isPubkey(pubkey)) return String(pubkey).toLowerCase();
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        pubkey = registry && registry.get(this.peerManager.validatorAddr);
        return snapshotLock.isPubkey(pubkey) ? String(pubkey).toLowerCase() : null;
    },

    resolveReorgSenderPubkey(envelope) {
        let pubkey = envelope && envelope.sig_pubkey;
        if (!snapshotLock.isPubkey(pubkey)) {
            let registry = this.peerManager && this.peerManager.validatorPubkeys;
            pubkey = registry && envelope ? registry.get(envelope.sender) : null;
        }
        return snapshotLock.isPubkey(pubkey) ? String(pubkey).toLowerCase() : null;
    },

    isFederatedReorg() {
        if ((this.validatorSet || []).length > 1) return true;
        let pubkeys = new Set();
        for (let validator of this.validatorSet || []) {
            if (snapshotLock.isPubkey(validator && validator.pubkey))
                pubkeys.add(String(validator.pubkey).toLowerCase());
        }
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (registry && registry.size > 1) return true;
        if (registry && typeof registry.values === 'function') {
            for (let pubkey of registry.values()) {
                if (snapshotLock.isPubkey(pubkey)) pubkeys.add(String(pubkey).toLowerCase());
            }
        }
        let selfPubkey = this.selfReorgPubkey();
        if (selfPubkey) pubkeys.add(selfPubkey);
        if (pubkeys.size > 1) return true;
        let effective = this.peerManager && this.peerManager.effectiveSignerSet;
        if (effective && effective.size > 1) return true;
        let declared = Number(this.hub && this.hub.p2pConfig && this.hub.p2pConfig.MIN_VALIDATORS);
        if (Number.isFinite(declared) && declared > 1) return true;
        let peers = this.peerManager && this.peerManager.getPeerStatus
            ? this.peerManager.getPeerStatus().filter(peer => peer.state === 'open') : [];
        return peers.length > 0;
    },

    async lockReorgFederationSnapshot(btcBlockHeight, inbound) {
        let network = String(this.network || (this.hub && this.hub.network) || '').toLowerCase();
        let stamped = snapshotLock.readHeight(btcBlockHeight);
        let ownTip = await this.resolveReorgSnapshotTip();
        let ownActive = snapshotLock.isReorgSnapshotActive(ownTip, network);
        let stampedActive = snapshotLock.isReorgSnapshotActive(stamped, network);
        let active = inbound ? (ownActive || stampedActive) : ownActive;
        if (!active && ownTip === null && snapshotLock.isReorgSnapshotRatified(network) &&
                this.isFederatedReorg())
            return this.refuseReorgSnapshot('cannot resolve BTC tip at an active snapshot-lock gate');
        if (!active) return { active: false, refused: false };

        if (inbound) {
            if (!Number.isSafeInteger(btcBlockHeight) || btcBlockHeight < 0 || !stampedActive)
                return this.refuseReorgSnapshot('missing or pre-activation btcBlockHeight');
            if (ownTip === null)
                return this.refuseReorgSnapshot('cannot resolve our BTC tip to bound btcBlockHeight');
            if (Math.abs(ownTip - stamped) > snapshotLock.REORG_SNAPSHOT_TOLERANCE_BLOCKS)
                return this.refuseReorgSnapshot('btcBlockHeight is outside the local tip tolerance');
        } else {
            stamped = ownTip;
        }

        let capabilitySnapshot = this.hub && this.hub.capabilitySnapshot;
        if (!capabilitySnapshot || typeof capabilitySnapshot.getActiveValidatorSnapshot !== 'function') {
            if (!this.isFederatedReorg()) return { active: false, refused: false };
            return this.refuseReorgSnapshot('active-validator snapshot service is unavailable');
        }
        return this.fetchReorgFederationSnapshot(capabilitySnapshot, stamped);
    },

    async resolveReorgSnapshotTip() {
        try {
            return this.hub && this.hub.resolveBtcLatestBlock
                ? snapshotLock.readHeight(await this.hub.resolveBtcLatestBlock()) : null;
        } catch (err) {
            logger.warn(nodeUtil.format('Reorg: cannot resolve BTC tip for snapshot lock:',
                err && err.message));
            return null;
        }
    },

    async fetchReorgFederationSnapshot(capabilitySnapshot, stamped) {
        let snapshot;
        try {
            snapshot = await capabilitySnapshot.getActiveValidatorSnapshot(stamped);
        } catch (err) {
            logger.warn(nodeUtil.format('Reorg: federation snapshot fetch failed at block %s:',
                stamped, err && err.message));
            return this.refuseReorgSnapshot('active-validator snapshot fetch failed');
        }
        let members = snapshotLock.snapshotMemberPubkeys(snapshot);
        if (!members || members.size === 0)
            return this.refuseReorgSnapshot('active-validator snapshot is missing, malformed, or empty');

        let selfPubkey = this.selfReorgPubkey();
        if (!selfPubkey || !members.has(selfPubkey))
            return this.refuseReorgSnapshot('this hub pubkey is not in the stamped federation snapshot');

        return {
            active: true,
            refused: false,
            btcBlockHeight: stamped,
            snapshot,
            members,
            quorum: snapshotLock.snapshotQuorum(members),
            selfPubkey
        };
    },

    refuseReorgSnapshot(reason) {
        logger.warn('Reorg: refusing snapshot-locked federation round: ' + reason);
        return { active: true, refused: true, reason };
    },

    async localReorgSnapshotContext() {
        let context = await this.lockReorgFederationSnapshot(null, false);
        if (context.refused)
            throw new Error('refusing reorg without a deterministic stamped federation snapshot: ' +
                context.reason);
        return context;
    },

    startReportedReorgRound(fields, snapshotContext) {
        let { reorgId, chain, reorgHeight, timestamp, oldHash, newHash,
            observedBlockTimeMs } = fields;
        let alert = { chain, reorgHeight, timestamp, reorgId, oldHash, newHash };
        if (snapshotContext.active) alert.btcBlockHeight = snapshotContext.btcBlockHeight;
        this.peerManager.broadcast(REORG_ALERT, alert);
        let affectedChains = this.getAffectedChains(chain);
        this.initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains,
            oldHash, newHash, observedBlockTimeMs, snapshotContext);
    }
};
