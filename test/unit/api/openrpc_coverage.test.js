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
 * the JSON-RPC route families under src/api/rpc/, and its x-auth flags must match the
 * WRITE_METHODS set. Regenerate with: node docs/openrpc.build.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// The controller is merged from the route families under src/api/rpc/, each of which
// declares its methods at the object-method indent the extraction below reads.
function readRpcFamilies() {
  const dir = path.join(__dirname, '../../../src/api/rpc');
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort().map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}
const openrpcJsonMethodCoverageSuite1Src = fs.readFileSync(path.join(__dirname, '../../../src/api.js'), 'utf8');
const openrpcJsonMethodCoverageSuite1Spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../docs/openrpc.json'), 'utf8'));
const openrpcJsonMethodCoverageSuite1Block = readRpcFamilies();
const openrpcJsonMethodCoverageSuite1ControllerMethods = [...openrpcJsonMethodCoverageSuite1Block.matchAll(/^\s{8}async\s+([a-z][a-z0-9_]*)\s*\(/gm)].map(m => m[1]);
const openrpcJsonMethodCoverageSuite1WriteBlock = openrpcJsonMethodCoverageSuite1Src.slice(openrpcJsonMethodCoverageSuite1Src.indexOf('WRITE_METHODS'), openrpcJsonMethodCoverageSuite1Src.indexOf(']', openrpcJsonMethodCoverageSuite1Src.indexOf('WRITE_METHODS')));
const openrpcJsonMethodCoverageSuite1WriteMethods = [...openrpcJsonMethodCoverageSuite1WriteBlock.matchAll(/'([a-z_0-9]+)'/g)].map(m => m[1]);

// x-auth covers everything keyed when HUB_API_KEY is set: writes plus the
// sensitive-read tier (getallconfigs et al.), so extract both sets.
const openrpcJsonMethodCoverageSuite1SensIdx = openrpcJsonMethodCoverageSuite1Src.indexOf('SENSITIVE_READ_METHODS = new Set(');
const openrpcJsonMethodCoverageSuite1SensBlock = openrpcJsonMethodCoverageSuite1Src.slice(openrpcJsonMethodCoverageSuite1SensIdx, openrpcJsonMethodCoverageSuite1Src.indexOf(')', openrpcJsonMethodCoverageSuite1SensIdx));
const openrpcJsonMethodCoverageSuite1SensitiveReads = [...openrpcJsonMethodCoverageSuite1SensBlock.matchAll(/'([a-z_0-9]+)'/g)].map(m => m[1]);
const openrpcJsonMethodCoverageSuite1KeyedMethods = [...new Set([...openrpcJsonMethodCoverageSuite1WriteMethods, ...openrpcJsonMethodCoverageSuite1SensitiveReads])];
// Param fidelity (item #4481). Method-name and x-auth coverage above left the
// PARAMETER lists unchecked, and 20 of ~48 had drifted: getpricesnapshots
// declared only `limit` while the handler reads {limit, status, with_watermark},
// and the dashboard's oracle-feed panel depends on both of the missing two, so
// a rename or removal of exactly the fields protecting it from fork and
// staleness masking was invisible to a contract-driven client. Read each
// handler's real argument names out of src/api/rpc/: a destructured signature
// names them directly, and the handlers taking the whole params object are
// recovered from their `params.<name>` reads.
const openrpcJsonMethodCoverageSuite1HandlerParams = (() => {
  const out = {};
  const sig = {};
  const body = {};
  let cur = null;
  for (const line of openrpcJsonMethodCoverageSuite1Block.split('\n')) {
    const m = line.match(/^\s{8}async\s+([a-z][a-z0-9_]*)\s*\(([^)]*)\)/);
    if (m) {
      cur = m[1];
      sig[cur] = m[2].trim();
      body[cur] = [];
    } else if (cur) {
      body[cur].push(line);
    }
  }
  for (const name of Object.keys(sig)) {
    const raw = sig[name];
    if (raw.startsWith('{')) {
      out[name] = raw.replace(/^\{/, '').replace(/\}.*$/, '').split(',').map(s => s.trim().split('=')[0].trim()).filter(Boolean);
      continue;
    }
    const first = (raw.split(',')[0] || '').trim();
    const seen = new Set();
    if (first) {
      const re = new RegExp('\\b' + first + '\\.([a-z][a-z0-9_]*)', 'g');
      const text = body[name].join('\n');
      let hit;
      while (hit = re.exec(text)) seen.add(hit[1]);
    }
    out[name] = [...seen];
  }
  return out;
})();
// The generator once hardcoded `type: object` for every method, a false claim
// for every array returner. What was wrong is the BLANKET claim, not the object
// type: a hand-declared object result is exactly the per-method schema this
// guard exists to encourage, so banning `type: 'object'` outright would forbid
// the remedy (item #4481). The discriminator is whether the schema constrains
// anything: `properties` (or additionalProperties/patternProperties) describes a
// shape, while a bare {type:'object'} asserts only "not an array". Composition
// branches are walked too, since a blanket claim hidden in a oneOf is the same
// false claim one level down.
const openrpcJsonMethodCoverageSuite1BlanketObjectPaths = (schema, at = 'result') => {
  if (!schema || typeof schema !== 'object') return [];
  const hits = [];
  const describesShape = schema.properties && Object.keys(schema.properties).length || schema.additionalProperties || schema.patternProperties;
  if (schema.type === 'object' && !describesShape) hits.push(at);
  for (const kw of ['oneOf', 'anyOf', 'allOf']) {
    (schema[kw] || []).forEach((s, i) => hits.push(...openrpcJsonMethodCoverageSuite1BlanketObjectPaths(s, `${at}.${kw}[${i}]`)));
  }
  return hits;
};
function registerOpenrpcJsonMethodCoverageSuite1Part1() {
  it('extracts sane method lists', () => {
    assert.ok(openrpcJsonMethodCoverageSuite1ControllerMethods.includes('ping') && openrpcJsonMethodCoverageSuite1ControllerMethods.includes('getallconfigs'), `controller extraction broken: ${openrpcJsonMethodCoverageSuite1ControllerMethods.join(', ')}`);
    assert.ok(openrpcJsonMethodCoverageSuite1WriteMethods.includes('updateconfig'), 'WRITE_METHODS extraction broken');
    assert.ok(openrpcJsonMethodCoverageSuite1SensitiveReads.includes('getallconfigs'), 'SENSITIVE_READ_METHODS extraction broken');
  });
  it('spec methods === controller methods', () => {
    assert.deepStrictEqual(openrpcJsonMethodCoverageSuite1Spec.methods.map(m => m.name).sort(), [...openrpcJsonMethodCoverageSuite1ControllerMethods].sort());
  });
  it('spec x-auth flags === WRITE_METHODS + SENSITIVE_READ_METHODS', () => {
    const flagged = openrpcJsonMethodCoverageSuite1Spec.methods.filter(m => m['x-auth']).map(m => m.name).sort();
    assert.deepStrictEqual(flagged, [...openrpcJsonMethodCoverageSuite1KeyedMethods].sort());
  });
  it('every method has a summary and by-name params', () => {
    for (const m of openrpcJsonMethodCoverageSuite1Spec.methods) {
      assert.ok(m.summary && m.summary.length, `${m.name} summary`);
      assert.strictEqual(m.paramStructure, 'by-name', `${m.name} paramStructure`);
    }
  });
  it('extracts sane handler parameter lists', () => {
    assert.deepStrictEqual(openrpcJsonMethodCoverageSuite1HandlerParams.getpricesnapshots, ['limit', 'status', 'with_watermark'], 'handler-param extraction broken for getpricesnapshots');
    assert.deepStrictEqual(openrpcJsonMethodCoverageSuite1HandlerParams.getallconfigs, ['since_updated_at', 'include_secrets'], 'handler-param extraction broken for the params-object form');
    assert.deepStrictEqual(openrpcJsonMethodCoverageSuite1HandlerParams.ping, [], 'ping takes no named params');
  });
  it('spec params === handler destructured arguments, per method', () => {
    const declared = Object.fromEntries(openrpcJsonMethodCoverageSuite1Spec.methods.map(m => [m.name, m.params.map(p => p.name).sort()]));
    const actual = Object.fromEntries(Object.entries(openrpcJsonMethodCoverageSuite1HandlerParams).map(([k, v]) => [k, [...v].sort()]));
    assert.deepStrictEqual(declared, actual);
  });
}
function registerOpenrpcJsonMethodCoverageSuite1Part2() {
  it('admits a hand-declared object result and rejects only the blanket claim', () => {
    assert.deepStrictEqual(openrpcJsonMethodCoverageSuite1BlanketObjectPaths({
      type: 'object',
      properties: {
        status: {
          type: 'string'
        }
      }
    }), [], 'a declared object schema must pass, or per-method result shapes cannot be added at all');
    assert.deepStrictEqual(openrpcJsonMethodCoverageSuite1BlanketObjectPaths({}), [], 'unspecified stays allowed');
    assert.deepStrictEqual(openrpcJsonMethodCoverageSuite1BlanketObjectPaths({
      type: 'object'
    }), ['result'], 'the generator\'s old blanket claim must still fail');
    assert.deepStrictEqual(openrpcJsonMethodCoverageSuite1BlanketObjectPaths({
      oneOf: [{
        type: 'array'
      }, {
        type: 'object'
      }]
    }), ['result.oneOf[1]'], 'a blanket claim nested in a composition branch must still fail');
  });
  it('no method result blanket-claims an unconstrained object', () => {
    for (const m of openrpcJsonMethodCoverageSuite1Spec.methods) {
      assert.ok(m.result && m.result.schema, `${m.name} result schema`);
      assert.deepStrictEqual(openrpcJsonMethodCoverageSuite1BlanketObjectPaths(m.result.schema), [], `${m.name} claims type:object without describing the shape: declare its properties, or leave the schema unspecified ({})`);
    }
  });
  it('ping carries a real declared object result', () => {
    // End-to-end proof that the narrowing works through the generator: ping
    // returns {status, db} on both paths (src/api.js:427-437), and its declared
    // schema survives the guard above.
    const m = openrpcJsonMethodCoverageSuite1Spec.methods.find(x => x.name === 'ping');
    assert.strictEqual(m.result.schema.type, 'object');
    assert.deepStrictEqual(Object.keys(m.result.schema.properties).sort(), ['db', 'status']);
  });
  it('getpricesnapshots declares every shape its handler can return', () => {
    // Three, not two: the router puts the handler's return value into `result`
    // verbatim, and a rejected limit/status returns {error} rather than raising
    // a JSON-RPC error, so omitting that branch would make a validating client
    // reject a well-formed response.
    const branches = openrpcJsonMethodCoverageSuite1Spec.methods.find(x => x.name === 'getpricesnapshots').result.schema.oneOf;
    assert.ok(Array.isArray(branches) && branches.length === 3, 'the bare-array, {watermark, snapshots} and {error} shapes must all be declared');
    assert.ok(branches.some(b => b.type === 'array'), 'bare-array branch');
    assert.ok(branches.some(b => Array.isArray(b.required) && b.required.join() === 'watermark,snapshots'), 'watermark branch');
    assert.ok(branches.some(b => Array.isArray(b.required) && b.required.join() === 'error'), 'in-result error-envelope branch');
  });
}
describe('openrpc.json method coverage', () => {
  registerOpenrpcJsonMethodCoverageSuite1Part1.call(this);
  registerOpenrpcJsonMethodCoverageSuite1Part2.call(this);
});
