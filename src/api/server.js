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
 * XChain Hub - the HTTP server, the hub DB sync WebSocket and shutdown.
 *
 * Wraps the finished express app: the upgrade handler that feeds
 * HubDbBroadcaster, the telemetry retention and keep-alive timers, the
 * read-only feed on the public P2P port, listen, and the signal handlers that
 * drain all of it.
 *
 ********************************************************************/

const crypto = require('crypto');
const nodeUtil = require('node:util');
const jsonRouter = require('express-json-rpc-router');
const { noteShutdown } = require('../consensus/diagnostics');
const { resolveMaxBatch, makeRpcBatchGuard } = require('../peers/rpc_batch_guard.js');
const { installMiddleware } = require('./middleware');
const { buildRpcController } = require('./rpc');
const { mountSnapshotRoutes } = require('./rest/hub_db_snapshot');
const { mountTelemetryRoutes } = require('./rest/telemetry');
const { mountRegistryRoutes } = require('./rest/registry');

function createApp(ctx) {
    const { express, hubConfig } = ctx;
    const app = express();
    const observability = installMiddleware(app, ctx);
    const jsonRpcController = buildRpcController(ctx);
    mountSnapshotRoutes(app, ctx);
    mountTelemetryRoutes(app, ctx);
    mountRegistryRoutes(app, ctx);
    app.use(makeRpcBatchGuard(resolveMaxBatch(hubConfig.HUB_MAX_RPC_BATCH, 20)));
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.use(jsonRouter({ methods: jsonRpcController }));
    return { app, observability };
}

function startServer(app, ctx, observability) {
    const { hub, http, WebSocket, logger, HUB_PORT, HUB_HOST } = ctx;
    const server = http.createServer(app);

    // Hub DB sync channel: WebSocket server for live row updates
    // Subscribers receive { type: 'row:inserted', table, row } events whenever the hub
    // inserts a new price_snapshots or oracle_prices row.
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', upgradeHandler(wss, ctx));

    const telemetryCleanupInterval = startTelemetryRetention(ctx);
    const pingInterval = startKeepalivePing(ctx);
    serveFeedOnP2pPort(app, server, ctx);

    server.listen(HUB_PORT, HUB_HOST, () => {
        logger.info('Hub API listening on ' + HUB_HOST + ':' + HUB_PORT);
        logger.info('Hub DB sync WebSocket available at ws://' + HUB_HOST + ':' + HUB_PORT + '/hub-db/subscribe');
    });

    installShutdown({ hub, logger, server, wss, pingInterval, telemetryCleanupInterval, observability });
}

function upgradeHandler(wss, { hub, logger, HUB_API_KEY }) {
    return (request, socket, head) => {
        // Authenticate using the same hub API key used for write methods
        // (enforced only when a key is configured; an unconditional fail-closed
        // here 401s every indexer's hub_db_sync subscription on managed deploys,
        // severing the price-sync barrier and the state_checkpoints mirror).
        if (HUB_API_KEY) {
            let authHeader = request.headers['authorization'];
            let _bearer = 'Bearer ' + HUB_API_KEY;
            let _ah = Buffer.from(authHeader || ''), _bh = Buffer.from(_bearer);
            if (!authHeader || _ah.length !== _bh.length || !crypto.timingSafeEqual(_ah, _bh)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
        }
        if (!request.url || !request.url.startsWith('/hub-db/subscribe')) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            if (hub.hubDbBroadcaster) {
                hub.hubDbBroadcaster.addSubscriber(ws, request).catch(e =>
                    logger.error(nodeUtil.format('HubDbBroadcaster: addSubscriber failed:', e && e.message ? e.message : e)));
            } else {
                try { ws.close(1011, 'Hub DB broadcaster not ready'); } catch (e) { /* ignore */ }
            }
        });
    };
}

// Returns the daily retention interval, or null when telemetry is off.
function startTelemetryRetention({ hub, logger, TELEMETRY_ENABLED, TELEMETRY_RETENTION_DAYS }) {
    let telemetryCleanupInterval = null;
    if (TELEMETRY_ENABLED) {
        const pruneTelemetry = async () => {
            try {
                let result = await hub.db.deleteTelemetryPing(TELEMETRY_RETENTION_DAYS);
                let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
                if (deleted > 0) logger.info('Telemetry retention: pruned ' + deleted + ' rows older than ' + TELEMETRY_RETENTION_DAYS + ' days');
            } catch (e) { /* best-effort; never crash the hub over retention */ }
        };
        // unref so these best-effort retention timers never keep the event loop
        // alive on their own (the listening socket does that in production); this
        // also lets test processes that proxyquire src/api.js exit cleanly.
        setTimeout(pruneTelemetry, 60 * 1000).unref();
        telemetryCleanupInterval = setInterval(pruneTelemetry, 24 * 60 * 60 * 1000);
        telemetryCleanupInterval.unref();
    }
    return telemetryCleanupInterval;
}

