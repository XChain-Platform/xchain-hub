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
const { onCapabilitySnapshotWritten } = require('../../lib/capability_snapshot_write.js');
const { XSNP_SIGN_REQ, XSNP_SIGN, XSNP_FINALIZED } = require('./constants.js');
const {
    SNAPSHOT_LEADER_SKIP,
    snapshotLeaderDecision,
} = require('./leader.js');
const { pickDueSnapshot } = require('./due.js');
const { learnBtcChainId } = require('./chain_identity.js');
const { snapshotCheckpointFromBlockHashes } = require('./payload.js');
const { createSnapshotSignedRecord } = require('./signed_record.js');
const snapshotRound = require('./round.js');

const logger = getLogger();
const SNAPSHOT_CHECKPOINT_ACTIVATION =
    'anchor/snapshot_checkpoint/engine.SNAPSHOT_CHECKPOINT_ACTIVATION';
const DUE_LIMIT = 10;
const REGTEST_FALLBACK_POLL_MS = 1000;
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
        this.tickRequested = false;
        this.pollTimer = null;
        this.fallbackTimer = null;
        this.stopWrittenListener = null;
        this.skipLogKeys = new Map();
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
        // A capability set written to this hub's db is checkpointed as soon as it commits.
        // On the poll alone it would wait a full CHECKPOINT_POLL_MS, and the state
        // checkpoint engine that writes the oracle_publish set polls on the same interval
        // and was started just before this one, so this scan ran before each new set
        // existed and every set was checkpointed one poll late.
        if (!this.stopWrittenListener) {
            this.stopWrittenListener = onCapabilitySnapshotWritten(db => {
                if (db === this.db && this.gateHeight() !== gateRegistry.UNARMED) this.requestTick();
            });
        }
    }

    async stop() {
        if (this.stopWrittenListener) this.stopWrittenListener();
        this.stopWrittenListener = null;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
        this.fallbackTimer = null;
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

    localPubkey() {
        const pubkey = this.identity && typeof this.identity.getPubkeyHex === 'function'
            ? this.identity.getPubkeyHex()
            : null;
        return typeof pubkey === 'string' ? pubkey.toLowerCase() : pubkey;
    }

    // A tick asked for outside the poll. One that arrives while a tick runs is kept and run
    // after it, since the running tick may have scanned before the new set was written.
    requestTick() {
        if (this.ticking) {
            this.tickRequested = true;
            return;
        }
        this.tick().catch(error => logger.error(nodeUtil.format(
            'SnapshotCheckpointEngine: tick error:', error && error.message)));
    }

    noteSkip(reason, fields = {}) {
        const snapshotBlock = Number.isSafeInteger(fields.snapshotBlock)
            ? fields.snapshotBlock
            : 'unknown';
        const blockIndex = Number.isSafeInteger(fields.blockIndex)
            ? fields.blockIndex
            : 'unknown';
        const sender = typeof fields.sender === 'string' && fields.sender.length > 0
            ? fields.sender.toLowerCase()
            : 'local';
        const key = [reason, snapshotBlock, blockIndex, sender].join('|');
        if (this.skipLogKeys.has(key)) return false;
        this.skipLogKeys.set(key, true);
        while (this.skipLogKeys.size > 512)
            this.skipLogKeys.delete(this.skipLogKeys.keys().next().value);

        let detail = '';
        if (Number.isSafeInteger(fields.rank)) detail += ', rank ' + fields.rank;
        if (Number.isSafeInteger(fields.waitBlocks))
            detail += ', waits ' + fields.waitBlocks + ' more BTC block' +
                (fields.waitBlocks === 1 ? '' : 's');
        logger.info('SnapshotCheckpointEngine: skipped BTC/' + this.network + '/' +
            blockIndex + ' snapshot ' + snapshotBlock + ': ' + reason + detail +
            (sender === 'local' ? '' : ', sender ' + sender));
        return true;
    }

    // Fast regtest rails can cross the fallback threshold before the ordinary poll or
    // the next capability-snapshot write. Re-read while work is waiting; the block-based
    // decision above remains the authority and production networks keep their normal poll.
    scheduleFallbackTick() {
        if (this.fallbackTimer || !this.pollTimer) return;
        const delay = this.network === 'regtest'
            ? Math.min(this.pollMs, REGTEST_FALLBACK_POLL_MS)
            : this.pollMs;
        this.fallbackTimer = setTimeout(() => {
            this.fallbackTimer = null;
            this.requestTick();
        }, delay);
        if (this.fallbackTimer.unref) this.fallbackTimer.unref();
    }

    // Checkpoints every due snapshot this hub can finish alone, oldest first, up to
    // DUE_LIMIT, and stops at the first that needs a round, belongs to another leader or
    // is refused. One per tick could never clear a backlog: the hub writes a new set each
    // cadence interval, so a single missed poll left every later set one poll late.
    async tick() {
        if (this.ticking || !this.identity || !this.db) return;
        this.ticking = true;
        try {
            // Before the scan: the scan only lists sets stamped with the stored chain id.
            await learnBtcChainId(this);
            for (let i = 0; i < DUE_LIMIT; i++) {
                if (!await this.checkpointNextDue()) break;
            }
        } finally {
            this.ticking = false;
            if (this.tickRequested) {
                this.tickRequested = false;
                this.requestTick();
            }
        }
    }

    // One due snapshot: true only when this hub alone stored a new checkpoint for it.
    async checkpointNextDue() {
        const rows = await this.db.listUncheckpointedSnapshotBlocks(
            this.network, this.gateHeight(), CANONICAL_REORG_BUFFER, DUE_LIMIT);
        const btcTip = await this.btcTip();
        const due = pickDueSnapshot(snapshotBlocks(rows), {
            inFlight: this.snapshotRounds.size > 0,
            gateActive: block => this.gateActive(block),
            blockOf: block => snapshotCheckpointBlock(block, this.network),
            btcTip,
            confirmations: this.confirmations,
        });
        if (!due) return false;

        const validators = await this.resolveValidators(due.snapshot_block);
        const myPubkey = this.localPubkey();
        const overdue = Number(btcTip) - due.block_index - this.confirmations;
        const decision = snapshotLeaderDecision(
            due.block_index, validators, myPubkey, overdue);
        if (!decision.leads) {
            this.noteSkip(decision.reason, {
                snapshotBlock: due.snapshot_block,
                blockIndex: due.block_index,
                rank: decision.rank,
                waitBlocks: decision.waitBlocks,
            });
            if (decision.reason === SNAPSHOT_LEADER_SKIP.FALLBACK_WAIT ||
                decision.reason === SNAPSHOT_LEADER_SKIP.MISSING_DEPTH) {
                this.scheduleFallbackTick();
            }
            return false;
        }
        const rank = decision.rank;
        if (rank > 0) {
            logger.info('SnapshotCheckpointEngine: leading BTC/' + this.network + '/' +
                due.block_index + ' as fallback ' + rank + ', ' + overdue + ' blocks past due');
        }

        const block = await this.indexerCall('getblockhashes', {
            block_index: due.block_index,
        });
        const cp = snapshotCheckpointFromBlockHashes(
            this.network, block, due.block_index);
        if (!cp) {
            logger.warn('SnapshotCheckpointEngine: refusing rootless or malformed BTC block ' +
                due.block_index);
            return false;
        }
        if (!await this.claimPayload(cp)) return false;

        const signature = {
            pubkey: myPubkey,
            sig: this.identity.sign(snapshotCheckpointCanonical(cp)),
        };
        if (validators.length === 1) return this.persistSoleCheckpoint(cp, signature);
        await this.leadRound(cp, validators, due.snapshot_block, signature);
        return false;
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
        if (inserted) return true;
        const stored = await this.db.getSnapshotCheckpoint(
            cp.chain, cp.network, cp.block_index);
        if (!payloadMatches(stored, cp)) {
            logger.error('SnapshotCheckpointEngine: concurrent checkpoint conflict at BTC/' +
                cp.network + '/' + cp.block_index);
        }
        return false;
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
