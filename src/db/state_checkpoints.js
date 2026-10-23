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
 * XChain Hub - query methods for the state checkpoint table.
 *
 * Owns src/sql/state_checkpoints.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

// The newest anchor-eligible, not-yet-anchored checkpoint per (chain, network): its
// checkpoint ORDINAL (seq divided by the cadence step) is divisible by the anchor stride.
// Moved here from src/anchor/publisher.js:1065.
//
// The SQL is unchanged from the per-chain era ON PURPOSE (D24). The
// `anchor_txid IS NULL` predicate sits OUTSIDE the MAX subquery: pushing it in
// would resurrect older un-anchored seqs that the chained hashes have already
// superseded. Do not move it.
const PENDING_ANCHOR_CHECKPOINTS_SQL =
    'SELECT sc.* FROM state_checkpoints sc JOIN (' +
    '  SELECT chain, network, MAX(checkpoint_seq) AS max_seq FROM state_checkpoints' +
    '  WHERE MOD(FLOOR(checkpoint_seq / ?), ?) = 0 GROUP BY chain, network' +
    ') t ON sc.chain = t.chain AND sc.network = t.network AND sc.checkpoint_seq = t.max_seq ' +
    'WHERE sc.anchor_txid IS NULL';

module.exports = {
    // Checkpoints the ANCHOR archive still owes a batch to. The table is append-only (a
    // reorged height gets a new row at a higher checkpoint_seq), so an unstamped row is
    // the whole pending predicate. Ordered as the archive array is.
    async findStateCheckpointsByBatchSeq(limit) {
        return this.doQuery(
            'SELECT * FROM state_checkpoints WHERE batch_seq IS NULL ' +
            'ORDER BY chain ASC, network ASC, checkpoint_seq ASC LIMIT ?', [limit]);
    },

    // Stamps the archive batch a checkpoint was published in, once. Guarded on
    // batch_seq IS NULL so a row an earlier round already covered keeps its seq.
    async updateStateCheckpointArchiveBatchSeq(batchSeq, chain, network, checkpointSeq) {
        return this.doQuery(
            'UPDATE state_checkpoints SET batch_seq = ? ' +
            'WHERE chain = ? AND network = ? AND checkpoint_seq = ? AND batch_seq IS NULL',
            [batchSeq, chain, network, checkpointSeq]);
    },

    // Inserts a row into state_checkpoints.
    // Moved here from src/anchor/checkpoint_engine.js:907.
    async createStateCheckpoint(chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures) {
        return this.doQuery('INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures]);
    },

    // Reads rows from state_checkpoints.
    // Moved here from src/api.js:2174.
    async findStateCheckpointsById(since, limit) {
        return this.doQuery('SELECT id, chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures, created_at FROM state_checkpoints WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    // Reads rows from state_checkpoints.
    // Moved here from src/anchor/checkpoint_engine.js:370.
    async findStateCheckpointsByNetwork(network) {
        return this.doQuery('SELECT chain, MAX(block_index) AS last_finalized_block, MAX(checkpoint_seq) AS last_seq FROM state_checkpoints WHERE network = ? GROUP BY chain', [network]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/anchor/publisher.js:2562.
    async getLatestStateCheckpoint() {
        return this.doQuery(`SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC, checkpoint_seq DESC, snapshot_block DESC, block_index DESC LIMIT 1`);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/anchor/publisher.js:1815, src/anchor/publisher.js:2168, src/anchor/publisher.js:2358, src/anchor/publisher.js:3099, src/anchor/publisher.js:3197, src/anchor/publisher.js:4644.
    async getStateCheckpointByChain(chain, network, block_index, checkpoint_seq) {
        return this.doQuery('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1', [chain, network, block_index, checkpoint_seq]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/anchor/publisher.js:3504.
    async getStateCheckpointByChainAndNetwork(chain, network, block_index) {
        return this.doQuery('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? ORDER BY checkpoint_seq DESC LIMIT 1', [chain, network, block_index]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/anchor/checkpoint_engine.js:1141.
    async getStateCheckpointByChainAndNetworkAndCheckpointSeq(chain, network, checkpoint_seq) {
        return this.doQuery('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ? LIMIT 1', [chain, network, checkpoint_seq]);
    },

    // The lowest-height checkpoint of one chain at or above a block, the latest sequence at
    // that height winning as the table's reorg rule does.
    async getFirstStateCheckpointAtOrAbove(chain, network, blockIndex) {
        return this.doQuery('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index >= ? ORDER BY block_index ASC, checkpoint_seq DESC LIMIT 1', [chain, network, blockIndex]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/anchor/publisher.js:2559.
    async getStateCheckpointByNetwork(network) {
        return this.doQuery(`SELECT * FROM state_checkpoints WHERE network = ? ORDER BY (chain = 'BTC') DESC, checkpoint_seq DESC, snapshot_block DESC, block_index DESC LIMIT 1`, [network]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/anchor/checkpoint_engine.js:1123.
    async getStateCheckpointsMaxCheckpointSeq(chain, network) {
        return this.doQuery('SELECT MAX(checkpoint_seq) AS max_seq FROM state_checkpoints WHERE chain = ? AND network = ?', [chain, network]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/peers/hub_db_broadcaster.js:651.
    async getStateCheckpointsMaxId() {
        return this.doQuery('SELECT MAX(id) AS max_id FROM state_checkpoints');
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/anchor/checkpoint_engine.js:428.
    async getStateCheckpointsMaxSnapshotBlock(network) {
        return this.doQuery('SELECT MAX(snapshot_block) AS last_block FROM state_checkpoints WHERE network = ?', [network]);
    },

    // Updates state_checkpoints.
    // Moved here from src/anchor/publisher.js:1329, src/anchor/publisher.js:3240.
    async updateStateCheckpoint(txid, chain, network, block_index, checkpoint_seq) {
        return this.doQuery('UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid IS NULL', [txid, chain, network, block_index, checkpoint_seq]);
    },

    async updateStateCheckpointClearStamp(txid, chain, network, block_index, checkpoint_seq) {
        return this.doQuery('UPDATE state_checkpoints SET anchor_txid = NULL WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid = ?', [chain, network, block_index, checkpoint_seq, txid]);
    },

    // Counts sections at this snapshot block, on any network, stamped by a transaction other
    // than `txid`. validator_rewards carries no network, so any such stamp may back the reward.
    async countOtherAnchorStampsAtSnapshotBlock(snapshot_block, txid) {
        const rows = await this.doQuery('SELECT COUNT(*) AS n FROM state_checkpoints WHERE snapshot_block = ? AND anchor_txid IS NOT NULL AND anchor_txid <> ?', [snapshot_block, txid]);
        return Number(rows && rows[0] ? rows[0].n : 0);
    },

    // Reads the pending anchor checkpoints across every network, for a hub with no
    // configured network (the legacy unscoped behavior).
    // Moved here from src/anchor/publisher.js:1065, the unscoped branch.
    async findAnchorEligibleUnanchoredCheckpoints(checkpointIntervalBlocks, anchorEveryNCheckpoints) {
        return this.doQuery(PENDING_ANCHOR_CHECKPOINTS_SQL, [checkpointIntervalBlocks, anchorEveryNCheckpoints]);
    },

    // Reads the pending anchor checkpoints of one network, so a hub DB carrying rows from a
    // prior network deployment never re-elects publishers for a dead network's checkpoints.
    // Moved here from src/anchor/publisher.js:1065, the network-scoped branch.
    async findAnchorEligibleUnanchoredCheckpointsByNetwork(checkpointIntervalBlocks, anchorEveryNCheckpoints, network) {
        return this.doQuery(PENDING_ANCHOR_CHECKPOINTS_SQL + ' AND sc.network = ?', [checkpointIntervalBlocks, anchorEveryNCheckpoints, network]);
    },

    // Per chain of one network, the oldest snapshot_block among the anchor-eligible
    // checkpoints above the newest anchored one: the content the v0 bundle has owed since
    // its last anchor. Superseded rows below an anchor are never stamped, so the anchored
    // seq bounds the age; without an anchor, the first eligible checkpoint starts the age.
    async findOldestUnanchoredCheckpointBlocksByNetwork(checkpointIntervalBlocks, anchorEveryNCheckpoints, network) {
        return this.doQuery(
            'SELECT sc.chain, MIN(sc.snapshot_block) AS oldest_block FROM state_checkpoints sc LEFT JOIN (' +
            '  SELECT chain, network, MAX(checkpoint_seq) AS anchored_seq FROM state_checkpoints' +
            '  WHERE anchor_txid IS NOT NULL AND network = ? GROUP BY chain, network' +
            ') a ON sc.chain = a.chain AND sc.network = a.network ' +
            'WHERE sc.network = ? AND sc.anchor_txid IS NULL ' +
            'AND (a.anchored_seq IS NULL OR sc.checkpoint_seq > a.anchored_seq) ' +
            'AND MOD(FLOOR(sc.checkpoint_seq / ?), ?) = 0 GROUP BY sc.chain',
            [network, network, checkpointIntervalBlocks, anchorEveryNCheckpoints]);
    }
};

if(require.main === module){
    const { test } = require('node:test');
    const assert = require('node:assert/strict');
    const ValidatorIdentity = require('../validators/identity.js');
    const canonicalForms = require('../anchor/publisher/canonical_forms.js');
    const ladderMethods = require('../anchor/publisher/ladder/bundle_content_age.js');
    const attestMethods = require('../anchor/publisher/attest_round.js');
    const { getLogger } = require('../observability');

    test('a never-anchored follower co-signs unlocked rank 1 and explains a locked decline', async () => {
        const network = 'regtest';
        const identities = Array.from({ length: 4 }, () => new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
        const byPubkey = new Map(identities.map(identity => [identity.getPubkeyHex(), identity]));
        const electionSet = identities.map(identity => identity.getPubkeyHex());
        const electionKey = 'never-anchored-follower';
        const order = canonicalForms.hashOrder(electionKey, electionSet);
        const checkpoints = [];
        for(let block = 106, seq = 8; block <= 136; block += 6, seq++)
            checkpoints.push({ chain: 'BTC', network, snapshot_block: block, checkpoint_seq: seq,
                               block_index: 900 + seq, anchor_txid: null });
        const row = checkpoints[checkpoints.length - 1];
        let capturedSql = '';
        const db = {
            async findOldestUnanchoredCheckpointBlocksByNetwork(...args){
                return module.exports.findOldestUnanchoredCheckpointBlocksByNetwork.call({
                    doQuery: async sql => {
                        capturedSql = sql;
                        assert.equal(checkpoints.some(checkpoint => checkpoint.anchor_txid !== null), false);
                        return [{ chain: 'BTC', oldest_block: checkpoints[0].snapshot_block }];
                    }
                }, ...args);
            },
            async getStateCheckpointByChain(){ return [row]; }
        };
        const sent = [];
        const follower = Object.assign({}, ladderMethods, attestMethods, {
            db,
            identity: byPubkey.get(order[3]),
            hub: { resolveBtcLatestBlock: async () => 142 },
            checkpointIntervalBlocks: 1,
            anchorEveryNCheckpoints: 1,
            peerManager: { broadcast: type => sent.push(type) },
            bundleElectionKey: () => electionKey,
            rankUnlocked: (rankOrder, sender, age) => rankOrder.indexOf(sender) <= Math.floor(age / 36),
            getActiveOraclePublishPubkeys: async () => electionSet,
            findAnchorEligibleSections: async () => [row],
            buildV7Payload: (rows, publisher) => JSON.stringify([rows[0].checkpoint_seq, publisher]),
            attestationCanonical: (bundle, publisher) => 'XANCPUB|' + bundle.network + '|' + publisher,
            claimAttestSlot: async () => true
        });
        const request = publisher => {
            const identity = byPubkey.get(publisher);
            const canonical = follower.attestationCanonical({ network }, publisher);
            return { data: {
                network, snapshot_block: row.snapshot_block,
                sections: [{ chain: row.chain, block_index: row.block_index, checkpoint_seq: row.checkpoint_seq }],
                body: follower.buildV7Payload([row], publisher),
                publisher, sig_pubkey: publisher, sig: identity.sign(canonical)
            } };
        };

        const contentBlock = await follower.bundleContentBlock(network, [row]);
        assert.equal(contentBlock, 106);
        assert.equal(follower.bundleLadderBlock([row], 142, contentBlock) - row.snapshot_block, 36);
        assert.match(capturedSql, /LEFT JOIN/);
        assert.match(capturedSql, /a\.anchored_seq IS NULL OR sc\.checkpoint_seq > a\.anchored_seq/);
        assert.equal(await follower.handleAttestSignReq(request(order[1])), true);
        assert.equal(sent.filter(type => type === 'XANCPUB_SIGN').length, 1);

        const warnings = [];
        const logger = getLogger();
        const warn = logger.warn;
        logger.warn = message => warnings.push(String(message));
        try { await follower.handleAttestSignReq(request(order[2])); }
        finally { logger.warn = warn; }
        assert.equal(sent.filter(type => type === 'XANCPUB_SIGN').length, 1);
        assert.ok(warnings.some(message => message.includes('reason=publisher_rank_locked') &&
                                           message.includes('publisher=' + order[2])));
    });
}
