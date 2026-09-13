/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Unit tests: src/lib/encoder_utxo_forward.js
 *
 * forwardableUtxos decides what every DOGE publisher hands create_tx as its
 * `utxos` param. Within the encoder's caller-supplied cap the array must go
 * over UNCHANGED, so today's request body stays byte-identical; past the cap
 * it must be omitted entirely, so the encoder falls through to its own
 * uncapped fetch instead of answering -32602 forever on an oversized array.
 *
 * The helper landed with five call sites and no test of its own, on the path
 * that spends real DOGE. The last case here is the drift guard: the cap was
 * previously applied inconsistently across the publishers, which is the shape
 * of regression a per-file unit test cannot see.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { forwardableUtxos, ENCODER_MAX_UTXO_COUNT } = require('../../src/lib/encoder_utxo_forward.js');

// Every default-broadcast pipeline that fetches UTXOs and forwards them.
const CALL_SITES = [
    'src/StateAnchorPublisher.js',
    'src/AttestationPublisher.js',
    'src/AttestationRelay.js',
    'src/OraclePublisher.js',
    'src/FullNodeChallengeRound.js'
];

function utxos(n) {
    return Array.from({ length: n }, (_, i) => ({ txid: String(i), vout: 0, value: 1 }));
}

describe('encoder_utxo_forward', function () {

    let warnings;
    let realWarn;

    beforeEach(function () {
        warnings = [];
        realWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
    });

    afterEach(function () {
        console.warn = realWarn;
    });

    it('pins the cap to the encoder validator MAX_UTXO_COUNT', function () {
        // Duplicated from xchain-encoder/src/validator.js by design (the encoder is a
        // separate service over JSON-RPC). A silent drift here re-opens the -32602 loop.
        assert.strictEqual(ENCODER_MAX_UTXO_COUNT, 500);
    });

    it('forwards a set within the cap by identity, not by copy', function () {
        // Identity, not deep-equality: the request body must stay byte-identical to what
        // ships today, so the helper may not rebuild or re-order the array.
        for (const n of [0, 1, ENCODER_MAX_UTXO_COUNT]) {
            const set = utxos(n);
            assert.strictEqual(forwardableUtxos(set, 'anchor'), set, 'length ' + n + ' must pass through');
        }
        assert.strictEqual(warnings.length, 0, 'a within-cap set must not warn');
    });

    it('omits the param past the cap so the encoder self-fetches', function () {
        const set = utxos(ENCODER_MAX_UTXO_COUNT + 1);
        assert.strictEqual(forwardableUtxos(set, 'anchor'), undefined);
        assert.strictEqual(warnings.length, 1, 'exactly one operator warning per oversized set');
        assert.ok(warnings[0].includes('anchor'), 'the warning names the caller');
        assert.ok(warnings[0].includes(String(ENCODER_MAX_UTXO_COUNT + 1)), 'the warning names the actual count');
        assert.ok(warnings[0].includes(String(ENCODER_MAX_UTXO_COUNT)), 'the warning names the cap');
    });

    it('falls back to a generic label when none is supplied', function () {
        assert.strictEqual(forwardableUtxos(utxos(ENCODER_MAX_UTXO_COUNT + 1)), undefined);
        assert.strictEqual(forwardableUtxos(utxos(ENCODER_MAX_UTXO_COUNT + 1), ''), undefined);
        assert.strictEqual(warnings.length, 2);
        for (const w of warnings)
            assert.ok(w.includes('publisher'), 'an unlabelled caller still names itself in the warning');
    });

    it('passes a non-array through unchanged so the encoder names the shape problem', function () {
        // Deliberately NOT normalized here: hiding a wrong shape behind an omitted param
        // would turn a loud -32602 into a silent self-fetch on the wrong address.
        const obj = {};
        assert.strictEqual(forwardableUtxos(undefined, 'anchor'), undefined);
        assert.strictEqual(forwardableUtxos(null, 'anchor'), null);
        assert.strictEqual(forwardableUtxos(obj, 'anchor'), obj);
        assert.strictEqual(forwardableUtxos('x', 'anchor'), 'x');
        assert.strictEqual(warnings.length, 0, 'a shape problem is the encoder\'s to report, not a cap warning');
    });

    it('every broadcast publisher routes its utxos through the helper', function () {
        // The drift guard. Each publisher fetches its own UTXO set, so a new one that
        // forwards the raw array re-introduces the cap failure on that path alone.
        for (const rel of CALL_SITES) {
            const src = fs.readFileSync(path.resolve(__dirname, '../../', rel), 'utf8');
            assert.ok(/require\(['"]\.\/lib\/encoder_utxo_forward\.js['"]\)/.test(src),
                rel + ' does not require the shared UTXO-forward helper');
            assert.ok(/utxos:\s*forwardableUtxos\(/.test(src),
                rel + ' builds create_tx utxos without forwardableUtxos(); the encoder cap is unguarded there');
        }
    });
});
