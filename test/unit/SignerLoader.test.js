/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Unit tests: src/lib/signer-loader.js
 *
 * The loader is the production boot path that wires an operator-supplied
 * signer module (HUB_SIGNER_MODULE) into the DOGE publishers. Policy under
 * test: unset → null (publishers idle); set-but-broken → throw (loud boot
 * failure); valid → hooks that delegate to the module's exports.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { loadSignerHooks, applySignerHooks } = require('../../src/lib/signer-loader.js');

describe('signer-loader', function () {

    let tmpDir;

    before(function () {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-signer-test-'));
    });

    after(function () {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    });

    function writeModule(name, source) {
        let p = path.join(tmpDir, name);
        fs.writeFileSync(p, source);
        return p;
    }

    describe('loadSignerHooks()', function () {

        it('returns null when HUB_SIGNER_MODULE is unset', function () {
            assert.strictEqual(loadSignerHooks({}), null);
            assert.strictEqual(loadSignerHooks({ HUB_SIGNER_MODULE: '' }), null);
        });

        it('loads a valid module and delegates walletSign', async function () {
            let p = writeModule('valid.js',
                'module.exports = { walletSign: async (psbt) => "signed:" + psbt };');
            let hooks = loadSignerHooks({ HUB_SIGNER_MODULE: p });
            assert.ok(hooks);
            assert.strictEqual(hooks.source, p);
            assert.strictEqual(await hooks.walletSignFn('abc123'), 'signed:abc123');
            assert.strictEqual(hooks.broadcastFn, null);
            assert.strictEqual(hooks.getBalanceFn, null);
        });

        it('exposes optional broadcast and getBalance hooks when exported', async function () {
            let p = writeModule('full.js',
                'module.exports = {' +
                '  walletSign: async () => "tx",' +
                '  broadcast: async (payload) => ({ txid: "t-" + payload }),' +
                '  getBalance: async () => 42' +
                '};');
            let hooks = loadSignerHooks({ HUB_SIGNER_MODULE: p });
            assert.deepStrictEqual(await hooks.broadcastFn('PAYLOAD'), { txid: 't-PAYLOAD' });
            assert.strictEqual(await hooks.getBalanceFn(), 42);
        });

        it('throws when the module path does not resolve', function () {
            assert.throws(
                () => loadSignerHooks({ HUB_SIGNER_MODULE: path.join(tmpDir, 'missing.js') }),
                /HUB_SIGNER_MODULE failed to load/);
        });

        it('throws when the module throws at load time (e.g. missing key)', function () {
            let p = writeModule('throwing.js', 'throw new Error("DOGE_WIF is not set");');
            assert.throws(
                () => loadSignerHooks({ HUB_SIGNER_MODULE: p }),
                /failed to load .*DOGE_WIF is not set/);
        });

        it('throws when walletSign is missing', function () {
            let p = writeModule('no-sign.js', 'module.exports = { broadcast: async () => ({}) };');
            assert.throws(
                () => loadSignerHooks({ HUB_SIGNER_MODULE: p }),
                /must export a walletSign/);
        });

        it('throws when an optional export is present but not a function', function () {
            let p = writeModule('bad-opt.js',
                'module.exports = { walletSign: async () => "tx", getBalance: 7 };');
            assert.throws(
                () => loadSignerHooks({ HUB_SIGNER_MODULE: p }),
                /"getBalance" must be a function/);
        });
    });

    describe('applySignerHooks()', function () {

        function fakePublisher() {
            return {
                walletSignFn: null, broadcastFn: null, getBalanceFn: null,
                setWalletSignHook(fn) { this.walletSignFn = fn; },
                setBroadcastHook(fn)  { this.broadcastFn  = fn; },
                setBalanceHook(fn)    { this.getBalanceFn = fn; }
            };
        }

        it('returns false for null hooks or publisher', function () {
            assert.strictEqual(applySignerHooks(fakePublisher(), null), false);
            assert.strictEqual(applySignerHooks(null, { walletSignFn: () => {} }), false);
        });

        it('wires walletSign and skips absent optional hooks', function () {
            let pub = fakePublisher();
            let sign = async () => 'tx';
            assert.strictEqual(
                applySignerHooks(pub, { walletSignFn: sign, broadcastFn: null, getBalanceFn: null }),
                true);
            assert.strictEqual(pub.walletSignFn, sign);
            assert.strictEqual(pub.broadcastFn, null);
            assert.strictEqual(pub.getBalanceFn, null);
        });

        it('wires all hooks when present', function () {
            let pub = fakePublisher();
            let hooks = { walletSignFn: async () => 'tx', broadcastFn: async () => ({}), getBalanceFn: async () => 1 };
            applySignerHooks(pub, hooks);
            assert.strictEqual(pub.walletSignFn, hooks.walletSignFn);
            assert.strictEqual(pub.broadcastFn, hooks.broadcastFn);
            assert.strictEqual(pub.getBalanceFn, hooks.getBalanceFn);
        });
    });
});
