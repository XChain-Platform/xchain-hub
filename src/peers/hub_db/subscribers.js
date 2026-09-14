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
 * XChain Hub - Hub DB Subscriber Registry
 *
 * Who is subscribed to the hub DB mirror stream: admitting a socket under
 * the per-IP and total caps, the 'ready' acknowledgement that hands it the
 * current row ceilings, removal, and the forced resync that drops every
 * socket after a row event this producer could not deliver.
 *
 ********************************************************************/

const { getLogger } = require('../../observability');
const logger = getLogger();

// The per-table max row IDs the 'ready' frame carries. Each read is guarded on its
// own, so a table the schema has not created yet leaves its key absent instead
// of failing the whole acknowledgement.
async function readMaxIds(db) {
    let maxIds = {};
    if (db) {
        try {
            let ps = await db.getPriceSnapshotsMaxId();
            maxIds.price_snapshots = (ps.length > 0 && ps[0].max_id != null) ? Number(ps[0].max_id) : 0;
        } catch (e) { /* table may not exist yet */ }
        try {
            let op = await db.getOraclePricesMaxId();
            maxIds.oracle_prices = (op.length > 0 && op[0].max_id != null) ? Number(op[0].max_id) : 0;
        } catch (e) { /* table may not exist yet */ }
        try {
            // Exclude retracted rows so the advertised max_id matches what the snapshot feed
            // serves (it filters status<>'retracted'); otherwise a retracted max-id row keeps
            // the consumer's gap-detection catch-up firing forever (localMax never reaches it).
            let cm = await db.getCrossChainMatchesMaxLiveId();
            maxIds.cross_chain_matches = (cm.length > 0 && cm[0].max_id != null) ? Number(cm[0].max_id) : 0;
        } catch (e) { /* table may not exist yet */ }
        try {
            let cs = await db.getCapabilitySnapshotsMaxId();
            maxIds.capability_snapshots = (cs.length > 0 && cs[0].max_id != null) ? Number(cs[0].max_id) : 0;
        } catch (e) { /* table may not exist yet */ }
        try {
            let sc = await db.getStateCheckpointsMaxId();
            maxIds.state_checkpoints = (sc.length > 0 && sc[0].max_id != null) ? Number(sc[0].max_id) : 0;
        } catch (e) { /* table may not exist yet */ }
        try {
            // Second member of the indexer's hub-state mirror set (HubDbSync's
            // HUB_STATE_TABLES pairs it with state_checkpoints above; this list must move
            // in lockstep with that one). It is NOT in the consumer's FULL_REPAGE_TABLES,
            // so the since_id cursor plus this advertised ceiling is the only thing that
            // repairs the subscribe-to-bootstrap window for it; with no entry the
            // consumer's catch-up branch is gated off entirely. No status filter: the
            // table is append-only, never retracted, and the snapshot endpoint serves it
            // unfiltered, so an unfiltered MAX(id) is exactly the ceiling that feed reaches.
            let ra = await db.getAnchorRewardAttestationsMaxId();
            maxIds.anchor_reward_attestations = (ra.length > 0 && ra[0].max_id != null) ? Number(ra[0].max_id) : 0;
        } catch (e) { /* table may not exist yet */ }
        try {
            let cc = await db.getCrossChainCallsMaxLiveId();
            maxIds.cross_chain_calls = (cc.length > 0 && cc[0].max_id != null) ? Number(cc[0].max_id) : 0;
        } catch (e) { /* table may not exist yet */ }
        try {
            // Third member of the hub-state mirror set (see anchor_reward_attestations
            // above; this list must move in lockstep with HUB_STATE_TABLES). The catch
            // below is empty by design and therefore silent, so a table name that does
            // not exist leaves the key absent with no log line, and an absent key gates
            // the consumer's gap catch-up for the table OFF entirely.
            // Unfiltered MAX(id), like anchor_reward_attestations and unlike the two
            // cross_chain_* entries: attestation_responses is insert-only and never
            // retracted, so a status filter would advertise a ceiling BELOW what the
            // snapshot feed serves and strand the catch-up.
            let ar = await db.getAttestationResponsesMaxId();
            maxIds.attestation_responses = (ar.length > 0 && ar[0].max_id != null) ? Number(ar[0].max_id) : 0;
        } catch (e) { /* table may not exist yet */ }
    }
    return maxIds;
}

