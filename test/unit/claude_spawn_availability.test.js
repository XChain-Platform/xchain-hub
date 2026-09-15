'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -


const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const EventEmitter = require('events');
const os         = require('os');


function makeFakeChild(opts) {

    let child = new EventEmitter();


    child.stdin  = new EventEmitter();
    child.stdin.write = opts && opts.stdinError === 'sync'
        ? (d, cb) => { throw new Error('stdin write failed'); }
        : sinon.stub();
    child.stdin.end = sinon.stub();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();


    child.kill = sinon.stub();


    setImmediate(() => {
        if (opts && opts.spawnError) {
            child.emit('error', new Error(opts.spawnError));
            return;
        }
        if (opts && opts.stdinError === 'async') {
            child.stdin.emit('error', new Error('write EPIPE'));
            return;
        }

        if (opts && opts.noClose) return;
        if (opts && opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
        if (opts && opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
        child.emit('close', opts && opts.exitCode !== undefined ? opts.exitCode : 0);
    });
    return child;
}

function loadClaudeSpawn(spawnOpts, authResult) {
    let spawnStub = sinon.stub().returns(makeFakeChild(spawnOpts || {}));
    let auth      = authResult !== undefined ? authResult : {
        ok:        true,
        transport: 'claude_spawn',
        env:       {}
    };
    let { runClaudePrint, CLAUDE_BIN } = proxyquire('../../src/providers/llm/claude_spawn', {
        'child_process': { spawn: spawnStub },
        '../../lib/hub_credentials': { resolveHubLlmAuth: () => auth }
    });
    return { runClaudePrint, CLAUDE_BIN, spawnStub };
}

describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── a vendor outage on this transport is not a model verdict ──────────────
    // agree() stops the judge fallback chain on transient===false, so a non-zero exit
    // must not land there unconditionally: a 529 seen through the CLI would kill the
    // round while the identical outage over HTTPS fails over to the next judge. The
    // boundary is the HTTP transports' own (isTransientStatus: 429 plus any 5xx).

    it('classifies a CLI-reported 529 overload as transient', async function () {
        let stdout = JSON.stringify({
            type: 'error', status: 529,
            error: { type: 'overloaded_error', message: 'Overloaded' }
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 1, stdout });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(true);
    });

    it('classifies a CLI-reported rate limit on stderr as transient', async function () {
        let { runClaudePrint } = loadClaudeSpawn({
            exitCode: 1, stderr: 'API Error: 429 {"type":"rate_limit_error"}' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(true);
        expect(err.message).to.include('exit 1');
    });

    // The Max-plan wording carries no numeric status at all; captured live on the
    // Prometheus compute pool as "You've hit your session limit, resets 8:20pm (UTC)".
    it('classifies a session-limit exit with no status token as transient', async function () {
        let { runClaudePrint } = loadClaudeSpawn({
            exitCode: 1, stderr: "You've hit your session limit" });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(true);
    });
});
describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    // A deterministic refusal never heals, so it outranks an availability match:
    // advancing the chain would re-ask a different model for an answer the first one
    // already gave. Wording captured live (Prometheus item #2476).
    it('keeps a content refusal hard even when it carries an availability token', async function () {
        let { runClaudePrint } = loadClaudeSpawn({
            exitCode: 1,
            stderr: "API Error: 529 Opus 4.8's safeguards flagged this message." });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient, 'a refusal must not advance the judge chain').to.equal(false);
    });

    // A bare status token is matched by word boundary, so the scan must not read the
    // whole stdout blob: a usage or cost figure would otherwise stand in for a 5xx.
    it('does not read a usage figure in stdout as a status token', async function () {
        let stdout = JSON.stringify({
            is_error: true, subtype: 'error_during_execution', result: '',
            usage: { input_tokens: 500, output_tokens: 429 }
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 1, stdout });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
    });

    it('keeps an unrecognised non-zero exit hard', async function () {
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 2, stderr: 'exceeded --max-budget-usd' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
    });
});
describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── the documented result-envelope fields (item 7756) ─────────────────────
    // The CLI's JSON result carries the vendor's HTTP status on api_error_status and
    // its diagnostics on errors[]. Neither was read, so a 529 arriving in the shape the
    // CLI actually emits (empty stderr, no deprecated status field) classified hard and
    // stopped the judge chain. api_error_status rides on the SUCCESS-shaped result, so
    // the exit-0 branches are routed through the same classifier.

    it('classifies api_error_status 529 on a non-zero exit as transient', async function () {
        let stdout = JSON.stringify({
            type: 'result', subtype: 'success', is_error: true,
            api_error_status: 529, result: ''
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 1, stdout, stderr: '' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(true);
    });

    it('classifies a 429 carried only in errors[] as transient', async function () {
        let stdout = JSON.stringify({
            type: 'result', subtype: 'error_during_execution', is_error: true,
            errors: ['API Error: 429 rate_limit_error']
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 1, stdout, stderr: '' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(true);
    });

    it('routes an exit-0 availability failure with no result text to transient', async function () {
        let stdout = JSON.stringify({
            type: 'result', subtype: 'error_during_execution', is_error: true,
            api_error_status: 503, result: ''
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout, stderr: '' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(true);
    });
});
describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('routes an exit-0 availability failure carrying result text to transient', async function () {
        let stdout = JSON.stringify({
            type: 'result', subtype: 'success', is_error: true,
            api_error_status: 503, result: 'partial'
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout, stderr: '' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(true);
    });

    // Refusal precedence survives the new route in both directions: a refusal subtype
    // short-circuits before the classifier, and refusal WORDING outranks a status token.
    it('keeps an exit-0 refusal hard even when it carries an availability status', async function () {
        let stdout = JSON.stringify({
            type: 'result', subtype: 'refusal', is_error: true,
            api_error_status: 529, result: 'blocked'
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout, stderr: '' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
        expect(err.kind).to.equal('refusal');
    });

    it('keeps a refusal phrase in errors[] hard despite a status token beside it', async function () {
        let stdout = JSON.stringify({
            type: 'result', subtype: 'error_during_execution', is_error: true,
            errors: ['API Error: 529', 'blocked by our content policy']
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 1, stdout, stderr: '' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient, 'a refusal must not advance the judge chain').to.equal(false);
    });
});
describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    // The exit-0 route must not turn every session failure into a retry: an exhausted
    // turn budget is an outcome, not an outage, and it keeps today's hard classification.
    it('keeps an exit-0 max-turns failure hard', async function () {
        let stdout = JSON.stringify({
            type: 'result', subtype: 'error_max_turns', is_error: true, result: 'partial'
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout, stderr: '' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
    });

    // A judge verdict that happens to mention a status token must not re-ask another
    // model: the exit-0 route reads the envelope's own fields, never the result text.
    it('does not read result text as a status token on the exit-0 route', async function () {
        let stdout = JSON.stringify({
            type: 'result', subtype: 'error_during_execution', is_error: true,
            result: 'The claim cites HTTP 503 and is unsupported.'
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout, stderr: '' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
    });

    // ── CLAUDE_BIN export ────────────────────────────────────────────────────

    it('exports CLAUDE_BIN constant (defaults to "claude")', function () {
        let { CLAUDE_BIN } = loadClaudeSpawn();
        expect(typeof CLAUDE_BIN).to.equal('string');
        // CLAUDE_BIN is either 'claude' or whatever CLAUDE_BIN env var says
        expect(CLAUDE_BIN.length).to.be.greaterThan(0);
    });
});

