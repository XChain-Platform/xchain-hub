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
 *********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const gateRegistry = require('../../consensus/gate_registry.js');
const {
    CANONICAL_REORG_BUFFER,
} = require('../../consensus/snapshot_reorg_buffer.js');
const {
    snapshotCheckpointBlock,
    snapshotCheckpointCanonical,
} = require('../../consensus/snapshot_checkpoint/canonical.js');
const { getLogger } = require('../../observability');
const { XSNP_SIGN_REQ, XSNP_SIGN, XSNP_FINALIZED } = require('./constants.js');
const { leadsSnapshotSlot } = require('./leader.js');
const { pickDueSnapshot } = require('./due.js');
const { snapshotCheckpointFromBlockHashes } = require('./payload.js');
const { createSnapshotSignedRecord } = require('./signed_record.js');
const snapshotRound = require('./round.js');

const logger = getLogger();
const SNAPSHOT_CHECKPOINT_ACTIVATION =
    'anchor/snapshot_checkpoint/engine.SNAPSHOT_CHECKPOINT_ACTIVATION';
const DUE_LIMIT = 10;
const HEX_64 = /^[0-9a-f]{64}$/i;

function payloadMatches(left, right) {
    if (!left || !right) return false;
    try {
        return snapshotCheckpointCanonical(left) === snapshotCheckpointCanonical(right);
    } catch (_) {
        return false;
    }
}

function snapshotBlocks(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(row => row && typeof row === 'object' ? row.snapshot_block : row);
}

function distinctValidators(validators) {
    if (!Array.isArray(validators)) return [];
    const byPubkey = new Map();
    for (const validator of validators) {
        const pubkey = validator && typeof validator.pubkey === 'string'
            ? validator.pubkey.toLowerCase()
            : '';
        if (HEX_64.test(pubkey) && !byPubkey.has(pubkey)) {
            byPubkey.set(pubkey, Object.assign({}, validator, { pubkey }));
        }
    }
    const result = [...byPubkey.values()].sort((left, right) =>
        left.pubkey.localeCompare(right.pubkey));
    if (validators.truncated === true) result.truncated = true;
    return result;
}

class SnapshotCheckpointEngine {

    constructor(stateCheckpoints) {
        this.source = stateCheckpoints;
        this.hub = stateCheckpoints && stateCheckpoints.hub;
        this.db = stateCheckpoints && (stateCheckpoints.db || this.hub && this.hub.db);
        this.identity = stateCheckpoints && (stateCheckpoints.identity ||
            this.hub && this.hub.getIdentity && this.hub.getIdentity());
        this.peerManager = stateCheckpoints && (stateCheckpoints.peerManager ||
            this.hub && this.hub.getPeerManager && this.hub.getPeerManager());
        this.network = stateCheckpoints && (stateCheckpoints.network ||
            this.hub && this.hub.network);
        const config = this.hub && this.hub.p2pConfig || {};
        this.confirmations = numberOption(
            stateCheckpoints && stateCheckpoints.confirmations,
            config.CHECKPOINT_CONFIRMATIONS, 6, true);
        this.pollMs = numberOption(
            stateCheckpoints && stateCheckpoints.pollMs,
            config.CHECKPOINT_POLL_MS, 60000, false);
        this.roundTimeoutMs = numberOption(
            stateCheckpoints && stateCheckpoints.roundTimeoutMs,
            config.CHECKPOINT_ROUND_TIMEOUT_MS, 60000, false);
        this.signedRecord = createSnapshotSignedRecord();
        this.ticking = false;
        this.pollTimer = null;
        snapshotRound.initialize(this);
    }

    async start() {
        if (!this.source || !this.db) return;
        snapshotRound.start(this);
        this.pollTimer = setInterval(() => {
            this.tick().catch(error => logger.error(nodeUtil.format(
                'SnapshotCheckpointEngine: tick error:', error && error.message)));
        }, this.pollMs);
        if (this.pollTimer.unref) this.pollTimer.unref();
    }

