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
 * XChain Hub - anonymous usage telemetry routes.
 *
 * POST /telemetry ingests install pings, GET /telemetry/summary serves the
 * aggregate census and GET /telemetry/operators the key-gated per-install view.
 * The connecting IP is never stored.
 *
 ********************************************************************/

const crypto = require('crypto');
const nodeUtil = require('node:util');

// POST /telemetry: anonymous usage ping receiver for xchain-node operators.
// The connecting IP is NEVER stored. At ingest we derive a coarse country/region and a
// keyed one-way hash from it, then discard the IP. The body is never trusted for IP.
// Fire-and-forget: always returns quickly; a bad body or DB hiccup never errors the client.
const TELEMETRY_EVENTS = new Set(['install', 'update', 'start', 'heartbeat']);
const clampStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

function mountTelemetryRoutes(app, ctx) {
    const { logger, TELEMETRY_ENABLED, TELEMETRY_IP_SALT } = ctx;
    if (TELEMETRY_ENABLED && !TELEMETRY_IP_SALT)
        logger.info('Telemetry: TELEMETRY_IP_SALT not set; ip_hash will be null (country/region still recorded)');

    const anonymizeIp = ipAnonymizer(ctx);
    mountTelemetryIngest(app, ctx, anonymizeIp);
    mountTelemetrySummary(app, ctx);
    mountTelemetryOperators(app, ctx);
}

function ipAnonymizer({ geoip, TELEMETRY_IP_SALT }) {
    // Normalize, then derive only non-identifying values from the connecting IP. The raw IP
    // is used here and never returned or stored.
    return function anonymizeIp(rawIp) {
        let ip = String(rawIp || '').replace(/^::ffff:/, '');   // unwrap IPv4-mapped IPv6
        let geo = null;
        try { geo = geoip.lookup(ip); } catch (e) { geo = null; }
        let country = geo && geo.country ? String(geo.country).slice(0, 2) : null;
        let region  = geo && geo.region  ? String(geo.region).slice(0, 16) : null;
        let ipHash  = TELEMETRY_IP_SALT
            ? crypto.createHmac('sha256', TELEMETRY_IP_SALT).update(ip).digest('hex')
            : null;
        return { country, region, ipHash };
    };
}

function mountTelemetryIngest(app, { hub, TELEMETRY_ENABLED }, anonymizeIp) {
    app.post('/telemetry', async (req, res) => {
        if (!TELEMETRY_ENABLED) return res.json({ status: 'disabled' });
        try {
            let b = req.body || {};

            // install_id is the only required field; without it we can't dedupe installs.
            let installId = clampStr(b.install_id, 36);
            if (!installId) return res.status(400).json({ error: 'install_id is required' });

            // Derive country/region/hash from the connection, then the IP is gone.
            let { country, region, ipHash } = anonymizeIp(req.ip || req.socket.remoteAddress);
            let event = TELEMETRY_EVENTS.has(b.event) ? b.event : 'heartbeat';

            // Cap the module list defensively (a real install has well under 100 entries).
            let modules = Array.isArray(b.modules) ? b.modules.slice(0, 100).map(m => ({
                module:  clampStr(m && m.module, 64),
                coin:    clampStr(m && m.coin, 16),
                network: clampStr(m && m.network, 24),
                version: clampStr(m && m.version, 32),
                running: !!(m && m.running)
            })) : [];

            await hub.db.createTelemetryPing(
                installId,
                country,
                region,
                ipHash,
                clampStr(b.node_version, 32),
                clampStr(b.os_platform, 32),
                clampStr(b.os_release, 64),
                clampStr(b.arch, 16),
                clampStr(b.docker_version, 32),
                JSON.stringify(modules),
                event
            );
            res.json({ status: 'success' });
        } catch (err) {
            // Never surface telemetry failures to the client.
            res.json({ status: 'success' });
        }
    });
}

// GET /telemetry/summary: anonymous, aggregate-only census of node operators.
// Returns DISTRIBUTION COUNTS ONLY (by version / OS / country / arch / running
// module). Never returns install_id, ip_hash, region, or any per-install row;
// only group tallies derived from the latest ping per install in the window.
// Read-only; safe to expose to the operator dashboard.
function mountTelemetrySummary(app, { hub, logger, TELEMETRY_ENABLED }) {
    app.get('/telemetry/summary', async (req, res) => {
        if (!TELEMETRY_ENABLED) return res.json({ enabled: false });
        try {
            // Bounded integer window (sanitised -> safe to inline; not a bound param
            // because MariaDB won't bind inside an INTERVAL literal cleanly).
            let days = req.query.days ? parseInt(req.query.days, 10) : 30;
            if (!Number.isFinite(days) || days < 1) days = 30;
            if (days > 365) days = 365;

            // Latest ping per install within the window. install_id is used only to
            // dedupe + group here; it is dropped before the response.
            let rows = await hub.db.findLatestTelemetryPingPerInstall(days);

            const counts = countRunningModules(rows);

            // Total pings over the window (activity volume, not unique installs).
            let pingRow = await hub.db.getTelemetryPingCountInWindow(days);

            res.json(summaryBody(days, rows, pingRow, counts));
        } catch (err) {
            logger.error(nodeUtil.format('hub telemetry summary error:', err));
            res.status(500).json({ error: 'telemetry summary error' });
        }
    });
}

