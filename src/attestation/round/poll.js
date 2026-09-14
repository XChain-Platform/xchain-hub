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
 * XChain Hub - Attestation Poll Page
 *
 * What a poll does with the indexer's answer: the page cursor it asks with, the
 * rejection accounting for an answer that carries no usable result, and the
 * admission of the requests in a good page. The eviction passes that run at the
 * top of every poll live here too, because the windows they enforce are the
 * ones the poll's own re-evaluation depends on.
 *
 ********************************************************************/

'use strict';
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

const POLL_LIMIT              = 100;    // max pending requests fetched per poll page (cursor advances across pages)

module.exports = {

    // Page forward from where the last poll left off. When the cursor is
    // null this requests the oldest page; otherwise it asks the indexer for
    // rows strictly after the last (block_index, action_index) we saw.
    pollPageParams(){
        let params = { limit: POLL_LIMIT };
        if(this.pollCursor){
            params.after_block_index  = this.pollCursor.block_index;
            params.after_action_index = this.pollCursor.action_index;
        }
        return params;
    },

    // A poll that never reached a usable answer. Auth failure is distinct from
    // the indexer being down, so it is named rather than folded into the
    // generic transport warning.
    notePollFailure(e, url){
            let status = e && e.response && e.response.status;
            if(status === 401 || status === 403){
                // Auth failure is distinct from the indexer being down: the operator
                // has a key mismatch between the indexer and this hub. Log clearly so
                // they can identify the misconfiguration instead of seeing a generic
                // "unreachable" message and chasing a network issue.
                logger.warn('AttestationRound: HTTP ' + status + ' from BTC indexer at ' + url +
                    ': auth mismatch - check that BTC_INDEXER_API_KEY on this hub matches INDEXER_API_KEY on the indexer');
            } else {
                logger.warn(nodeUtil.format('AttestationRound: poll failed:', e && e.message ? e.message : e));
            }
    },

    notePollRejection(result, url){
            // The indexer answered, so nothing above catches this: an HTTP-200 JSON-RPC
            // rejection (top-level error with no result, or an error nested in the
            // result) would otherwise return in silence. Count it and say so, leaving the
            // early return, the cursor and the in-flight guard untouched: this is
            // instrumentation, not a behaviour change, and no request may be admitted on
            // an error response. Detail wording follows CapabilitySnapshot.rpcErrorDetail:
            // the useful part is WHICH of the two cases happened.
            this.pollRpcErrorCount++;
            let now    = Date.now();
            let detail = !result
                ? 'no JSON-RPC result (empty or non-JSON body)'
                : 'a JSON-RPC error: ' + String((result.error && (result.error.message || result.error))).slice(0, 200);
            if(this._pollRpcWarnAt === 0 || now - this._pollRpcWarnAt >= this.pollMs){
                this._pollRpcWarnAt = now;
                logger.warn('AttestationRound: getpendingattestation_requests returned ' + detail +
                    ' from BTC indexer at ' + url + ' - no attestation requests are being admitted' +
                    ' (rejections so far: ' + this.pollRpcErrorCount + ')');
            }
    },

    // The half of a poll that runs on a usable page: admit every request whose
    // confirmations have landed, then advance (or reset) the sweep cursor.
    admitPendingPage(res, url){
        let result = res && res.data && res.data.result;
        if(!result || result.error){
            this.notePollRejection(result, url);
            return;
        }
        this.lastPollOkAt = Date.now();
        let latestBlock = Number(result.latest_block_index) || 0;
        let requests    = result.requests || [];
        if(latestBlock > 0) this.observedTip = { blockHeight: latestBlock, observedAt: Date.now() };

        for(let req of requests){
            let rid = String(req.request_id || '').toLowerCase();
            if(!rid || this.seen.has(rid)) continue;

            // Wait CONFIRMATIONS blocks past the request's tx before initiating
            // any external API call (spec §14; avoids paying for reorg'd work).
            // Above the zero-conf flag day the effective count is 0 and the request
            // is eligible in the block it was mined in; confirmationsFor takes the
            // REQUEST's block, which is the same height the ladders below key on.
            if(Number(req.block_index) + this.confirmationsFor(req.block_index) > latestBlock) continue;

            this.seen.set(rid, Date.now());
            this._startRound(req, latestBlock).catch(e =>
                logger.error('AttestationRound: start failed for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e))
            );
        }

        // Advance the cursor to the last (highest-ordered) row in this page so
        // the next poll continues past it. A short page (< POLL_LIMIT) means we
        // reached the tail of the queue, so reset to null to restart the sweep
        // from the oldest pending request next cycle. Resetting also lets any
        // row we cursored past but didn't act on (e.g. not yet confirmed) be
        // re-seen on the next sweep.
        if(requests.length > 0){
            let last = requests[requests.length - 1];
            this.pollCursor = { block_index: Number(last.block_index), action_index: Number(last.action_index) };
        }
        if(requests.length < POLL_LIMIT){
            if(this.pollCursor) logger.info('AttestationRound: reached end of pending queue; restarting sweep next poll');
            this.pollCursor = null;
        }
    },

    evictStaleSeen(){
        let cutoff = Date.now() - this.retryAfterMs;
        for(let [rid, ts] of this.seen){
            if(ts < cutoff) this.seen.delete(rid);
        }
    },

    evictStaleRounds(){
        let cutoff = Date.now() - this.roundsTtlMs;
        for(let [rid, st] of this.rounds){
            if(st && typeof st.proposedAt === 'number' && st.proposedAt < cutoff){
                this.rounds.delete(rid);
            }
        }
    },

    evictStaleLeaderSilence(){
        let cutoff = Date.now() - this.roundsTtlMs;
        for(let [rid, rec] of this.leaderSilence){
            if(rec && typeof rec.updatedAt === 'number' && rec.updatedAt < cutoff){
                this.leaderSilence.delete(rid);
            }
        }
    }

};
