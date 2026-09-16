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
 * XChain Hub - hub DB sync channel, REST snapshot routes.
 *
 * Indexers running in distributed mode bootstrap their local hub DB from these
 * pages before subscribing to the WebSocket channel (src/api/server.js) for live
 * updates. Routes are mounted in their original order behind one auth hook.
 *
 ********************************************************************/

const crypto = require('crypto');
const nodeUtil = require('node:util');
const { HUB_SCHEMA_VERSION } = require('../../hub_schema_version');   // stamped on every mirror snapshot so a stale indexer rejects a mismatch
const { buildOraclePricesSnapshotQuery } = require('../../oracle/prices_snapshot_query');   // page (indexer bootstrap) vs latest-per-feed (dashboard) query selection
const { validateLimit, validateSince } = require('../validate');

function mountSnapshotRoutes(app, ctx) {
    const helpers = snapshotHelpers(ctx);
    mountSnapshotAuth(app, ctx);
    mountPriceSnapshots(app, ctx, helpers);
    mountMatchSnapshots(app, ctx, helpers);
    mountCallCheckpointSnapshots(app, ctx, helpers);
    mountBridgeSnapshots(app, ctx, helpers);
    mountAttestSnapshots(app, ctx, helpers);
}

// The admission watermark and the Bitcoin chain identity every page can carry.
function snapshotHelpers({ hub, HUB_NETWORK }) {
    // The per-table per-chain admission height watermark, for the REST carriers.
    //
    // It rides all TEN snapshot pages as well as the heartbeat and the ready frame:
    // a poll-mode consumer never receives a heartbeat at all, so without it a poll-mode
    // bootstrap never establishes a baseline and every height-keyed barrier defers forever
    // rather than for one interval.
    //
    // Fail-closed by construction: a hub whose broadcaster is not up yet serves {}, which
    // reads as no claim on every chain and every table.
    function admissionHeightsForSnapshot() {
        try {
            if (hub.hubDbBroadcaster && typeof hub.hubDbBroadcaster.admissionHeights === 'function')
                return hub.hubDbBroadcaster.admissionHeights();
        } catch (err) { /* a watermark that cannot be read is a watermark that claims nothing */ }
        return {};
    }

    // The identity of the Bitcoin chain this hub follows (hash of that chain's block 1),
    // learned from the Bitcoin indexer's pushchaintip. It rides the three cross-chain
    // envelopes because a DOGE/LTC mirror cannot derive it locally: the envelope is the
    // only place it can learn which chain the rows it is being handed belong to. Never
    // fails a snapshot: an unreadable identity is served as "unknown" (null), which every
    // mirror accepts exactly as it accepted rows before the column existed.
    async function btcChainIdForSnapshot() {
        try {
            if (!hub.db || typeof hub.db.getChainTip !== 'function') return null;
            let tip = await hub.db.getChainTip('bitcoin', (hub && hub.network) ? hub.network : HUB_NETWORK);
            return (tip && tip.chainId) ? tip.chainId : null;
        } catch (err) {
            return null;
        }
    }

    return { admissionHeightsForSnapshot, btcChainIdForSnapshot };
}

function mountSnapshotAuth(app, { HUB_API_KEY }) {
    // Hub DB sync channel: REST snapshot endpoints
    // Indexers running in distributed mode bootstrap their local hub DB by fetching these snapshots
    // before subscribing to the WebSocket channel for live updates.
    //
    // Auth (seq 3517): gate every /hub-db/snapshot/* GET behind HUB_API_KEY WHEN
    // IT IS SET, mirroring the JSON-RPC write-method guard above and the WebSocket
    // upgrade guard below. Unset key => unauthenticated (unchanged behavior for a
    // public bootstrap hub / regtest / xchain-node-managed deploys that inject no
    // key); set key => these endpoints fail closed (401) so a production federation
    // can lock its hub-DB mirror to authenticated indexers. The indexer's hub_db_sync
    // bootstrap sends the key as `x-api-key` (matching the write-method header), so
    // we check the same header with the same constant-time compare.
    app.use('/hub-db/snapshot', (req, res, next) => {
        if (!HUB_API_KEY) return next();
        let provided = req.headers['x-api-key'] || '';
        let a = Buffer.from(provided), b = Buffer.from(HUB_API_KEY);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    });
}

