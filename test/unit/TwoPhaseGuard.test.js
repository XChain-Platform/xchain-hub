/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Unit tests: src/lib/two_phase_guard.js
 *
 * The built-in _defaultBroadcast pipelines do one create_tx, one walletSign and
 * one broadcastTx. On the encoder's P2SH/P2WSH lane that answer is the FUNDING
 * transaction of a two-transaction contract: the payload only becomes readable
 * once a reveal spends those outputs, and the hub has no reveal. Broadcasting it
 * publishes an undecodable action, reports its txid as success and strands the
 * carrier value, because carrierScripts (the only material a reveal or a sweep
 * could be rebuilt from) is discarded.
 *
 * So the guard has to fire on the encoder's ANSWER, before the wallet hook runs,
 * and it must NOT fire on a single-transaction answer - the encoder downgrades a
 * payload-less build to OP_RETURN and reports that, so gating on the REQUESTED
 * encoding would fail a good build closed. The last case is the drift guard:
 * hub CI mocks EncoderClient, so a new pipeline that skips the guard is exactly
 * the regression no behavioural test in this repo can see.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { assertSingleTxEncoding } = require('../../src/lib/two_phase_guard.js');

// Every pipeline that builds a PSBT itself and hands it to the wallet hook.
const CALL_SITES = [
    'src/StateAnchorPublisher.js',
    'src/AttestationPublisher.js',
    'src/AttestationRelay.js',
    'src/OraclePublisher.js',
    'src/FullNodeChallengeRound.js'
];

describe('two_phase_guard', function () {

    it('throws on the P2SH and P2WSH funding answers', function () {
        for (const encoding of ['P2SH', 'P2WSH', 'p2sh', 'p2wsh']) {
            assert.throws(
                () => assertSingleTxEncoding({ psbt: 'aa', encoding }, 'OraclePublisher'),
                /two-transaction/,
                encoding + ' must be refused');
        }
    });

    it('names the caller and the working configuration in the error', function () {
        assert.throws(
            () => assertSingleTxEncoding({ psbt: 'aa', encoding: 'P2SH' }, 'AttestationRelay'),
            (e) => /AttestationRelay/.test(e.message) &&
                   /HUB_SIGNER_MODULE/.test(e.message) &&
                   /doge-signer\.example\.js/.test(e.message));
    });

    it('throws on a taproot envelope answer, which is two transactions too', function () {
        assert.throws(
            () => assertSingleTxEncoding({ psbt: 'aa', encoding: 'TAPROOT', revealPsbt: 'bb' }, 'x'),
            /two-transaction/);
    });

    it('throws on carrierScripts even when the answer omits the encoding', function () {
        // Belt and braces: carrierScripts rides along on every chunked lane, so an
        // encoder answer that names no encoding is still recognisably phase 1.
        assert.throws(
            () => assertSingleTxEncoding({ psbt: 'aa', carrierScripts: ['00ff'] }, 'x'),
            /two-transaction/);
    });

    it('passes the single-transaction lanes through untouched', function () {
        // The encoder reports the encoding it actually BUILT, and answers OP_RETURN when
        // there is no action payload to chunk even if P2SH was requested. Gating on the
        // request instead of the answer would fail these closed.
        for (const encoding of ['OP_RETURN', 'MULTISIGN', 'op_return']) {
            assert.doesNotThrow(() => assertSingleTxEncoding({ psbt: 'aa', encoding }, 'x'));
        }
        // An empty carrierScripts array is not by itself a two-phase signal.
        assert.doesNotThrow(() => assertSingleTxEncoding({ psbt: 'aa', encoding: 'OP_RETURN', carrierScripts: [] }, 'x'));
    });

    it('is a no-op on a missing or non-object answer, leaving that error to the caller', function () {
        // The caller already throws 'encoder returned no PSBT' on those, and the guard
        // must not pre-empt it with a misleading two-phase message.
        assert.doesNotThrow(() => assertSingleTxEncoding(null, 'x'));
        assert.doesNotThrow(() => assertSingleTxEncoding(undefined, 'x'));
        assert.doesNotThrow(() => assertSingleTxEncoding('P2SH', 'x'));
    });

    it('every built-in publish pipeline runs the guard before signing', function () {
        // The drift guard. Each pipeline builds its own PSBT, so a new one that signs
        // without the check re-opens the stranded-funds path on that rail alone.
        for (const rel of CALL_SITES) {
            const src = fs.readFileSync(path.resolve(__dirname, '../../', rel), 'utf8');
            assert.ok(/require\(['"]\.\/lib\/two_phase_guard\.js['"]\)/.test(src),
                rel + ' does not require the shared two-phase guard');
            const guardAt = src.indexOf('assertSingleTxEncoding(');
            // The AWAITED call, not a comment or a hook-setter mention of the name.
            const signAt  = src.search(/await\s+[A-Za-z_.]*walletSignFn\(/);
            assert.ok(guardAt > -1, rel + ' never calls assertSingleTxEncoding');
            assert.ok(signAt  > -1, rel + ' has no wallet-sign call to guard');
            assert.ok(guardAt < signAt,
                rel + ' must refuse a two-phase encoding BEFORE the wallet hook runs');
        }
    });
});
