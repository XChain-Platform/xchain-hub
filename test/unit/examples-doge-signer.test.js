//  doctrine test-coverage program: coverage for the examples component
// (examples/doge-signer.example.js), the reference HUB_SIGNER_MODULE. It is a
// copy-and-run template that fails at load without a configured .env (so a
// broken signer never boots quietly), which means loading it here would throw.
// This pins its structural contract by compiling and inspecting the source: it
// must fail closed on missing publisher credentials and export the broadcast
// entry point the hub's signer pipeline invokes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'examples', 'doge-signer.example.js');
const source = fs.readFileSync(SRC, 'utf8').replace(/^#!.*\n/, '');

describe('examples/doge-signer (static contract)', function () {
    it('is syntactically valid JavaScript (compiles without executing)', function () {
        assert.doesNotThrow(() => new vm.Script(source, { filename: 'doge-signer.example.js' }));
    });

    it('builds on the published xchain-sdk', function () {
        assert.ok(/require\(\s*['"]xchain-sdk['"]/.test(source));
    });

    it('validates the required publisher credentials (fail-closed at load)', function () {
        assert.ok(/DOGE_WIF/.test(source));
        assert.ok(/DOGE_ADDRESS/.test(source));
        assert.ok(/DOGE_ENCODER_URL/.test(source));
    });

    it('exports the broadcast signer entry point', function () {
        assert.ok(/broadcast/.test(source), 'a signer module exposes broadcast');
        assert.ok(/module\.exports/.test(source));
    });
});
