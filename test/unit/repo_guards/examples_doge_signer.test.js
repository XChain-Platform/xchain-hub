// doctrine test-coverage program: coverage for the examples component
// (docs/examples/doge-signer.example.js), the reference HUB_SIGNER_MODULE. It is a
// copy-and-run template that fails at load without a configured .env (so a
// broken signer never boots quietly), which means loading it here would throw.
// This pins its structural contract by compiling and inspecting the source: it
// must fail closed on missing publisher credentials and export the broadcast
// entry point the hub's signer pipeline invokes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', '..', 'docs', 'examples', 'doge-signer.example.js');
const source = fs.readFileSync(SRC, 'utf8').replace(/^#!.*\n/, '');

describe('docs/examples/doge-signer (static contract)', function () {
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

    // The declaration is what stops the hub wiring this DOGE-key module into a
    // BTC-rail publisher and paying a DOGE fee for a payload BTC cannot read.
    // A template that quietly dropped it would take every copy with it.
    it('declares the single chain its key can sign for', function () {
        assert.ok(/chains:\s*\['DOGE'\]/.test(source),
            "the reference template must declare chains: ['DOGE']");
    });
});

// Load the reference signer for real, with the SDK and dotenv stubbed, so the
// two-phase pipeline can be driven end to end. The file's load-time credential
// gate is satisfied from the sandbox env rather than bypassed.
function loadSigner(encoder, wallet) {
    const sandboxModule = { exports: {} };
    const sandboxRequire = (id) => {
        if (id === 'path')      return path;
        if (id === 'dotenv')    return { config: () => ({ parsed: {} }) };
        if (id === 'xchain-sdk') return { XChainSDK: function () {
            this.requireEncoder = () => encoder;
            this.wallet = wallet;
        } };
        throw new Error('unexpected require in the reference signer: ' + id);
    };
    vm.runInNewContext(source, {
        require:  sandboxRequire,
        module:   sandboxModule,
        exports:  sandboxModule.exports,
        __dirname: path.dirname(SRC),
        console,
        process:  { env: {
            DOGE_NETWORK:     'dogecoin-testnet',
            DOGE_WIF:         'test-wif',
            DOGE_ADDRESS:     'test-address',
            DOGE_ENCODER_URL: 'http://encoder.invalid'
        } },
        Number, String, Error, Promise, Object
    }, { filename: 'doge-signer.example.js' });
    return sandboxModule.exports;
}

// The reason this matters: the hub reads a definitive encoder rejection as a
// clean pre-send failure and requeues, which re-enters broadcast(), runs
// createTx over fresh UTXOs and funds the same payload a SECOND time. The
// template builds and signs the reveal BEFORE broadcasting phase 1, so a reveal
// the encoder refuses or the key cannot sign stops the publish with nothing on
// chain, and only a reveal BROADCAST failure is left to happen after funding.
function registerPostFundingFailureTests(PHASE1, encoderStub, wallet) {
    it('refuses a spendP2sh rejection before any broadcast, tagged neverSent, keeping the original error', async function () {
        const sent = [];
        const signer = loadSigner(encoderStub({
            spendP2sh:   async () => { throw new Error('Encoder RPC error: bad-txns-inputs-missingorspent'); },
            broadcastTx: async (hex) => { sent.push(hex); return { txid: PHASE1 }; }
        }), wallet);
        let caught = null;
        try { await signer.broadcast('wire'); } catch (e) { caught = e; }
        assert.ok(caught, 'the reveal build failure must still propagate');
        assert.deepStrictEqual(sent, [], 'phase 1 must not be broadcast when the reveal cannot be built');
        assert.strictEqual(caught.neverSent, true);
        assert.strictEqual(caught.fundsCommitted, undefined);
        assert.strictEqual(caught.message, 'Encoder RPC error: bad-txns-inputs-missingorspent');
    });

    it('refuses a reveal that cannot be signed before any broadcast, tagged neverSent', async function () {
        const sent = [];
        const signer = loadSigner(encoderStub({
            broadcastTx: async (hex) => { sent.push(hex); return { txid: PHASE1 }; }
        }), Object.assign({}, wallet, {
            signRevealPsbt: () => { throw new Error('Reveal PSBT finalization failed'); }
        }));
        let caught = null;
        try { await signer.broadcast('wire'); } catch (e) { caught = e; }
        assert.ok(caught);
        assert.deepStrictEqual(sent, [], 'phase 1 must not be broadcast when the reveal cannot be signed');
        assert.strictEqual(caught.neverSent, true);
        assert.strictEqual(caught.fundsCommitted, undefined);
    });

}

function registerBroadcastOrderTests(PHASE1, encoderStub, wallet) {
    it('marks a reveal-broadcast failure funds-committed with the signed reveal to rebroadcast', async function () {
        const sent = [];
        const signer = loadSigner(encoderStub({
            broadcastTx: async (hex) => {
                sent.push(hex);
                if (sent.length === 1) return { txid: PHASE1 };
                throw new Error('Encoder RPC error: min relay fee not met');
            }
        }), wallet);
        let caught = null;
        try { await signer.broadcast('wire'); } catch (e) { caught = e; }
        assert.ok(caught);
        assert.deepStrictEqual(sent, ['hex-1', 'hex-2'], 'phase 1, then the pre-signed reveal');
        assert.strictEqual(caught.fundsCommitted, true);
        assert.strictEqual(caught.phase1Txid, PHASE1);
        assert.strictEqual(caught.revealTxid, 'e'.repeat(64));
        assert.strictEqual(caught.revealTxHex, 'hex-2');
        assert.strictEqual(caught.message, 'Encoder RPC error: min relay fee not met');
    });

    it('leaves a phase-1 broadcast failure untagged, for the hub to classify', async function () {
        const signer = loadSigner(encoderStub({
            broadcastTx: async () => {
                throw Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
            }
        }), wallet);
        let caught = null;
        try { await signer.broadcast('wire'); } catch (e) { caught = e; }
        assert.ok(caught);
        assert.strictEqual(caught.neverSent, undefined);
        assert.strictEqual(caught.fundsCommitted, undefined);
        assert.strictEqual(caught.code, 'ECONNABORTED');
    });

    it('builds and signs the reveal before the first broadcast', async function () {
        const steps = [];
        const signer = loadSigner(encoderStub({
            spendP2sh:   async () => { steps.push('spendP2sh'); return { psbt: 'psbt-2' }; },
            broadcastTx: async (hex) => { steps.push('broadcast:' + hex); return { txid: PHASE1 }; }
        }), Object.assign({}, wallet, {
            signRevealPsbt: () => { steps.push('signReveal'); return { txHex: 'hex-2', txid: 'e'.repeat(64) }; }
        }));
        await signer.broadcast('wire');
        assert.deepStrictEqual(steps, ['spendP2sh', 'signReveal', 'broadcast:hex-1', 'broadcast:hex-2']);
    });
}

function registerFundingOutcomeTests(PHASE1, encoderStub, wallet) {
    it('tags a PRE-funding failure neverSent, so it stays cleanly retryable', async function () {
        const signer = loadSigner(encoderStub({
            createTx: async () => { throw new Error('Encoder RPC error: no UTXOs available'); }
        }), wallet);
        let caught = null;
        try { await signer.broadcast('wire'); } catch (e) { caught = e; }
        assert.ok(caught);
        assert.strictEqual(caught.neverSent, true);
        assert.strictEqual(caught.fundsCommitted, undefined,
            'nothing was funded, so the round must stay retryable');
    });

    it('carries the chain declaration through to the loaded module', function () {
        const signer = loadSigner(encoderStub(), wallet);
        // Array.from: the sandbox builds the literal in its own realm, so the value is
        // a cross-realm array and deepStrictEqual would fail on the prototype alone.
        assert.deepStrictEqual(Array.from(signer.chains), ['DOGE']);
    });

    it('does not tag a successful two-phase publish', async function () {
        const signer = loadSigner(encoderStub(), wallet);
        const res = await signer.broadcast('wire');
        assert.strictEqual(res.phase1_txid, PHASE1);
        assert.strictEqual(res.txid, 'e'.repeat(64));
    });
}

describe('docs/examples/doge-signer (post-funding failures)', function () {
    const PHASE1 = 'f'.repeat(64);

    function encoderStub(overrides) {
        return Object.assign({
            createTx:    async () => ({ psbt: 'psbt-1', encoding: 'P2SH' }),
            broadcastTx: async () => ({ txid: PHASE1 }),
            spendP2sh:   async () => ({ psbt: 'psbt-2' })
        }, overrides || {});
    }
    const wallet = {
        signPsbt:       () => ({ psbt: 'psbt-1', txHex: 'hex-1', txid: PHASE1 }),
        signRevealPsbt: () => ({ txHex: 'hex-2', txid: 'e'.repeat(64) })
    };

    registerPostFundingFailureTests(PHASE1, encoderStub, wallet);
    registerBroadcastOrderTests(PHASE1, encoderStub, wallet);
    registerFundingOutcomeTests(PHASE1, encoderStub, wallet);
});
