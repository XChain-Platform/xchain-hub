'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { closeOutcome } = require('../../../../src/providers/llm/cli_outcome.js');
const { isTransientStatus } = require('../../../../src/providers/llm/http.js');

// A text-only failure must fail over exactly as the HTTP transports would for the
// same status: the boundary is isTransientStatus, 429 plus any 5xx.
describe('CLI outcome: a status the text names as one', function () {

    it('reads a gateway 5xx outside the bare-token list as transient', function () {
        for (const stderr of ['API Error: 522 <html>origin timed out</html>', 'API Error: 501',
                              'HTTP/1.1 520 Origin Error', 'upstream status code: 530']) {
            expect(closeOutcome(1, '', stderr).transient, stderr).to.equal(true);
        }
    });

    it('agrees with isTransientStatus on every named status from 400 to 599', function () {
        for (let s = 400; s <= 599; s++) {
            expect(closeOutcome(1, '', 'API Error: ' + s).transient, String(s)).to.equal(isTransientStatus(s));
        }
    });

    it('keeps a 4xx status phrase and a bare unphrased number hard', function () {
        for (const stderr of ['API Error: 404 not_found_error', 'processed 512 tokens', 'config line 540']) {
            expect(closeOutcome(1, '', stderr).transient, stderr).to.equal(false);
        }
    });

    it('keeps a refusal hard even beside a named 5xx', function () {
        const out = closeOutcome(1, '', "API Error: 522 the model's safeguards flagged this message.");
        expect(out.transient).to.equal(false);
    });

    it('reads a structured status anywhere in the 5xx range as transient', function () {
        expect(closeOutcome(1, JSON.stringify({ type: 'error', status: 530 }), '').transient).to.equal(true);
        expect(closeOutcome(1, JSON.stringify({ type: 'error', status: 418 }), '').transient).to.equal(false);
    });
});