class HubDbSubscribers {

    // Add a new subscriber WebSocket. Sends a 'ready' acknowledgement once the
    // subscriber is registered so the client knows its subscription is active.
    // Includes the current per-table max row IDs (when a DB connection is available)
    // so the client can detect and fill any narrow gap between the subscription point
    // and its subsequent REST bootstrap response.
    async addSubscriber(ws, req) {
        if (this.subscribers.size >= this.maxSubscribers) {
            try { ws.close(1013, 'Too many subscribers'); } catch (e) { /* ignore */ }
            return;
        }
        let ip = req ? (req.socket && req.socket.remoteAddress) || 'unknown' : 'unknown';
        if (!this.ipConnections.has(ip)) this.ipConnections.set(ip, new Set());
        let ipSet = this.ipConnections.get(ip);
        if (ipSet.size >= this.maxPerIp) {
            try { ws.close(1008, 'Too many connections from this IP'); } catch (e) { /* ignore */ }
            return;
        }

        this.subscribers.add(ws);
        ipSet.add(ws);
        ws._hubIp = ip;
        ws._hubBuffered = 0;

        ws.on('close', () => this.removeSubscriber(ws));
        ws.on('error', () => this.removeSubscriber(ws));

        logger.info('HubDbBroadcaster: subscriber added (' + this.subscribers.size + ' total)');

        const maxIds = await readMaxIds(this.db);

        try {
            // watermark_interval_ms lets the consumer size its heartbeat watchdog from
            // the hub's ACTUAL cadence instead of a locally-guessed env default, so an
            // operator raising WS_WATERMARK_INTERVAL_MS on the hub can never make a
            // consumer terminate a healthy socket: the two knobs are linked on the wire,
            // not by a prose comment. Additive: older consumers ignore the field.
            // `heights` rides the ready frame as well as the heartbeat: without it
            // every reconnect stalls every height-keyed barrier for one watermarkIntervalMs
            // before the first heartbeat arrives, on a path that runs after every dropped
            // socket and every resync.
            ws.send(JSON.stringify({ type: 'ready', max_ids: maxIds, watermark: Math.floor(Date.now() / 1000), watermark_interval_ms: this.watermarkIntervalMs, heights: this.admissionHeights() }));
        } catch (e) { /* ignore */ }
    }

    removeSubscriber(ws) {
        if (this.subscribers.has(ws)) {
            this.subscribers.delete(ws);
            let ip = ws._hubIp;
            if (ip && this.ipConnections.has(ip)) {
                let ipSet = this.ipConnections.get(ip);
                ipSet.delete(ws);
                if (ipSet.size === 0) this.ipConnections.delete(ip);
            }
            logger.info('HubDbBroadcaster: subscriber removed (' + this.subscribers.size + ' remaining)');
        }
    }

    // Force every subscriber to reconnect after a row event this producer could NOT
    // deliver. The watermark heartbeat certifies "you have every row produced through
    // ts" on a wall clock that never learns a broadcast was dropped, and a consumer's
    // only gap repair (the max_ids catch-up in its bootstrap) runs at connect time, so
    // a silently-dropped row leaves the consumer certifying completeness past a
    // committed row forever. Closing the socket is the sanctioned repair:
    // the consumer resets its drain gate on close, reconnects, and re-drains from the
    // max_ids in the next 'ready' frame. 1012 (Service Restart) is a retryable close
    // code. Returns how many sockets were dropped, so the caller can log the repair.
    dropAllForResync(reason) {
        let why = reason || 'resync';
        let dropped = 0;
        for (let ws of Array.from(this.subscribers)) {
            try { ws.close(1012, why); } catch (e) { /* ignore */ }
            this.removeSubscriber(ws);
            dropped++;
        }
        if (dropped > 0)
            logger.warn('HubDbBroadcaster: dropped ' + dropped + ' subscriber(s) for resync (' + why + ')');
        return dropped;
    }

    getSubscriberCount() {
        return this.subscribers.size;
    }
}

module.exports = HubDbSubscribers;
