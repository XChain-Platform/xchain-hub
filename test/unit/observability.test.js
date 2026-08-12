'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// the shared /metrics exporter and structured log shim. The suite
// pins the three properties services depend on: valid Prometheus exposition
// text, default-off wiring (no route, no timer, no socket without env), and a
// log shim that redacts credentials and never throws at a dead collector.

const { expect } = require('chai');
const express = require('express');
const http = require('http');

const {
    Registry, Counter, Gauge, Histogram, collectDefaultMetrics
} = require('../../src/observability/metrics.js');
const {
    createLogShipper, readLogEnv, redactFields, scrubMessage, REDACTED
} = require('../../src/observability/logShipper.js');
const {
    installObservability, readObservabilityEnv, routeLabel
} = require('../../src/observability/index.js');

// A console-shaped sink so tests never write to the mocha output.
function fakeConsole() {
    const lines = { log: [], warn: [], error: [] };
    return {
        lines,
        log:   (m) => lines.log.push(m),
        warn:  (m) => lines.warn.push(m),
        error: (m) => lines.error.push(m)
    };
}

async function listen(app) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        port,
        url: (p) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

describe('observability/metrics: exposition format', function () {

    it('renders a counter with HELP, TYPE and labelled samples', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'test_requests_total', help: 'Requests', labelNames: ['route'] });
        c.inc({ route: '/a' }, 2);
        c.inc({ route: '/a' });
        c.inc({ route: '/b' });

        const out = reg.render();
        expect(out).to.include('# HELP test_requests_total Requests');
        expect(out).to.include('# TYPE test_requests_total counter');
        expect(out).to.include('test_requests_total{route="/a"} 3');
        expect(out).to.include('test_requests_total{route="/b"} 1');
        expect(out.endsWith('\n')).to.equal(true);
    });

    it('rejects invalid metric and label names at declaration', function () {
        const reg = new Registry();
        expect(() => reg.counter({ name: '9bad', help: 'x' })).to.throw(/invalid metric name/);
        expect(() => reg.counter({ name: 'ok_total', help: 'x', labelNames: ['bad-label'] })).to.throw(/invalid label name/);
        expect(() => reg.counter({ name: 'ok2_total', help: 'x', labelNames: ['__name__'] })).to.throw(/reserved/);
    });

    it('refuses a duplicate metric registration', function () {
        const reg = new Registry();
        reg.gauge({ name: 'dup_gauge', help: 'x' });
        expect(() => reg.gauge({ name: 'dup_gauge', help: 'y' })).to.throw(/already registered/);
    });

    it('rejects a negative counter increment and an unknown label', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'neg_total', help: 'x', labelNames: ['a'] });
        expect(() => c.inc({ a: '1' }, -1)).to.throw(/non-negative/);
        expect(() => c.inc({ b: '1' }, 1)).to.throw(/unknown label/);
    });

    it('escapes backslash, quote and newline in label values and help', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'esc_total', help: 'line1\nline2 \\ end', labelNames: ['v'] });
        c.inc({ v: 'a"b\\c\nd' });
        const out = reg.render();
        expect(out).to.include('# HELP esc_total line1\\nline2 \\\\ end');
        expect(out).to.include('esc_total{v="a\\"b\\\\c\\nd"} 1');
        // No raw newline may appear inside a sample line.
        for (const line of out.trim().split('\n')) expect(line).to.not.equal('');
    });

    it('treats label order as declared order, not caller order', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'order_total', help: 'x', labelNames: ['a', 'b'] });
        c.inc({ a: '1', b: '2' });
        c.inc({ b: '2', a: '1' });
        expect(c.get({ a: '1', b: '2' })).to.equal(2);
        expect(reg.render().split('\n').filter((l) => l.startsWith('order_total{')).length).to.equal(1);
    });

    it('emits cumulative histogram buckets with +Inf equal to _count', function () {
        const reg = new Registry();
        const h = reg.histogram({ name: 'lat_seconds', help: 'x', labelNames: ['route'], buckets: [0.1, 0.5, 1] });
        h.observe({ route: '/a' }, 0.05);
        h.observe({ route: '/a' }, 0.3);
        h.observe({ route: '/a' }, 2);

        const out = reg.render();
        expect(out).to.include('# TYPE lat_seconds histogram');
        expect(out).to.include('lat_seconds_bucket{route="/a",le="0.1"} 1');
        expect(out).to.include('lat_seconds_bucket{route="/a",le="0.5"} 2');
        expect(out).to.include('lat_seconds_bucket{route="/a",le="1"} 2');
        expect(out).to.include('lat_seconds_bucket{route="/a",le="+Inf"} 3');
        expect(out).to.include('lat_seconds_count{route="/a"} 3');
        expect(out).to.include('lat_seconds_sum{route="/a"} 2.35');
    });

    it('ignores a non-finite histogram observation instead of poisoning the sum', function () {
        const reg = new Registry();
        const h = reg.histogram({ name: 'nan_seconds', help: 'x', buckets: [1] });
        h.observe({}, Number.NaN);
        h.observe({}, Infinity);
        h.observe({}, 0.5);
        expect(h.get({}).count).to.equal(1);
        expect(h.get({}).sum).to.equal(0.5);
    });

    it('reserves le for histogram buckets', function () {
        const reg = new Registry();
        expect(() => reg.histogram({ name: 'le_seconds', help: 'x', labelNames: ['le'] })).to.throw(/reserved/);
    });

    it('caps series per metric and counts the drops instead of growing', function () {
        const reg = new Registry({ maxSeries: 3 });
        const c = reg.counter({ name: 'card_total', help: 'x', labelNames: ['id'] });
        for (let i = 0; i < 10; i++) c.inc({ id: `id-${i}` });
        expect(c.series.size).to.equal(3);
        expect(reg.get('xchain_metrics_series_dropped_total').get({ metric: 'card_total' })).to.equal(7);
        expect(reg.render()).to.include('xchain_metrics_series_dropped_total{metric="card_total"} 7');
    });

    it('gauge set/inc/dec track a value and reject a non-finite set', function () {
        const reg = new Registry();
        const g = reg.gauge({ name: 'depth', help: 'x' });
        g.set({}, 5);
        g.inc({}, 2);
        g.dec({}, 3);
        expect(g.get({})).to.equal(4);
        expect(() => g.set({}, Number.NaN)).to.throw(/finite/);
    });

    it('setMonotonic never lets a collector-driven counter go backwards', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'cpu_total', help: 'x' });
        c.setMonotonic({}, 10);
        c.setMonotonic({}, 4);
        expect(c.get({})).to.equal(10);
    });

    it('survives a throwing collector and still renders the rest', function () {
        const reg = new Registry();
        reg.counter({ name: 'ok_total', help: 'x' }).inc({});
        reg.addCollector(() => { throw new Error('boom'); });
        expect(reg.render()).to.include('ok_total 1');
    });

    it('collectDefaultMetrics exposes process and service identity', function () {
        const reg = new Registry();
        collectDefaultMetrics(reg, { service: 'xchain-hub', version: '1.2.3', coin: 'BTC', network: 'regtest' });
        const out = reg.render();
        expect(out).to.include('xchain_service_info{service="xchain-hub",version="1.2.3",coin="BTC",network="regtest"');
        expect(out).to.match(/process_resident_memory_bytes \d+/);
        expect(out).to.match(/process_cpu_user_seconds_total [\d.]+/);
        expect(out).to.include('# TYPE process_cpu_user_seconds_total counter');
        expect(out).to.match(/nodejs_heap_size_used_bytes \d+/);
    });

    it('exports the Prometheus content type', function () {
        expect(new Registry().contentType()).to.equal('text/plain; version=0.0.4; charset=utf-8');
    });

    it('metric classes are usable standalone', function () {
        expect(new Counter({ name: 'a_total', help: 'x' }).inc({}, 2)).to.equal(2);
        const g = new Gauge({ name: 'b', help: 'x' }); g.set({}, 1); expect(g.get({})).to.equal(1);
        const h = new Histogram({ name: 'c', help: 'x' }); h.observe({}, 1); expect(h.get({}).count).to.equal(1);
    });
});

