// doctrine test-coverage program: unit coverage for src/hub-schema-version.js.
// The hub stamps (and version-gates) this schema-version into every mirror
// broadcast; a wrong shape silently disables the consumer fork-guard. Pins the
// module to a single positive-integer export and nothing else.

const assert = require('assert');
const mod = require('../../src/hub-schema-version.js');

describe('hub-schema-version', function () {
    it('exports exactly HUB_SCHEMA_VERSION', function () {
        assert.deepStrictEqual(Object.keys(mod).sort(), ['HUB_SCHEMA_VERSION']);
    });

    it('HUB_SCHEMA_VERSION is a positive safe integer', function () {
        const v = mod.HUB_SCHEMA_VERSION;
        assert.strictEqual(typeof v, 'number');
        assert.ok(Number.isSafeInteger(v));
        assert.ok(v >= 1, 'versions start at 1; 0/negative would disable the gate');
    });

    it('is stable across re-require (frozen constant, no lazy init)', function () {
        delete require.cache[require.resolve('../../src/hub-schema-version.js')];
        const again = require('../../src/hub-schema-version.js');
        assert.strictEqual(again.HUB_SCHEMA_VERSION, mod.HUB_SCHEMA_VERSION);
    });
});