const tally = (arr, key) => {
    const m = new Map();
    for (const v of arr) {
        const k = (v === null || v === undefined || v === '') ? 'unknown' : String(v);
        m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
};

// Running-module distribution: count installs running each module.
// Chain distribution: count installs running at least one module on each
// coin/network (e.g. "bitcoin/mainnet"). Shared services (hub/db) carry an
// empty coin/network and are skipped; they aren't chain-specific.
// Component-per-chain distribution: count installs running each
// (module, coin, network) combo, e.g. how many run xchain-indexer on
// litecoin/testnet. Keyed "coin/network/module" (none contain a slash).
function countRunningModules(rows) {
    const moduleCounts = new Map();
    const chainCounts  = new Map();
    const chainModuleCounts = new Map();
    for (const r of rows) {
        let mods = [];
        try { mods = Array.isArray(r.modules) ? r.modules : JSON.parse(r.modules || '[]'); } catch (e) { mods = []; }
        const seenModule = new Set();
        const seenChain  = new Set();
        const seenChainModule = new Set();
        for (const m of mods) {
            if (!m || !m.running) continue;
            if (m.module && !seenModule.has(m.module)) {   // count an install once per module
                seenModule.add(m.module);
                moduleCounts.set(m.module, (moduleCounts.get(m.module) || 0) + 1);
            }
            if (m.coin && m.network) {
                const chainKey = m.coin + '/' + m.network;
                if (!seenChain.has(chainKey)) {            // count an install once per coin/network
                    seenChain.add(chainKey);
                    chainCounts.set(chainKey, (chainCounts.get(chainKey) || 0) + 1);
                }
                if (m.module) {
                    const cmKey = chainKey + '/' + m.module;
                    if (!seenChainModule.has(cmKey)) {     // count an install once per (chain, module)
                        seenChainModule.add(cmKey);
                        chainModuleCounts.set(cmKey, (chainModuleCounts.get(cmKey) || 0) + 1);
                    }
                }
            }
        }
    }
    return { moduleCounts, chainCounts, chainModuleCounts };
}

function summaryBody(days, rows, pingRow, { moduleCounts, chainCounts, chainModuleCounts }) {
    return {
        enabled: true,
        window_days: days,
        operators: rows.length,
        pings: pingRow && pingRow[0] ? Number(pingRow[0].c) : null,
        byVersion: tally(rows.map(r => r.node_version), 'node_version'),
        byOs:      tally(rows.map(r => r.os_platform), 'os_platform'),
        byCountry: tally(rows.map(r => r.country), 'country'),
        byArch:    tally(rows.map(r => r.arch), 'arch'),
        byDocker:  tally(rows.map(r => r.docker_version), 'docker_version'),
        modules:   [...moduleCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
        chains:    [...chainCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
        chainModules: [...chainModuleCounts.entries()].map(([key, count]) => {
            const i = key.indexOf('/'), j = key.indexOf('/', i + 1);
            return { coin: key.slice(0, i), network: key.slice(i + 1, j), module: key.slice(j + 1), count };
        }).sort((a, b) => a.coin.localeCompare(b.coin) || a.network.localeCompare(b.network) || a.module.localeCompare(b.module)),
    };
}

// GET /telemetry/operators: per-install (per-server) detail. UNLIKE the aggregate
// summary this returns identifying-ish data (ip_hash, region, exactly what each
// server runs), so it is fail-closed behind TELEMETRY_ADMIN_KEY (x-api-key header).
// Intended for the operator's own auth-gated dashboard, never public consumption.
function mountTelemetryOperators(app, { hub, logger, TELEMETRY_ENABLED, TELEMETRY_ADMIN_KEY }) {
    app.get('/telemetry/operators', async (req, res) => {
        if (!TELEMETRY_ENABLED) return res.json({ enabled: false });
        if (!TELEMETRY_ADMIN_KEY) { return res.status(401).json({ error: 'Unauthorized' }); }
        { let a = Buffer.from(req.headers['x-api-key'] || ''), b = Buffer.from(TELEMETRY_ADMIN_KEY);
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return res.status(401).json({ error: 'Unauthorized' }); } }
        try {
            let days = req.query.days ? parseInt(req.query.days, 10) : 30;
            if (!Number.isFinite(days) || days < 1) days = 30;
            if (days > 365) days = 365;

            // Latest ping per install in the window: the current state of each server.
            let rows = await hub.db.findLatestTelemetryOperatorPingPerInstall(days);

            // first_seen + ping count per install over the window.
            let statRows = await hub.db.findTelemetryPingStatsPerInstall(days);
            const stats = new Map();
            for (const s of statRows) stats.set(s.install_id, s);

            const operators = rows.map(r => {
                let mods = [];
                try { mods = Array.isArray(r.modules) ? r.modules : JSON.parse(r.modules || '[]'); } catch (e) { mods = []; }
                const chains = [...new Set(mods.filter(m => m && m.running && m.coin && m.network).map(m => m.coin + '/' + m.network))].sort();
                const modules = [...new Set(mods.filter(m => m && m.running && m.module).map(m => m.module))].sort();
                const st = stats.get(r.install_id) || {};
                return {
                    install_id:     r.install_id,
                    first_seen:     st.first_seen || null,
                    last_seen:      r.last_seen,
                    pings:          st.pings != null ? Number(st.pings) : null,
                    country:        r.country,
                    region:         r.region,
                    ip_hash:        r.ip_hash,
                    node_version:   r.node_version,
                    os_platform:    r.os_platform,
                    os_release:     r.os_release,
                    arch:           r.arch,
                    docker_version: r.docker_version,
                    chains,
                    modules
                };
            }).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

            res.json({ enabled: true, window_days: days, operators });
        } catch (err) {
            logger.error(nodeUtil.format('hub telemetry operators error:', err));
            res.status(500).json({ error: 'telemetry operators error' });
        }
    });
}

module.exports = { mountTelemetryRoutes };
