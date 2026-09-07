// doctrine test-coverage program: coverage for the examples component
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

// Load the reference signer for real, with the SDK and dotenv stubbed, so the
// two-phase pipeline can be driven end to end. The file's load-time credential
// gate is satisfied from the sandbox env rather than bypassed.
function loadSigner(encoder, wallet) {
    const sandboxModule = { exports: {} };
    const sandboxRequire = (id) => {
        if (id === 'path')      return path;
        if (id === 'dotenv')    return { config: () => ({ parsed: {} }) };
        if (id === 'xchain-sdk') return { XChainSDK: function () {
            this._requireEncoder = () => encoder;
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
// createTx over fresh UTXOs and funds the same payload a SECOND time. Once
// phase 1 is on the wire the signer owes the caller the fact that money moved.
describe('examples/doge-signer (post-funding failures)', function () {
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

    it('marks a definitive spendP2sh rejection as funds-committed, keeping the original error', async function () {
        const signer = loadSigner(encoderStub({
            spendP2sh: async () => { throw new Error('Encoder RPC error: bad-txns-inputs-missingorspent'); }
        }), wallet);
        let caught = null;
        try { await signer.broadcast('wire'); } catch (e) { caught = e; }
        assert.ok(caught, 'the phase-2 failure must still propagate');
        assert.strictEqual(caught.fundsCommitted, true);
        assert.strictEqual(caught.phase1Txid, PHASE1);
        assert.strictEqual(caught.message, 'Encoder RPC error: bad-txns-inputs-missingorspent');
    });

    it('marks a reveal-broadcast failure too, not only the spend build', async function () {
        let calls = 0;
        const signer = loadSigner(encoderStub({
            broadcastTx: async () => {
                calls++;
                if (calls === 1) return { txid: PHASE1 };
                throw new Error('Encoder RPC error: min relay fee not met');
            }
        }), wallet);
        let caught = null;
        try { await signer.broadcast('wire'); } catch (e) { caught = e; }
        assert.ok(caught);
        assert.strictEqual(caught.fundsCommitted, true);
        assert.strictEqual(caught.phase1Txid, PHASE1);
    });

    it('leaves a PRE-funding failure untagged, so it stays cleanly retryable', async function () {
        const signer = loadSigner(encoderStub({
            createTx: async () => { throw new Error('Encoder RPC error: no UTXOs available'); }
        }), wallet);
        let caught = null;
        try { await signer.broadcast('wire'); } catch (e) { caught = e; }
        assert.ok(caught);
        assert.strictEqual(caught.fundsCommitted, undefined,
            'nothing was funded, so the round must stay retryable');
    });

    it('does not tag a successful two-phase publish', async function () {
        const signer = loadSigner(encoderStub(), wallet);
        const res = await signer.broadcast('wire');
        assert.strictEqual(res.phase1_txid, PHASE1);
        assert.strictEqual(res.txid, 'e'.repeat(64));
    });
});
