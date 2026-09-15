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
 * XChain Hub - the express middleware stack ahead of every route.
 *
 * Order is the auth boundary and is kept exactly: trust proxy, helmet, the JSON
 * body parser, CORS, the per-IP rate limit, the observability surface and hub
 * gauges, then the x-api-key tier gate and the public-port allowlist.
 *
 ********************************************************************/

// The per-IP cap answers in JSON-RPC and stands down for the hub's own
// stack, so chain-only price recovery works at shipped defaults.
const { buildRateLimitOptions } = require('./rate_limit_policy.js');
const { installObservability } = require('../observability');   // default-off /metrics + structured log shim
const { installHubOracleMetrics, installHubStakeShareMetrics } = require('./hub_metrics');   // item a98d6746: oracle-round heartbeat gauges; stake-share margin gauges
const { authGate, feedPortAllowlist } = require('./auth_gate');

// Returns the observability handle, whose shutdown() the signal handler flushes.
function installMiddleware(app, ctx) {
    installTransportMiddleware(app, ctx);
    const observability = installMetrics(app, ctx);
    app.use(authGate(ctx));
    app.use(feedPortAllowlist());
    return observability;
}

function installTransportMiddleware(app, ctx) {
    const { hubConfig, logger, express, helmet, cors, rateLimit,
            CORS_ORIGIN, HUB_RATE_LIMIT_RPM, HUB_RATE_LIMIT_EXEMPT_LOCAL } = ctx;
    // A deployed hub usually sits behind a reverse proxy on the same host, and
    // may sit behind a CDN beyond it. The entry that proxy appends to
    // X-Forwarded-For is the edge address where a CDN terminates the
    // connection, or the real visitor where the proxy resolves it, and the
    // setting below recovers whichever it is. So honour X-Forwarded-For to
    // recover the real client IP, but only from a trusted proxy.
    // `true` would trust ANY client-supplied XFF, letting
    // callers spoof their IP past the per-IP rate limiter (express-rate-limit's
    // ERR_ERL_PERMISSIVE_TRUST_PROXY warning). The default trusts loopback plus
    // private-range peers: a containerized hub sees the host reverse proxy as
    // the docker bridge IP (uniquelocal), a native hub sees it as loopback;
    // both recover the real client IP. Exposed directly to the internet, a
    // forged XFF is ignored (public socket address) and req.ip is the socket
    // address. HUB_TRUST_PROXY overrides for other topologies: `false`, a hop
    // count (e.g. `1`), or an address/CIDR list per the express docs. For
    // telemetry the IP is only used transiently to derive a coarse
    // country/region + keyed hash and is never stored.
    let trustProxy = hubConfig.HUB_TRUST_PROXY || 'loopback, uniquelocal';
    if (trustProxy === 'true')       trustProxy = true;
    else if (trustProxy === 'false') trustProxy = false;
    else if (/^\d+$/.test(trustProxy)) trustProxy = parseInt(trustProxy);
    app.set('trust proxy', trustProxy);

    app.use(helmet());
    app.use(express.json());
    app.use(cors({ origin: CORS_ORIGIN }));
    // Per-IP cap. The options (JSON-RPC 429 body, loopback/private exemption) live in
    // src/api/rate_limit_policy.js so they are unit-testable; api.js self-starts on
    // require, so nothing declared inline here could ever be asserted against.
    let rateLimitedLogged = 0;
    app.use(rateLimit(buildRateLimitOptions({
        rpm:         HUB_RATE_LIMIT_RPM,
        windowMs:    60 * 1000,
        exemptLocal: HUB_RATE_LIMIT_EXEMPT_LOCAL,
        // One line per minute at most: a throttled client retries hard by definition, and
        // logging every rejection turns a burst into its own outage.
        onLimited: (facts) => {
            let now = Date.now();
            if(now - rateLimitedLogged < facts.windowMs) return;
            rateLimitedLogged = now;
            logger.warn('Hub API rate limit: a caller exceeded ' + facts.limit +
                ' req/' + Math.round(facts.windowMs / 1000) + 's; raise HUB_RATE_LIMIT_RPM if this is legitimate traffic');
        }
    })));
    logger.info('Hub API rate limit: ' + HUB_RATE_LIMIT_RPM + ' req/min per IP' +
        (HUB_RATE_LIMIT_EXEMPT_LOCAL
            ? ' (loopback and private-range callers exempt; HUB_RATE_LIMIT_EXEMPT_LOCAL=false to enforce)'
            : ' (enforced for every caller, including loopback and private-range)'));
}

function installMetrics(app, ctx) {
    const { hub, hubConfig } = ctx;
    // Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
    // Nothing is registered and no timer starts unless METRICS_ENABLED (and, for
    // log shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set, so a hub deploy
    // gains no new listening surface by accident. See src/observability/README.md.
    let hubVersion = '';
    try { hubVersion = require('../../package.json').version; } catch { /* version label is cosmetic */ }
    const observability = installObservability(app, {
        service: 'xchain-hub',
        version: hubVersion,
        network: hubConfig.HUB_NETWORK || ''
    });

    // Oracle-round heartbeat (item a98d6746). Round freshness was reachable only
    // through getoraclesubmissions and /health, which are the same DB/RPC path,
    // so a regression in that monitoring path hid a wedged round loop from every
    // surface at once. No-ops when metrics are off, and resolves the oracle
    // lazily at scrape time (startOracle runs later; a config-only hub has none).
    installHubOracleMetrics(observability, hub);

    // Stake share vs the weighted commit gate. The oracle series above
    // fire once rounds are ALREADY failing; these are the ones that move first,
    // because a federation drifting toward the two-thirds gate finalizes perfectly
    // normal rounds right up to the staker that ends them.
    installHubStakeShareMetrics(observability, hub);
    return observability;
}

module.exports = { installMiddleware };