function startKeepalivePing({ hub, WebSocket, HUB_DB_KEEPALIVE_INTERVAL }) {
    const pingInterval = setInterval(() => {
        // Also guard subscribers: unit tests wire mock hubs whose broadcaster
        // lacks the set, and an uncaught throw here fails whichever unrelated
        // test file happens to be running when the timer fires.
        if (!hub.hubDbBroadcaster || !hub.hubDbBroadcaster.subscribers) return;
        for (let ws of hub.hubDbBroadcaster.subscribers) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.ping(); } catch (e) { /* ignore */ }
            }
        }
    }, HUB_DB_KEEPALIVE_INTERVAL);
    // Keep-alive ping must not by itself hold the loop open (the listening socket
    // does that in production); prevents proxyquired test instances from hanging.
    pingInterval.unref();
    return pingInterval;
}

// Also serve the read-only mirror feed on the PUBLIC P2P port. A validator
// exposes one public port per network and its JSON-RPC API port is private to
// the box, so this is the only way an indexer can mirror from the validators
// themselves rather than from a separate hub standing in for them.
//
// The handlers below ARE the ones src/api.js mounts: PeerManager delegates a GET
// under /hub-db/snapshot to this same express app, and a /hub-db/subscribe
// upgrade back to this server's own upgrade listener (auth, then
// HubDbBroadcaster). Nothing else on that port reaches either. Fail closed
// without a key: the snapshot middleware skips its check when HUB_API_KEY is
// unset, which is tolerable on a loopback-bound API port and is not on a public
// one, so an unkeyed hub simply keeps the port gossip-only.
function serveFeedOnP2pPort(app, server, { hub, hubConfig, logger, HUB_API_KEY }) {
    if (hub.peerManager && typeof hub.peerManager.setFeedHandlers === 'function') {
        if (!HUB_API_KEY) {
            logger.warn('Hub DB feed NOT served on the P2P port: HUB_API_KEY is unset ' +
                '(fail closed; the port stays gossip-only)');
        } else if (String(hubConfig.HUB_P2P_FEED_ENABLED || 'true').toLowerCase() === 'false') {
            logger.info('Hub DB feed on the P2P port disabled by HUB_P2P_FEED_ENABLED=false');
        } else {
            hub.peerManager.setFeedHandlers(
                app,
                (request, socket, head) => server.emit('upgrade', request, socket, head));
            logger.info('Hub DB feed also served on the P2P port ' +
                (hub.p2pConfig && hub.p2pConfig.P2P_PORT ? hub.p2pConfig.P2P_PORT : '') +
                ' (read-only, X-Api-Key required)');
        }
    }
}

// Graceful shutdown: release every timer, socket, and the DB pool, then exit.
// server.close() alone leaves the MariaDB pool (and hub timers) keeping the event
// loop alive, so the process would never actually exit.
function installShutdown({ hub, logger, server, wss, pingInterval, telemetryCleanupInterval, observability }) {
    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown) return;          // ignore a second signal
        shuttingDown = true;
        logger.info('Received ' + signal + '; shutting down hub...');

        // Stop the periodic work owned by this file.
        clearInterval(pingInterval);
        if (telemetryCleanupInterval) clearInterval(telemetryCleanupInterval);

        // Backstop: if any close hangs, exit anyway rather than linger forever.
        const forceTimer = setTimeout(() => {
            logger.error('Shutdown timed out after 10s; forcing exit');
            process.exit(1);
        }, 10000);
        forceTimer.unref();

        try {
            await releaseResources({ hub, server, wss, observability });
        } catch (e) {
            logger.error(nodeUtil.format('Error during shutdown:', e));
        } finally {
            clearTimeout(forceTimer);
            process.exit(0);
        }
    }

    // A SHUTDOWN record is what lets a reader tell an operator-driven restart
    // from a crash: without it both look like a service that stopped emitting.
    process.on('SIGTERM', () => { noteShutdown('SIGTERM'); shutdown('SIGTERM'); });
    process.on('SIGINT',  () => { noteShutdown('SIGINT');  shutdown('SIGINT'); });
}

// Closes the subscriber sockets, the WebSocket server, the HTTP server, the hub and
// the log shipper, in that order. A throw from any step reaches shutdown's catch.
async function releaseResources({ hub, server, wss, observability }) {
    // Guarded on its own: a throw here (e.g. a hub built without a live
    // broadcaster) must not skip the HTTP-server close and hub.close() below,
    // or shutdown silently drops the DB-pool drain for every later step.
    try {
        for (let ws of (hub.hubDbBroadcaster && hub.hubDbBroadcaster.subscribers) || []) {
            try { ws.close(1001, 'shutting down'); } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore: subscriber set unavailable */ }
    try { wss.close(); } catch (e) { /* ignore */ }

    // Stop accepting HTTP connections; force-close lingering keep-alives so
    // server.close() resolves promptly (Node >= 18.2).
    await new Promise((resolve) => {
        // server is an http.Server in production, but unit tests proxyquire
        // src/api.js with a mock `http` whose createServer returns a stub
        // that has no close(). Guard so a signal-triggered shutdown drains
        // the DB pool via hub.close() below instead of throwing here.
        if (typeof server.close === 'function') {
            server.close(resolve);
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        } else {
            resolve();
        }
    });

    // Release hub-owned resources: P2P, consensus/oracle timers, capability +
    // stake-poll timers, config watcher, and the MariaDB pool.
    await hub.close();
    // Flush any buffered log lines before the process goes away (no-op
    // unless log shipping is enabled).
    await observability.shutdown();
}

module.exports = { createApp, startServer };