    async stop() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        snapshotRound.stop(this);
    }

    // The floor of the uncheckpointed-snapshot scan, resolved exactly as gateActive's
    // activeAt resolves it: the 'BTC:<network>' entry first, then the bare network.
    // A table armed only by its coin-scoped entry (the v0.25.0 testnet re-slide keeps
    // `testnet: UNARMED` beside 'BTC:testnet') would otherwise scan from UNARMED and
    // never checkpoint a snapshot, leaving every proof-gated mirror row held.
    gateHeight() {
        const table = gateRegistry.get(SNAPSHOT_CHECKPOINT_ACTIVATION);
        const coinKey = 'BTC:' + this.network;
        const height = !table ? undefined
            : Object.prototype.hasOwnProperty.call(table, coinKey) ? table[coinKey]
                : Object.prototype.hasOwnProperty.call(table, this.network) ? table[this.network]
                    : undefined;
        return Number.isSafeInteger(height) && height >= 0
            ? height
            : gateRegistry.UNARMED;
    }

    gateActive(snapshotBlock) {
        return gateRegistry.activeAt(
            SNAPSHOT_CHECKPOINT_ACTIVATION, this.network, 'BTC', snapshotBlock, 0);
    }

    async btcTip() {
        if (this.source && typeof this.source.resolveSnapshotBlock === 'function')
            return this.source.resolveSnapshotBlock();
        if (this.hub && typeof this.hub.resolveBtcLatestBlock === 'function')
            return this.hub.resolveBtcLatestBlock();
        return null;
    }

    async indexerCall(method, params) {
        if (!this.source || typeof this.source.indexerCall !== 'function') {
            throw new Error('BTC indexer unavailable');
        }
        return this.source.indexerCall('BTC', method, params);
    }

    async resolveValidators(snapshotBlock) {
        if (!this.source || typeof this.source.resolveCapabilityValidators !== 'function') return [];
        return distinctValidators(await this.source.resolveCapabilityValidators(
            'oracle_publish', snapshotBlock));
    }

    async tick() {
        if (this.ticking || !this.identity || !this.db) return;
        this.ticking = true;
        try {
            const rows = await this.db.listUncheckpointedSnapshotBlocks(
                this.network, this.gateHeight(), CANONICAL_REORG_BUFFER, DUE_LIMIT);
            const due = pickDueSnapshot(snapshotBlocks(rows), {
                inFlight: this.snapshotRounds.size > 0,
                gateActive: block => this.gateActive(block),
                blockOf: block => snapshotCheckpointBlock(block, this.network),
                btcTip: await this.btcTip(),
                confirmations: this.confirmations,
            });
            if (!due) return;

            const validators = await this.resolveValidators(due.snapshot_block);
            const myPubkey = String(this.identity.getPubkeyHex()).toLowerCase();
            if (!leadsSnapshotSlot(due.block_index, validators, myPubkey)) return;

            const block = await this.indexerCall('getblockhashes', {
                block_index: due.block_index,
            });
            const cp = snapshotCheckpointFromBlockHashes(
                this.network, block, due.block_index);
            if (!cp) {
                logger.warn('SnapshotCheckpointEngine: refusing rootless or malformed BTC block ' +
                    due.block_index);
                return;
            }
            if (!await this.claimPayload(cp)) return;

            const signature = {
                pubkey: myPubkey,
                sig: this.identity.sign(snapshotCheckpointCanonical(cp)),
            };
            if (validators.length === 1) {
                await this.persistSoleCheckpoint(cp, signature);
                return;
            }
            await this.leadRound(cp, validators, due.snapshot_block, signature);
        } finally {
            this.ticking = false;
        }
    }

    async claimPayload(cp) {
        const key = [cp.chain, cp.network, cp.block_index].join('|');
        const stored = await this.db.getSnapshotCheckpoint(
            cp.chain, cp.network, cp.block_index);
        if (stored && !payloadMatches(stored, cp)) {
            logger.error('SnapshotCheckpointEngine: refusing a payload conflicting with storage for ' + key);
            return false;
        }
        if (this.signedRecord.claim(cp) !== true) {
            logger.error('SnapshotCheckpointEngine: refusing a second payload for ' + key);
            return false;
        }
        return true;
    }

    async persistSoleCheckpoint(cp, signature) {
        const inserted = await this.db.insertSnapshotCheckpoint(Object.assign({}, cp, {
            validator_signatures: JSON.stringify([signature]),
        }));
        if (inserted) return;
        const stored = await this.db.getSnapshotCheckpoint(
            cp.chain, cp.network, cp.block_index);
        if (!payloadMatches(stored, cp)) {
            logger.error('SnapshotCheckpointEngine: concurrent checkpoint conflict at BTC/' +
                cp.network + '/' + cp.block_index);
        }
    }

    async leadRound(cp, validators, snapshotBlock, signature) {
        return snapshotRound.lead(this, cp, validators, snapshotBlock, signature);
    }
}

function numberOption(primary, secondary, fallback, allowZero) {
    for (const value of [primary, secondary]) {
        const number = Number(value);
        if (Number.isSafeInteger(number) && (allowZero ? number >= 0 : number > 0))
            return number;
    }
    return fallback;
}

module.exports = Object.assign(SnapshotCheckpointEngine, {
    SnapshotCheckpointEngine,
    SNAPSHOT_CHECKPOINT_ACTIVATION,
    XSNP_SIGN_REQ,
    XSNP_SIGN,
    XSNP_FINALIZED,
});