describe('observability/logShipper', function () {

    it('is inert by default: text output, no buffering, no shipping', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: {}, console: sink });
        log.info('hello world');
        expect(log.config.shipEnabled).to.equal(false);
        expect(log.buffer.length).to.equal(0);
        expect(log.timer).to.equal(null);
        expect(sink.lines.log).to.deep.equal(['hello world']);
    });

    it('emits NDJSON with the envelope keys when LOG_FORMAT=json', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'xchain-hub', version: '9.9.9', env: { LOG_FORMAT: 'json' }, console: sink });
        log.warn('block stalled', { height: 42 });
        const rec = JSON.parse(sink.lines.warn[0]);
        expect(rec.level).to.equal('warn');
        expect(rec.service).to.equal('xchain-hub');
        expect(rec.msg).to.equal('block stalled');
        expect(rec.height).to.equal(42);
        expect(rec.version).to.equal('9.9.9');
        expect(new Date(rec.ts).toISOString()).to.equal(rec.ts);
    });

    it('honours LOG_LEVEL and drops quieter levels', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: { LOG_LEVEL: 'warn' }, console: sink });
        expect(log.info('quiet')).to.equal(null);
        expect(log.error('loud')).to.not.equal(null);
        expect(sink.lines.log.length).to.equal(0);
    });

    it('redacts credential-shaped field keys and inline key=value pairs', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: { LOG_FORMAT: 'json' }, console: sink });
        const rec = log.info('connect password=hunter2 then api_key: abc123', {
            db: { user: 'app', password: 'hunter2' },
            HUB_API_KEY: 'zzz',
            height: 7
        });
        expect(rec.db.password).to.equal(REDACTED);
        expect(rec.db.user).to.equal('app');
        expect(rec.HUB_API_KEY).to.equal(REDACTED);
        expect(rec.height).to.equal(7);
        expect(rec.msg).to.not.include('hunter2');
        expect(rec.msg).to.not.include('abc123');
        expect(JSON.stringify(rec)).to.not.include('hunter2');
    });

    it('never lets a caller field forge the record envelope', function () {
        const log = createLogShipper({ service: 'real-svc', env: {}, console: fakeConsole() });
        const rec = log.info('m', { service: 'spoofed', level: 'debug', msg: 'spoofed' });
        expect(rec.service).to.equal('real-svc');
        expect(rec.level).to.equal('info');
        expect(rec.msg).to.equal('m');
    });

    it('handles cyclic and deep field graphs without throwing', function () {
        const a = { name: 'a' };
        a.self = a;
        expect(redactFields(a).self).to.equal('[circular]');
        expect(redactFields({ a: { b: { c: { d: { e: 1 } } } } }).a.b.c.d).to.equal('[truncated]');
        expect(scrubMessage('token=abc')).to.equal(`token=${REDACTED}`);
    });

    it('serializes an Error field with a scrubbed message', function () {
        const out = redactFields({ err: new Error('login failed for password=hunter2') });
        expect(out.err.message).to.include(REDACTED);
        expect(out.err.message).to.not.include('hunter2');
    });

    it('requires BOTH the flag and a valid URL before shipping', function () {
        expect(readLogEnv({ LOG_SHIP_ENABLED: '1' }).shipEnabled).to.equal(false);
        expect(readLogEnv({ LOG_SHIP_URL: 'https://c/logs' }).shipEnabled).to.equal(false);
        expect(readLogEnv({ LOG_SHIP_ENABLED: '1', LOG_SHIP_URL: 'ftp://c/logs' }).shipEnabled).to.equal(false);
        expect(readLogEnv({ LOG_SHIP_ENABLED: 'true', LOG_SHIP_URL: 'https://c/logs' }).shipEnabled).to.equal(true);
    });

    it('batches NDJSON to the transport once the batch size is reached', async function () {
        const bodies = [];
        const log = createLogShipper({
            service: 'svc',
            env: { LOG_SHIP_ENABLED: '1', LOG_SHIP_URL: 'https://collector.invalid/logs', LOG_SHIP_BATCH_SIZE: '2' },
            console: fakeConsole(),
            transport: (body) => { bodies.push(body); return Promise.resolve(); }
        });
        log.info('one');
        log.info('two');
        await new Promise((r) => setImmediate(r));
        await log.stop();

        expect(bodies.length).to.equal(1);
        const lines = bodies[0].trim().split('\n').map((l) => JSON.parse(l));
        expect(lines.map((l) => l.msg)).to.deep.equal(['one', 'two']);
        expect(log.stats.shipped).to.equal(2);
    });

    it('drops the oldest lines when the buffer is full and counts the loss', function () {
        const log = createLogShipper({
            service: 'svc',
            env: {
                LOG_SHIP_ENABLED: '1', LOG_SHIP_URL: 'https://collector.invalid/logs',
                LOG_SHIP_BATCH_SIZE: '1000', LOG_SHIP_MAX_BUFFER: '3'
            },
            console: fakeConsole(),
            transport: () => new Promise(() => {})   // never settles: buffer fills
        });
        for (let i = 0; i < 6; i++) log.info(`line-${i}`);
        expect(log.buffer.length).to.equal(3);
        expect(log.stats.dropped).to.equal(3);
        expect(log.buffer.map((r) => r.msg)).to.deep.equal(['line-3', 'line-4', 'line-5']);
    });

    it('survives a failing collector, re-queues the batch and rate-limits the stderr note', async function () {
        const sink = fakeConsole();
        const log = createLogShipper({
            service: 'svc',
            env: { LOG_SHIP_ENABLED: '1', LOG_SHIP_URL: 'https://collector.invalid/logs', LOG_SHIP_BATCH_SIZE: '1' },
            console: sink,
            transport: () => Promise.reject(new Error('ECONNREFUSED'))
        });
        log.info('a');
        await log.flush();
        log.info('b');
        await log.flush();

        expect(log.stats.failures).to.be.greaterThan(0);
        expect(log.stats.shipped).to.equal(0);
        expect(log.buffer.length).to.be.greaterThan(0);
        // One note per minute, so the second failure adds no line.
        expect(sink.lines.error.filter((l) => l.includes('[log-ship]')).length).to.equal(1);
        await log.stop();
    });

    it('exposes shipper counters on a registry when one is supplied', function () {
        const reg = new Registry();
        const log = createLogShipper({ service: 'svc', env: {}, console: fakeConsole(), registry: reg });
        log.info('x');
        log.error('y');
        const out = reg.render();
        expect(out).to.include('log_lines_emitted_total{level="info"} 1');
        expect(out).to.include('log_lines_emitted_total{level="error"} 1');
        expect(out).to.include('log_ship_buffer_lines 0');
    });

    it('stop() clears the flush timer so the process can exit', async function () {
        const log = createLogShipper({
            service: 'svc',
            env: { LOG_SHIP_ENABLED: '1', LOG_SHIP_URL: 'https://collector.invalid/logs' },
            console: fakeConsole(),
            transport: () => Promise.resolve()
        });
        expect(log.timer).to.not.equal(null);
        await log.stop();
        expect(log.timer).to.equal(null);
    });
});

