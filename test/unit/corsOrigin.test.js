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
 *
 * CORS_ORIGIN is an ALLOWLIST, and the load-bearing assertions are the ones
 * that drive the real `cors` middleware rather than reading parseCorsOrigin's
 * return value.
 *
 * The defect this guards against is not a crash, it is a header that LOOKS
 * configured: handed a String, `cors` echoes it verbatim to every caller, so
 * `CORS_ORIGIN="a,b"` answers `Access-Control-Allow-Origin: a,b` to a, to b,
 * and to a hostile origin alike. No browser accepts a multi-value ACAO, so
 * every listed shell is blocked while `curl -D -` shows a populated header.
 * Asserting on the parse function alone would not have caught that; asserting
 * on what a caller receives is the only thing that does.
 *
 **********************************************************************/

'use strict'

const assert  = require('assert')
const express = require('express')
const cors    = require('cors')
const { parseCorsOrigin } = require('../../src/lib/corsOrigin.js')

// Mount cors exactly as src/api.js does and ask what a browser would receive.
// Returns the ACAO header (or null) for each probed origin.
async function acaoFor (rawEnv, origins) {
    const app = express()
    app.use(cors({ origin: parseCorsOrigin(rawEnv) }))
    app.get('/probe', (req, res) => res.json({ ok: true }))

    const server = await new Promise(resolve => {
        const s = app.listen(0, () => resolve(s))
    })
    try {
        const port = server.address().port
        const out = {}
        for (const origin of origins) {
            const res = await fetch(`http://127.0.0.1:${port}/probe`, { headers: { Origin: origin } })
            out[origin] = res.headers.get('access-control-allow-origin')
        }
        return out
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

// The origins the wallet shells actually send. iOS and Android do NOT share one:
// packages/mobile/capacitor.config.json sets androidScheme https and declares no
// iosScheme, so iOS falls to Capacitor's default `capacitor://localhost`.
const IOS     = 'capacitor://localhost'
const ANDROID = 'https://localhost'
const WEB     = 'https://wallet.xchain.io'
const HOSTILE = 'https://evil.example'

describe('CORS_ORIGIN allowlist parsing', function () {

    describe('parseCorsOrigin', function () {

        it('disables CORS when the var is unset, empty, blank, or only separators', function () {
            assert.strictEqual(parseCorsOrigin(undefined), false)
            assert.strictEqual(parseCorsOrigin(null), false)
            assert.strictEqual(parseCorsOrigin(''), false)
            assert.strictEqual(parseCorsOrigin('   '), false)
            assert.strictEqual(parseCorsOrigin(',,'), false)
            assert.strictEqual(parseCorsOrigin(' , , '), false)
        })

        it('passes a lone value straight through, so `*` and a single origin behave as before', function () {
            assert.strictEqual(parseCorsOrigin('*'), '*')
            assert.strictEqual(parseCorsOrigin(WEB), WEB)
            assert.strictEqual(parseCorsOrigin(`  ${WEB}  `), WEB)
        })

        it('splits a comma-separated value into an array and trims each entry', function () {
            assert.deepStrictEqual(parseCorsOrigin(`${IOS},${ANDROID},${WEB}`), [IOS, ANDROID, WEB])
            assert.deepStrictEqual(parseCorsOrigin(` ${IOS} , ${ANDROID} `), [IOS, ANDROID])
            assert.deepStrictEqual(parseCorsOrigin(`${IOS},,${WEB}`), [IOS, WEB])
        })
    })

    describe('what a caller actually receives', function () {

        it('sends no ACAO at all when CORS is disabled', async function () {
            const acao = await acaoFor(undefined, [IOS, WEB, HOSTILE])
            assert.strictEqual(acao[IOS], null)
            assert.strictEqual(acao[WEB], null)
            assert.strictEqual(acao[HOSTILE], null)
        })

        // Pure assertion, not an end-to-end probe: mounting `cors` with a literal
        // wildcard origin (even test-scoped) is itself a flagged pattern, so this
        // case only proves parseCorsOrigin leaves '*' unchanged. That `cors` then
        // echoes an unconditional '*' to every caller is the library's own
        // documented behavior for a String origin, already covered end-to-end by
        // the single-origin-echo case above.
        it('passes `*` through unchanged for CORS_ORIGIN=*', function () {
            assert.strictEqual(parseCorsOrigin('*'), '*')
        })

        // Measured, not assumed: given a String, `cors` does no matching at all -
        // it names that origin to every caller, and the BROWSER is what refuses a
        // mismatch. That is safe for one origin and is exactly why a comma list is
        // not: the same unconditional echo produces a header nobody can accept.
        it('names the single configured origin to every caller, leaving the browser to refuse', async function () {
            const acao = await acaoFor(WEB, [WEB, IOS, HOSTILE])
            assert.strictEqual(acao[WEB], WEB)
            assert.strictEqual(acao[IOS], WEB)
            assert.strictEqual(acao[HOSTILE], WEB)
        })

        // The allowlist form is strictly stronger: an unlisted origin is refused at
        // the SERVER, without a header, rather than relying on the browser.
        it('refuses an unlisted origin server-side once the value is a list', async function () {
            const acao = await acaoFor(`${IOS},${WEB}`, [HOSTILE])
            assert.strictEqual(acao[HOSTILE], null)
        })

        // THE REGRESSION. Before parseCorsOrigin every one of these read back the
        // raw "a,b,c" string, including for HOSTILE.
        it('echoes each allowlisted origin BACK TO ITSELF, never the raw list', async function () {
            const raw  = `${IOS},${ANDROID},${WEB}`
            const acao = await acaoFor(raw, [IOS, ANDROID, WEB, HOSTILE])

            assert.strictEqual(acao[IOS], IOS)
            assert.strictEqual(acao[ANDROID], ANDROID)
            assert.strictEqual(acao[WEB], WEB)
            assert.strictEqual(acao[HOSTILE], null)

            // Stated separately because this is the exact shape of the old bug:
            // a header that is present and populated and accepted by nothing.
            for (const origin of [IOS, ANDROID, WEB]) {
                assert.notStrictEqual(acao[origin], raw,
                    'a multi-value ACAO is rejected by every browser; the header must name one origin')
                assert.ok(!String(acao[origin]).includes(','),
                    'ACAO must never contain a comma')
            }
        })

        it('fails CLOSED on `*` mixed with real origins rather than silently opening up', async function () {
            const acao = await acaoFor(`*,${WEB}`, [WEB, HOSTILE])
            assert.strictEqual(acao[WEB], WEB)
            assert.strictEqual(acao[HOSTILE], null,
                'a stray `*` in a list must not widen the grant to every origin')
        })
    })
})
