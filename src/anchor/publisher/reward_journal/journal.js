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
 * ANCHOR publisher - restart-surviving journal of deferred reward attestations
 *
 * Every entry in the deferred reward-attestation queue (reward_defer.js) is also
 * kept as one consensus_state row until the drain settles it, and start() rebuilds
 * the queue from those rows, so a restart inside the DOGE confirmation window keeps
 * the reward.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { getLogger } = require('../../../observability');
const logger = getLogger();

// consensus_state key prefix for one pending reward attestation. The queue key
// (reward type, round, snapshot block, publisher, txid) is far longer than the
// table's 64-character key_name, so a digest of it follows the prefix.
const REWARD_JOURNAL_PREFIX = 'xancreward_pending:';
const REWARD_JOURNAL_DIGEST_CHARS = 44;

// Persisted, not rebuilt from chain: the XANCPUB quorum the row carries is held only
// in the attestation round's memory, and no DOGE indexer RPC serves the v0/v1 tail.
// These are the fields the drain needs after a restart; `at` keeps the TTL counting
// from the first queueing.
const JOURNAL_FIELDS = ['chain', 'network', 'blockIndex', 'checkpointSeq', 'txid', 'anchorVersion',
                        'rewardType', 'roundReference', 'snapshotBlock', 'publisher', 'attestSigs',
                        'federate', 'at'];

function journalKey(key){
    let digest = crypto.createHash('sha256').update(String(key)).digest('hex');
    return REWARD_JOURNAL_PREFIX + digest.slice(0, REWARD_JOURNAL_DIGEST_CHARS);
}

function journalValue(key, e){
    let entry = {};
    for(let f of JOURNAL_FIELDS) if(e[f] !== undefined) entry[f] = e[f];
    return JSON.stringify({ key: key, entry: entry });
}

// One stored row back to { key, entry }, or null for a row that is not a whole entry.
// A restored entry still earns nothing on its own: the drain re-proves its anchor
// mined and bound before it writes, exactly as for an entry queued in this process.
function parseJournalRow(row){
    let saved;
    try { saved = JSON.parse(row.value); } catch(_e){ return null; }
    let e = saved && saved.entry;
    if(!e || typeof saved.key !== 'string' || journalKey(saved.key) !== String(row.key_name)) return null;
    if(!e.txid || !e.publisher || !Array.isArray(e.attestSigs) || e.attestSigs.length === 0) return null;
    if(!Number.isFinite(Number(e.at))) return null;
    return { key: saved.key, entry: Object.assign({}, e, { at: Number(e.at) }) };
}

module.exports = {

    // In-flight journal writes by queue key, so a drop can wait for the row it deletes.
    rewardJournalWrites(){
        if(!this._rewardJournalWrites) this._rewardJournalWrites = new Map();
        return this._rewardJournalWrites;
    },

    // Store one queued entry. Never throws: a failed write leaves the entry in memory,
    // where the drain still proves and writes it unless the process restarts first.
    persistDeferredRewardAttest(key, e){
        let value = journalValue(key, e);
        let write = Promise.resolve()
            .then(() => this.db.setConsensusState(journalKey(key), value, value))
            .then(() => true, (err) => {
                logger.warn('StateAnchorPublisher: could not journal reward attestation ' + key + ' (' +
                            (err && err.message) + '); it is held in memory only and a restart forfeits it');
                return false;
            });
        this.rewardJournalWrites().set(key, write);
        return write;
    },

    // Take an entry out of the queue (synchronously, for the queue-full path) and delete
    // its row after the row's own write settles, so a late INSERT cannot revive it on the
    // next boot. Never throws: a row left behind is restored and re-proved, and a
    // repeated attestation write is an INSERT IGNORE no-op.
    async dropDeferredRewardAttest(key){
        this._deferredRewardAttest.delete(key);
        let writes = this.rewardJournalWrites();
        let pending = writes.get(key);
        writes.delete(key);
        if(pending) await pending;
        try {
            await this.db.deleteConsensusState(journalKey(key));
        } catch(err){
            logger.warn('StateAnchorPublisher: could not delete the journal row of reward attestation ' + key +
                        ' (' + (err && err.message) + '); the next boot restores and re-proves it');
        }
    },

    // Rebuild the queue from the journal once per process (start(), or the next drain if
    // that read failed). Entries keep their original `at`, so the TTL and the watermark
    // hold in deferredRewardAttestFloor count from the first queueing, and the queue is
    // re-ordered oldest first for the queue-full drop.
    async restoreDeferredRewardAttest(){
        if(this._rewardJournalRestored) return true;
        let rows;
        try {
            rows = await this.db.findConsensusStateByPrefix(REWARD_JOURNAL_PREFIX);
        } catch(err){
            logger.warn('StateAnchorPublisher: could not read the reward-attestation journal (' +
                        (err && err.message) + '); the next drain retries');
            return false;
        }
        let saved = (Array.isArray(rows) ? rows : []).map(parseJournalRow).filter(Boolean)
            .filter(s => !this._deferredRewardAttest.has(s.key));
        let merged = [...this._deferredRewardAttest].concat(saved.map(s => [s.key, s.entry]))
            .sort((a, b) => Number(a[1].at) - Number(b[1].at));
        this._deferredRewardAttest.clear();
        for(let [key, e] of merged) this._deferredRewardAttest.set(key, e);
        this._rewardJournalRestored = true;
        if(saved.length > 0)
            logger.info('StateAnchorPublisher: restored ' + saved.length + ' pending reward attestation(s) ' +
                        'from the journal; each is re-proved on DOGE before its row is written');
        return true;
    }

};