describe('observability/installObservability', function () {

    it('reads a default-off config from an empty env', function () {
        const cfg = readObservabilityEnv({});
        expect(cfg.metricsEnabled).to.equal(false);
        expect(cfg.httpMetrics).to.equal(false);
        expect(cfg.metricsPath).to.equal('/metrics');
        expect(cfg.log.shipEnabled).to.equal(false);
    });

    it('normalizes a METRICS_PATH given without a leading slash', function () {
        expect(readObservabilityEnv({ METRICS_ENABLED: '1', METRICS_PATH: 'internal/metrics' }).metricsPath)
            .to.equal('/internal/metrics');
    });

    it('registers NO route and no registry when the flag is unset', async function () {
        const app = express();
        app.get('/health', (req, res) => res.json({ ok: true }));
        const obs = installObservability(app, { service: 'xchain-hub', env: {}, console: fakeConsole() });
        expect(obs.enabled).to.equal(false);
        expect(obs.registry).to.equal(null);

        const srv = await listen(app);
        try {
            const res = await fetch(srv.url('/metrics'));
            expect(res.status).to.equal(404);
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('serves the exposition text and instruments requests when enabled', async function () {
        const app = express();
        app.get('/health', (req, res) => res.json({ ok: true }));
        const obs = installObservability(app, {
            service: 'xchain-hub', version: '1.0.0', coin: 'BTC', network: 'regtest',
            env: { METRICS_ENABLED: '1' }, console: fakeConsole()
        });
        expect(obs.enabled).to.equal(true);

        const srv = await listen(app);
        try {
            await fetch(srv.url('/health'));
            await fetch(srv.url('/health'));
            await fetch(srv.url('/nope'));

            const res = await fetch(srv.url('/metrics'));
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.include('version=0.0.4');
            expect(res.headers.get('cache-control')).to.equal('no-store');

            const body = await res.text();
            expect(body).to.include('http_requests_total{method="GET",route="/health",status="200"} 2');
            expect(body).to.include('http_request_duration_seconds_count{method="GET",route="/health"} 2');
            expect(body).to.include('http_requests_in_flight 0');
            expect(body).to.include('xchain_service_info{service="xchain-hub",version="1.0.0",coin="BTC",network="regtest"');
            // The scrape itself is never counted.
            expect(body).to.not.include('route="/metrics"');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('buckets an unmatched path by first segment so URLs cannot explode cardinality', async function () {
        const app = express();
        const obs = installObservability(app, { service: 'svc', env: { METRICS_ENABLED: '1' }, console: fakeConsole() });
        const srv = await listen(app);
        try {
            await fetch(srv.url('/block/000000001'));
            await fetch(srv.url('/block/000000002'));
            const body = await (await fetch(srv.url('/metrics'))).text();
            expect(body).to.include('http_requests_total{method="GET",route="/block",status="404"} 2');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('uses the express route pattern, not the concrete path, as the route label', function () {
        expect(routeLabel({ route: { path: '/snapshot/:table' }, baseUrl: '/hub-db' })).to.equal('/hub-db/snapshot/:table');
        expect(routeLabel({ originalUrl: '/telemetry/summary?x=1' })).to.equal('/telemetry');
        expect(routeLabel({ url: '/' })).to.equal('/');
    });

    it('gates the endpoint behind METRICS_TOKEN when one is configured', async function () {
        const app = express();
        const obs = installObservability(app, {
            service: 'svc', env: { METRICS_ENABLED: '1', METRICS_TOKEN: 'sekret-scrape' }, console: fakeConsole()
        });
        const srv = await listen(app);
        try {
            expect((await fetch(srv.url('/metrics'))).status).to.equal(401);
            expect((await fetch(srv.url('/metrics'), { headers: { Authorization: 'Bearer wrong' } })).status).to.equal(401);
            const ok = await fetch(srv.url('/metrics'), { headers: { Authorization: 'Bearer sekret-scrape' } });
            expect(ok.status).to.equal(200);
            expect(await ok.text()).to.include('# TYPE');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('honours a custom METRICS_PATH and can skip HTTP instrumentation', async function () {
        const app = express();
        app.get('/health', (req, res) => res.json({ ok: true }));
        const obs = installObservability(app, {
            service: 'svc', env: { METRICS_ENABLED: '1', METRICS_PATH: '/internal/metrics', METRICS_HTTP: '0' },
            console: fakeConsole()
        });
        const srv = await listen(app);
        try {
            await fetch(srv.url('/health'));
            expect((await fetch(srv.url('/metrics'))).status).to.equal(404);
            const body = await (await fetch(srv.url('/internal/metrics'))).text();
            expect(body).to.include('xchain_service_info');
            expect(body).to.not.include('http_requests_total{');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('instruments routes registered BEFORE the install call (layer is hoisted)', async function () {
        // The six services wire this at different points in their api.js; Express
        // dispatches in registration order, so without the hoist an install that
        // lands after the routes would export zero HTTP metrics.
        const app = express();
        app.get('/early', (req, res) => res.send('ok'));
        const obs = installObservability(app, { service: 'svc', env: { METRICS_ENABLED: '1' }, console: fakeConsole() });
        const srv = await listen(app);
        try {
            await fetch(srv.url('/early'));
            const body = await (await fetch(srv.url('/metrics'))).text();
            expect(body).to.include('http_requests_total{method="GET",route="/early",status="200"} 1');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('returns a usable logger even with no app to mount on', function () {
        const sink = fakeConsole();
        const obs = installObservability(null, { service: 'worker', env: {}, console: sink });
        expect(obs.enabled).to.equal(false);
        obs.logger.info('tick');
        expect(sink.lines.log).to.deep.equal(['tick']);
    });
});
