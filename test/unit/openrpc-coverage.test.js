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
 * Drift guard: docs/openrpc.json must list exactly the methods exposed by
 * the jsonRpcController in src/api.js, and its x-auth flags must match the
 * WRITE_METHODS set. Regenerate with: node docs/openrpc.build.js
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

describe('openrpc.json method coverage', () => {

    const src  = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/openrpc.json'), 'utf8'));

    const block = src.slice(src.indexOf('jsonRpcController = {'), src.indexOf('jsonRouter('));
    const controllerMethods = [...block.matchAll(/^\s{8}async\s+([a-z][a-z0-9_]*)\s*\(/gm)].map((m) => m[1]);

    const writeBlock = src.slice(src.indexOf('WRITE_METHODS'), src.indexOf(']', src.indexOf('WRITE_METHODS')));
    const writeMethods = [...writeBlock.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);

    // x-auth covers everything keyed when HUB_API_KEY is set: writes plus the
    // sensitive-read tier (getallconfigs et al.), so extract both sets.
    const sensIdx = src.indexOf('SENSITIVE_READ_METHODS = new Set(');
    const sensBlock = src.slice(sensIdx, src.indexOf(')', sensIdx));
    const sensitiveReads = [...sensBlock.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
    const keyedMethods = [...new Set([...writeMethods, ...sensitiveReads])];

    it('extracts sane method lists', () => {
        assert.ok(controllerMethods.includes('ping') && controllerMethods.includes('getallconfigs'),
            `controller extraction broken: ${controllerMethods.join(', ')}`);
        assert.ok(writeMethods.includes('updateconfig'), 'WRITE_METHODS extraction broken');
        assert.ok(sensitiveReads.includes('getallconfigs'), 'SENSITIVE_READ_METHODS extraction broken');
    });

    it('spec methods === controller methods', () => {
        assert.deepStrictEqual(spec.methods.map((m) => m.name).sort(), [...controllerMethods].sort());
    });

    it('spec x-auth flags === WRITE_METHODS + SENSITIVE_READ_METHODS', () => {
        const flagged = spec.methods.filter((m) => m['x-auth']).map((m) => m.name).sort();
        assert.deepStrictEqual(flagged, [...keyedMethods].sort());
    });

    it('every method has a summary and by-name params', () => {
        for (const m of spec.methods) {
            assert.ok(m.summary && m.summary.length, `${m.name} summary`);
            assert.strictEqual(m.paramStructure, 'by-name', `${m.name} paramStructure`);
        }
    });

    // Param fidelity (item #4481). Method-name and x-auth coverage above left the
    // PARAMETER lists unchecked, and 20 of ~48 had drifted: getpricesnapshots
    // declared only `limit` while the handler reads {limit, status, with_watermark},
    // and the dashboard's oracle-feed panel depends on both of the missing two, so
    // a rename or removal of exactly the fields protecting it from fork and
    // staleness masking was invisible to a contract-driven client. Read each
    // handler's real argument names out of src/api.js: a destructured signature
    // names them directly, and the handlers taking the whole params object are
    // recovered from their `params.<name>` reads.
    const handlerParams = (() => {
        const out = {};
        const sig = {}; const body = {};
        let cur = null;
        for (const line of block.split('\n')) {
            const m = line.match(/^\s{8}async\s+([a-z][a-z0-9_]*)\s*\(([^)]*)\)/);
            if (m) { cur = m[1]; sig[cur] = m[2].trim(); body[cur] = []; }
            else if (cur) { body[cur].push(line); }
        }
        for (const name of Object.keys(sig)) {
            const raw = sig[name];
            if (raw.startsWith('{')) {
                out[name] = raw.replace(/^\{/, '').replace(/\}.*$/, '')
                    .split(',').map((s) => s.trim().split('=')[0].trim()).filter(Boolean);
                continue;
            }
            const first = (raw.split(',')[0] || '').trim();
            const seen = new Set();
            if (first) {
                const re = new RegExp('\\b' + first + '\\.([a-z][a-z0-9_]*)', 'g');
                const text = body[name].join('\n');
                let hit;
                while ((hit = re.exec(text))) seen.add(hit[1]);
            }
            out[name] = [...seen];
        }
        return out;
    })();

    it('extracts sane handler parameter lists', () => {
        assert.deepStrictEqual(handlerParams.getpricesnapshots, ['limit', 'status', 'with_watermark'],
            'handler-param extraction broken for getpricesnapshots');
        assert.deepStrictEqual(handlerParams.getallconfigs, ['since_updated_at', 'include_secrets'],
            'handler-param extraction broken for the params-object form');
        assert.deepStrictEqual(handlerParams.ping, [], 'ping takes no named params');
    });

    it('spec params === handler destructured arguments, per method', () => {
        const declared = Object.fromEntries(spec.methods.map((m) => [m.name, m.params.map((p) => p.name).sort()]));
        const actual = Object.fromEntries(Object.entries(handlerParams).map(([k, v]) => [k, [...v].sort()]));
        assert.deepStrictEqual(declared, actual);
    });

    // The generator used to hardcode `type: object` for every method, a false claim
    // for every array returner. What was wrong is the BLANKET claim, not the object
    // type: a hand-declared object result is exactly the per-method schema this
    // guard exists to encourage, so banning `type: 'object'` outright would forbid
    // the remedy (item #4481). The discriminator is whether the schema constrains
    // anything: `properties` (or additionalProperties/patternProperties) describes a
    // shape, while a bare {type:'object'} asserts only "not an array". Composition
    // branches are walked too, since a blanket claim hidden in a oneOf is the same
    // false claim one level down.
    const blanketObjectPaths = (schema, at = 'result') => {
        if (!schema || typeof schema !== 'object') return [];
        const hits = [];
        const describesShape = (schema.properties && Object.keys(schema.properties).length)
            || schema.additionalProperties || schema.patternProperties;
        if (schema.type === 'object' && !describesShape) hits.push(at);
        for (const kw of ['oneOf', 'anyOf', 'allOf']) {
            (schema[kw] || []).forEach((s, i) => hits.push(...blanketObjectPaths(s, `${at}.${kw}[${i}]`)));
        }
        return hits;
    };

    it('admits a hand-declared object result and rejects only the blanket claim', () => {
        assert.deepStrictEqual(
            blanketObjectPaths({ type: 'object', properties: { status: { type: 'string' } } }), [],
            'a declared object schema must pass, or per-method result shapes cannot be added at all');
        assert.deepStrictEqual(blanketObjectPaths({}), [], 'unspecified stays allowed');
        assert.deepStrictEqual(blanketObjectPaths({ type: 'object' }), ['result'],
            'the generator\'s old blanket claim must still fail');
        assert.deepStrictEqual(
            blanketObjectPaths({ oneOf: [{ type: 'array' }, { type: 'object' }] }), ['result.oneOf[1]'],
            'a blanket claim nested in a composition branch must still fail');
    });

    it('no method result blanket-claims an unconstrained object', () => {
        for (const m of spec.methods) {
            assert.ok(m.result && m.result.schema, `${m.name} result schema`);
            assert.deepStrictEqual(blanketObjectPaths(m.result.schema), [],
                `${m.name} claims type:object without describing the shape: declare its properties, or leave the schema unspecified ({})`);
        }
    });

    it('ping carries a real declared object result', () => {
        // End-to-end proof that the narrowing works through the generator: ping
        // returns {status, db} on both paths (src/api.js:427-437), and its declared
        // schema survives the guard above.
        const m = spec.methods.find((x) => x.name === 'ping');
        assert.strictEqual(m.result.schema.type, 'object');
        assert.deepStrictEqual(Object.keys(m.result.schema.properties).sort(), ['db', 'status']);
    });

    it('getpricesnapshots declares every shape its handler can return', () => {
        // Three, not two: the router puts the handler's return value into `result`
        // verbatim, and a rejected limit/status returns {error} rather than raising
        // a JSON-RPC error, so omitting that branch would make a validating client
        // reject a well-formed response.
        const branches = spec.methods.find((x) => x.name === 'getpricesnapshots').result.schema.oneOf;
        assert.ok(Array.isArray(branches) && branches.length === 3,
            'the bare-array, {watermark, snapshots} and {error} shapes must all be declared');
        assert.ok(branches.some((b) => b.type === 'array'), 'bare-array branch');
        assert.ok(branches.some((b) => Array.isArray(b.required)
            && b.required.join() === 'watermark,snapshots'), 'watermark branch');
        assert.ok(branches.some((b) => Array.isArray(b.required) && b.required.join() === 'error'),
            'in-result error-envelope branch');
    });
});