function mountPriceSnapshots(app, ctx, helpers) {
    const { hub, logger, bigIntReplacer } = ctx;
    const { admissionHeightsForSnapshot } = helpers;
    app.get('/hub-db/snapshot/price_snapshots', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.findPriceSnapshotsById(since, limit);
            res.type('json').send(JSON.stringify({ table: 'price_snapshots', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    app.get('/hub-db/snapshot/oracle_prices', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            // `latest=1` serves the dashboard's current-per-feed need (MAX(effective_at)
            // per coin/tick/fiat); absent it, the default ascending since_id page-walk
            // (indexer bootstrap) is unchanged. See oraclePricesSnapshotQuery.js.
            let latest = req.query.latest === '1' || req.query.latest === 'true';
            // method is one of the two oracle_prices statements in db/oracle.js, picked
            // by the builder from a fixed pair, never a name taken from the request.
            let { method, params, mode } = buildOraclePricesSnapshotQuery({
                latest,
                since: req.query.since_id ? parseInt(req.query.since_id) : 0,
                limit: req.query.limit ? parseInt(req.query.limit) : undefined,
            });
            let rows = await hub.db[method](...params);
            res.type('json').send(JSON.stringify({ table: 'oracle_prices', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), mode: mode, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });
}

function mountMatchSnapshots(app, ctx, helpers) {
    const { hub, logger, bigIntReplacer } = ctx;
    const { admissionHeightsForSnapshot, btcChainIdForSnapshot } = helpers;
    app.get('/hub-db/snapshot/cross_chain_matches', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            // Exclude retracted rows: the streaming path DELETEs them on reorg
            // (retractMatchesForReorg marks status='retracted' for the ANCHOR archive and
            // broadcasts a deletion), so a bootstrapping mirror must skip them too or it
            // diverges byte-for-byte from a long-running streamed mirror. status<>'retracted'
            // (not ='finalized') excludes exactly what the stream deletes and keeps every
            // other status the stream retains.
            let rows = await hub.db.findCrossChainMatchesById(since, limit);
            res.type('json').send(JSON.stringify({ table: 'cross_chain_matches', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION, btc_chain_id: await btcChainIdForSnapshot() }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    app.get('/hub-db/snapshot/capability_snapshots', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.findCapabilitySnapshotsById(since, limit);
            res.type('json').send(JSON.stringify({ table: 'capability_snapshots', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION, btc_chain_id: await btcChainIdForSnapshot() }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });
}

function mountCallCheckpointSnapshots(app, ctx, helpers) {
    const { hub, logger, bigIntReplacer } = ctx;
    const { admissionHeightsForSnapshot, btcChainIdForSnapshot } = helpers;
    // GET /hub-db/snapshot/cross_chain_calls: full snapshot of cross_chain_calls table.
    // Explicit column list: batch_seq/archived_status/anchor_txid are hub-side ANCHOR
    // audit metadata and are NOT mirrored (the indexer mirror schema has no such columns).
    // finalizing_view (signed into the EQUIV canonical) and push_generation (source-chain
    // reorg fence, item 5308) ARE mirror-consumed and MUST be included, or a freshly
    // bootstrapped mirror rebuilds the wrong EQUIV view and mis-fences reorg retractions.
    // btc_chain_id is mirror-consumed for the same reason: it is what the mirror's
    // chain-identity filter reads, so omitting it would silently disarm that filter for
    // every bootstrapped row while the streamed (SELECT *) path kept it.
    app.get('/hub-db/snapshot/cross_chain_calls', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            // Exclude retracted rows (see the cross_chain_matches snapshot above): the
            // streaming path DELETEs them on reorg (retractCallsForReorg), so a bootstrapping
            // mirror must skip them to stay byte-identical with streamed mirrors.
            let rows = await hub.db.findCrossChainCallsById(since, limit);
            res.type('json').send(JSON.stringify({ table: 'cross_chain_calls', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION, btc_chain_id: await btcChainIdForSnapshot() }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/state_checkpoints: full snapshot of state_checkpoints table.
    // Explicit column list: the four SPV root columns (state_root, state_root_version,
    // block_merkle_root, block_merkle_version) are mirror-consumed and MUST be included,
    // or a REST-bootstrapped mirror holds NULL roots while a streamed mirror (WS SELECT *)
    // holds them, and the XCHECKPOINT canonical rebuilt from the bootstrapped row drops
    // the root suffix and fails 2f+1 signature verification post CHECKPOINT_COMMITMENT
    // flag-day. anchor_txid stays excluded: it is hub-side audit metadata and is NOT
    // mirrored (the indexer mirror schema has no such column).
    app.get('/hub-db/snapshot/state_checkpoints', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.findStateCheckpointsById(since, limit);
            res.type('json').send(JSON.stringify({ table: 'state_checkpoints', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });
}

function mountBridgeSnapshots(app, ctx, helpers) {
    const { hub, logger, bigIntReplacer } = ctx;
    const { admissionHeightsForSnapshot, btcChainIdForSnapshot } = helpers;
    // GET /hub-db/snapshot/bridge_transfers: bootstrap snapshot of the signed transfer
    // records (the base bridge spec section 6). SELECT * deliberately, as the
    // cross_chain_matches sibling does: every column on this table is mirror-consumed
    // (finalizing_view rebuilds the EQUIV header VIEW, push_generation fences reorg
    // retractions, btc_chain_id arms the mirror's chain-identity filter, tick and decimals
    // are signed content), so an explicit list could only ever drop one of them silently.
    //
    // Retracted rows are excluded for the reason the two siblings above give: the streaming
    // path DELETEs them on reorg, so a bootstrapping mirror must skip them or it diverges
    // byte-for-byte from a long-running streamed mirror.
    app.get('/hub-db/snapshot/bridge_transfers', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.findBridgeTransfers(since, limit);
            res.type('json').send(JSON.stringify({ table: 'bridge_transfers', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION, btc_chain_id: await btcChainIdForSnapshot() }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/policy_snapshots: bootstrap snapshot of the signed per-token
    // policy snapshots (the token bridge policy spec section 5). No status
    // filter, unlike the two tables above: this one is APPEND-ONLY with no retraction path
    // (a later policy_seq supersedes, the state_checkpoints shape), so the stream deletes
    // nothing here and a bootstrap that filtered would diverge from a streamed mirror in
    // the opposite direction.
    app.get('/hub-db/snapshot/policy_snapshots', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.findPolicySnapshots(since, limit);
            res.type('json').send(JSON.stringify({ table: 'policy_snapshots', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION, btc_chain_id: await btcChainIdForSnapshot() }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });
}

function mountAttestSnapshots(app, ctx, helpers) {
    const { hub, logger, bigIntReplacer } = ctx;
    const { admissionHeightsForSnapshot } = helpers;
    // GET /hub-db/snapshot/anchor_reward_attestations: full snapshot of the
    // anchor-reward attestation table. Explicit column list (id-parity mirror; the BTC
    // indexer rebuilds the XANCPUB canonical from reward_type/round_reference/snapshot_block/
    // publisher and re-verifies publisher_attestations against its OWN oracle_publish set).
    app.get('/hub-db/snapshot/anchor_reward_attestations', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.findAnchorRewardAttestations(since, limit);
            res.type('json').send(JSON.stringify({ table: 'anchor_reward_attestations', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/attestation_responses: full snapshot of the finalized
    // ATTEST responses the mirror carries instead of a validator-paid on-chain
    // transaction (the ATTEST response mirror design).
    //
    // Explicit column list, for the reason spelled out on state_checkpoints above:
    // this feed and the WS stream must deliver the SAME column set, and a star select (every column)
    // drifts them apart the moment the hub table gains a column the broadcaster does
    // not send. Every column below is mirror-consumed - the indexer re-verifies
    // `signatures` over a canonical rebuilt from `effective_time`/`response_hash`/
    // `status` and applies the row on `request_id` - so nothing here is hub-side
    // audit metadata that could be trimmed. `id` is the paging cursor only: the
    // consumer strips it on apply, because two hubs carry different ids for the
    // same logical row (natural-key mirror on `network` + `request_id`).
    //
    // No status filter, unlike cross_chain_matches and cross_chain_calls: this table
    // is insert-only and never retracted, so the stream deletes nothing a
    // bootstrapping mirror would have to skip.
    app.get('/hub-db/snapshot/attestation_responses', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.findAttestationResponsesById(since, limit);
            res.type('json').send(JSON.stringify({ table: 'attestation_responses', rows: rows, count: rows.length, heights: admissionHeightsForSnapshot(), watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION }, bigIntReplacer));
        } catch (err) {
            logger.error(nodeUtil.format('hub snapshot endpoint error:', err));
            res.status(500).json({ error: 'snapshot error' });
        }
    });
}

module.exports = { mountSnapshotRoutes };
