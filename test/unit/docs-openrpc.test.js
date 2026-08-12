// doctrine test-coverage program: unit coverage for the docs component
// (docs/openrpc.build.js -> docs/openrpc.json). The OpenRPC document is the
// published contract for the hub's JSON-RPC surface; this pins the generated
// artifact's shape without invoking the side-effecting build script.

const assert = require('assert');
const doc = require('../../docs/openrpc.json');

describe('docs/openrpc.json', function () {
    it('declares an OpenRPC version and info block', function () {
        assert.strictEqual(typeof doc.openrpc, 'string');
        assert.ok(/^\d+\.\d+\.\d+$/.test(doc.openrpc));
        assert.ok(doc.info && typeof doc.info.title === 'string' && doc.info.title.length > 0);
    });

    it('exposes a non-empty, well-formed methods array with unique names', function () {
        assert.ok(Array.isArray(doc.methods) && doc.methods.length > 0);
        for (const m of doc.methods) {
            assert.strictEqual(typeof m.name, 'string');
            assert.ok(m.name.length > 0);
            assert.ok(Array.isArray(m.params), `${m.name} must declare params[]`);
        }
        const names = doc.methods.map((m) => m.name);
        assert.strictEqual(new Set(names).size, names.length, 'method names must be unique');
    });
});
