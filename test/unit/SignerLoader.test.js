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

const { loadSignerHooks, applySignerHooks, buildSignerHooks } = require('../../src/lib/signer-loader.js');

// Capture console.warn for the chain-refusal assertions: the warn line IS the
// contract (an operator's only signal that a publisher is deliberately idle), so
// it is asserted, not merely tolerated.
function captureWarn(fn) {
    let lines = [];
    let original = console.warn;
    console.warn = (...args) => lines.push(args.join(' '));
    try { fn(); } finally { console.warn = original; }
    return lines;
}

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

        // The chain declaration. Absent means DOGE only, because the hub's
        // one historical signer holds the DOGE key and silence must mean the narrow
        // answer, never "this key is good for every rail".
        it('defaults an undeclared module to DOGE only', function () {
            let p = writeModule('undeclared.js', 'module.exports = { walletSign: async () => "tx" };');
            let hooks = loadSignerHooks({ HUB_SIGNER_MODULE: p });
            assert.deepStrictEqual(hooks.chains, ['DOGE']);
        });

        it('accepts a chains export and normalizes the tickers', function () {
            let p = writeModule('multi.js',
                'module.exports = { walletSign: async () => "tx", chains: ["doge", " BTC ", "DOGE"] };');
            let hooks = loadSignerHooks({ HUB_SIGNER_MODULE: p });
            assert.deepStrictEqual(hooks.chains, ['DOGE', 'BTC']);
        });

        it('throws when chains is not an array', function () {
            let p = writeModule('chains-string.js',
                'module.exports = { walletSign: async () => "tx", chains: "DOGE" };');
            assert.throws(() => loadSignerHooks({ HUB_SIGNER_MODULE: p }),
                /"chains" must be a non-empty array/);
        });

        it('throws when chains is an empty array', function () {
            let p = writeModule('chains-empty.js',
                'module.exports = { walletSign: async () => "tx", chains: [] };');
            assert.throws(() => loadSignerHooks({ HUB_SIGNER_MODULE: p }),
                /"chains" must be a non-empty array/);
        });

        it('throws when a chains entry is not a non-empty string', function () {
            for (let bad of ['[1]', '["DOGE", ""]', '["DOGE", null]']) {
                let p = writeModule('chains-bad-' + Buffer.from(bad).toString('hex') + '.js',
                    'module.exports = { walletSign: async () => "tx", chains: ' + bad + ' };');
                assert.throws(() => loadSignerHooks({ HUB_SIGNER_MODULE: p }),
                    /"chains" must contain only non-empty coin ticker strings/, bad);
            }
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

    // The chain gate. A DOGE signer wired into a BTC-rail publisher signed and
    // broadcast BTC-intended payloads on Dogecoin (measured 2026-09-04): DOGE fees
    // spent, invalid REQUEST_ID and zero responses on the BTC side.
    describe('applySignerHooks() chain gate', function () {

        function fakePublisher(signingChain) {
            function OraclePublisher() {}
            let pub = new OraclePublisher();
            Object.assign(pub, {
                walletSignFn: null, broadcastFn: null, getBalanceFn: null, wiredChain: null,
                setWalletSignHook(fn, chain) { this.walletSignFn = fn; this.wiredChain = chain; },
                setBroadcastHook(fn)  { this.broadcastFn  = fn; },
                setBalanceHook(fn)    { this.getBalanceFn = fn; }
            });
            if (signingChain) pub.signingChain = signingChain;
            return pub;
        }

        const dogeHooks = () => ({
            source: '/operator/signer.js', chains: ['DOGE'],
            walletSignFn: async () => 'tx', broadcastFn: async () => ({ txid: 't' }), getBalanceFn: async () => 5
        });

        it('wires a DOGE publisher from a DOGE module and tags the hook with the chain', function () {
            let pub = fakePublisher();
            assert.strictEqual(applySignerHooks(pub, dogeHooks(), 'DOGE'), true);
            assert.strictEqual(typeof pub.walletSignFn, 'function');
            assert.strictEqual(pub.wiredChain, 'DOGE');
        });

        it('refuses a BTC publisher and leaves sign, broadcast AND balance unwired', function () {
            let pub = fakePublisher();
            let lines = captureWarn(() => {
                assert.strictEqual(applySignerHooks(pub, dogeHooks(), 'BTC'), false);
            });
            assert.strictEqual(pub.walletSignFn, null);
            assert.strictEqual(pub.broadcastFn, null,
                'a refused publisher must not keep a broadcast pipeline');
            assert.strictEqual(pub.getBalanceFn, null,
                'a DOGE balance says nothing about the BTC wallet');
            assert.strictEqual(lines.length, 1, 'exactly one warn line per refused wiring');
            assert.match(lines[0], /OraclePublisher/);          // names the publisher
            assert.match(lines[0], /settles on BTC/);           // names the chain it needs
            assert.match(lines[0], /declares chains \[DOGE\]/); // names what the module declares
            assert.match(lines[0], /UNWIRED/);
        });

        it('reads the publisher-declared signingChain when the caller names none', function () {
            let pub = fakePublisher('BTC');
            let refused = captureWarn(() => {
                assert.strictEqual(applySignerHooks(pub, dogeHooks()), false);
            });
            assert.strictEqual(refused.length, 1);
            assert.strictEqual(pub.walletSignFn, null);
        });

        it('treats an undeclared module as DOGE-only at the wiring site too', function () {
            let pub = fakePublisher();
            let hooks = { source: '/legacy.js', walletSignFn: async () => 'tx' };  // pre-`chains` module
            assert.strictEqual(applySignerHooks(pub, hooks, 'DOGE'), true);
            let pubBtc = fakePublisher();
            captureWarn(() => assert.strictEqual(applySignerHooks(pubBtc, hooks, 'BTC'), false));
        });

        it('wires a BTC publisher from a module that declares BTC', function () {
            let pub = fakePublisher('BTC');
            let hooks = Object.assign(dogeHooks(), { chains: ['DOGE', 'BTC'] });
            assert.strictEqual(applySignerHooks(pub, hooks), true);
            assert.strictEqual(pub.wiredChain, 'BTC');
        });

        it('matches the declaration case-insensitively', function () {
            let pub = fakePublisher();
            assert.strictEqual(applySignerHooks(pub, dogeHooks(), 'doge'), true);
            assert.strictEqual(pub.wiredChain, 'DOGE');
        });
    });

    // buildSignerHooks is the validation half of loadSignerHooks, exported so a test
    // can drive a module it cannot require() (the reference template needs operator
    // credentials at load).
    describe('buildSignerHooks()', function () {
        it('applies the same contract as loadSignerHooks', function () {
            assert.deepStrictEqual(buildSignerHooks({ walletSign: async () => 'tx' }, 'inline').chains, ['DOGE']);
            assert.throws(() => buildSignerHooks({}, 'inline'), /must export a walletSign/);
            assert.throws(() => buildSignerHooks({ walletSign: async () => 'tx', chains: {} }, 'inline'),
                /"chains" must be a non-empty array/);
        });
    });
});
