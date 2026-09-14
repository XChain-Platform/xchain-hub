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
 * XChain Hub - Attestation Fetch Cache
 *
 * The durable, request_id-keyed record of what this hub already paid a provider
 * for. A restart inside a round window would otherwise re-pay, and on a
 * non-deterministic provider re-sign a different body under the same request.
 *
 ********************************************************************/

'use strict';
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ----- Durable fetch cache -----
    //
    // Fail-OPEN, deliberately, and unlike AttestationPublisher's spend WAL: this
    // table only prevents paying a second time for the same fetch, so a DB fault
    // must degrade to today's behavior (fetch again) rather than drop a round.
    // Every method below therefore swallows its error and returns the
    // no-cache answer.
    cacheCutoffEpochSec(){
        return Math.floor((Date.now() - this.retryAfterMs) / 1000);
    },

    // The recorded outcome for a request, or null when there is none, it has
    // aged past the retry window, or the DB is unreachable.
    async readFetchCache(rid){
        if(!this.db || typeof this.db.doQuery !== 'function') return null;
        try {
            let rows = await this.db.findAttestationFetchCache(rid, this.cacheCutoffEpochSec());
            let row = (rows && rows.length) ? rows[0] : null;
            if(!row) return null;
            // Providers return { body: Buffer, meta: string } and agree() drops a
            // proposal whose body is not a Buffer, so restore the BLOB as one.
            return {
                status: String(row.status || 'ok'),
                body:   Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body || ''),
                meta:   (row.meta === null || row.meta === undefined) ? '' : String(row.meta)
            };
        } catch (e) {
            logger.warn(nodeUtil.format('AttestationRound: fetch-cache read failed for ' + String(rid).substring(0,16) +
                         '...; falling back to a fresh fetch:', e && e.message ? e.message : e));
            return null;
        }
    },

    // Upsert the completed outcome, success and provider_error alike: a durable
    // error is what keeps a restart from re-proposing a different answer for a
    // round that already carries this hub's signed non-ok proposal.
    async writeFetchCache(rid, providerId, status, fetched, model){
        if(!this.db || typeof this.db.doQuery !== 'function') return;
        try {
            let body = (fetched && fetched.body !== null && fetched.body !== undefined)
                ? fetched.body : Buffer.alloc(0);
            if(!Buffer.isBuffer(body)) body = Buffer.from(String(body));
            let meta = (fetched && fetched.meta !== null && fetched.meta !== undefined)
                ? String(fetched.meta) : '';
            await this.db.setAttestationFetchCache(rid, String(providerId || ''), String(status || 'ok'), body, meta, model ? String(model) : null);
        } catch (e) {
            logger.warn(nodeUtil.format('AttestationRound: fetch-cache write failed for ' + String(rid).substring(0,16) +
                         '...; a restart may re-pay this fetch:', e && e.message ? e.message : e));
        }
    },

    // Bound growth on the same window `seen` uses; a finalized or expired round
    // has no further use for its recorded fetch.
    async evictStaleFetchCache(){
        if(!this.db || typeof this.db.doQuery !== 'function') return;
        try {
            await this.db.deleteAttestationFetchCache(this.cacheCutoffEpochSec());
        } catch (e) {
            logger.warn(nodeUtil.format('AttestationRound: fetch-cache eviction failed:', e && e.message ? e.message : e));
        }
    }

};
