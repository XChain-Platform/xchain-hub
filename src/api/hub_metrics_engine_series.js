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
 * XChain Hub - table-driven scrape series over one engine's in-memory fields.
 *
 * The attestation, checkpoint and oracle-publisher collectors share one shape:
 * resolve the engine at scrape time, read plain fields, and publish them
 * without touching the DB, a file or the network, because Registry.render()
 * is synchronous.
 *
 **********************************************************************/

'use strict';

// A real, finite reading; null, undefined and '' are missing, not zero.
function isNum(v){
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

/**
 * Register a table of series and the collector that fills them from one engine.
 *
 * Counters mirror process-lifetime engine counts through setMonotonic, so a
 * recreated engine never walks a counter backwards. Gauges are reset on every
 * pass, so a reading that goes missing disappears instead of going stale.
 * While the engine is absent nothing new is written, so a hub that never runs
 * it shows no series rather than a false zero.
 *
 * @param {object} registry  installed metrics registry.
 * @param {function(): ?object} resolveEngine  called at scrape time.
 * @param {{counters: Array<object>, gauges: Array<object>}} table  each entry is
 *        {name, help, read, labels?}; read(engine) returns a number, a boolean
 *        (gauges only, rendered 1/0) or a missing value.
 * @returns {function} the registered collector.
 */
function installEngineSeries(registry, resolveEngine, table){
    const counters = table.counters.map((spec) => bindSpec(registry, 'counter', spec));
    const gauges = table.gauges.map((spec) => bindSpec(registry, 'gauge', spec));
    const gaugeMetrics = new Set(gauges.map((g) => g.metric));
    return registry.addCollector(() => {
        for(const metric of gaugeMetrics) metric.reset();
        const engine = resolveEngine();
        if(!engine) return;
        for(const c of counters){
            const v = c.read(engine);
            if(isNum(v)) c.metric.setMonotonic(c.labels, Number(v));
        }
        for(const g of gauges){
            const v = g.read(engine);
            if(typeof v === 'boolean') g.metric.set(g.labels, v ? 1 : 0);
            else if(isNum(v)) g.metric.set(g.labels, Number(v));
        }
    });
}

// Register one table entry; entries sharing a name share the registered metric.
function bindSpec(registry, type, spec){
    const labels = spec.labels || {};
    const metric = registry[type]({ name: spec.name, help: spec.help, labelNames: Object.keys(labels) });
    return { metric, labels, read: spec.read };
}

// The engine's method result when it has that method, else a missing reading.
function callIf(engine, method){
    return typeof engine[method] === 'function' ? engine[method]() : null;
}

module.exports = { installEngineSeries, isNum, callIf };
