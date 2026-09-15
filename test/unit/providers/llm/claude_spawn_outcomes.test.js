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
    let { runClaudePrint, CLAUDE_BIN } = proxyquire('../../../../src/providers/llm/claude_spawn', {
        'child_process': { spawn: spawnStub },
        '../../lib/hub_credentials': { resolveHubLlmAuth: () => auth }
    });
    return { runClaudePrint, CLAUDE_BIN, spawnStub };
}

describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── #2487: kind/transient classification on rejections ───────────────────
    // agree()'s judge fallback chain gates on err.kind/err.transient. A reached-CLI
    // hard outcome (transient=false) must NOT advance the chain; a transport failure
    // (transient=true) may. Pin each rejection path's classification.

    it('classifies a non-zero exit as a reached-CLI hard outcome (transient=false)', async function () {
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 1, stderr: 'api 400' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
    });

    it('classifies unparseable JSON as transient=false', async function () {
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: 'NOT JSON' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
    });

    it('classifies an empty-result refusal (is_error) as kind=refusal, transient=false', async function () {
        let jsonOut = JSON.stringify({ is_error: true, subtype: 'refusal', result: '' });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
        expect(err.kind).to.equal('refusal');
    });
});
describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    // item 3484: the CLI's own session-failure subtypes carry is_error true and the
    // substring 'error', so the old is_error-OR-/error/ test reported an exhausted
    // turn budget as a model refusal. They must stay non-transient (the CLI was
    // reached, the judge chain must not advance) but carry no refusal kind.
    it('does NOT call a session-level CLI failure a refusal', async function () {
        for (const subtype of ['error_max_turns', 'error_during_execution']) {
            let jsonOut = JSON.stringify({ is_error: true, subtype, result: '' });
            let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
            let err;
            try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
            catch (e) { err = e; }
            expect(err, subtype).to.exist;
            expect(err.transient, subtype).to.equal(false);
            expect(err.kind, subtype + ' must not be tagged a refusal').to.equal(undefined);
            expect(err.message, subtype).to.include(subtype);
        }
    });

    it('still calls an explicit refusal subtype a refusal without is_error', async function () {
        let jsonOut = JSON.stringify({ subtype: 'declined_by_policy', result: '' });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
        expect(err.kind).to.equal('refusal');
    });

    // item 4468 / 4467: a reached-CLI failure that still emits result text could wrongly
    // resolve as a sound verdict, because only the EMPTY-result branch inspected the
    // failure signal. The text of a failed run is partial, and this wrapper feeds the
    // trusted attestation/judge path, so is_error must fail closed at any length.
    it('fails closed on a NON-EMPTY result carrying is_error', async function () {
        let jsonOut = JSON.stringify({
            is_error: true, subtype: 'error_max_turns', result: 'partial verdict text...'
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err, 'a partial result from a failed run must not resolve').to.exist;
        expect(err.transient).to.equal(false);
        expect(err.kind, 'a session failure is not a refusal').to.equal(undefined);
        expect(err.message).to.include('error_max_turns');
    });
});
describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('tags a NON-EMPTY refusal-subtype result as kind=refusal', async function () {
        let jsonOut = JSON.stringify({
            is_error: true, subtype: 'refusal', result: 'I cannot help with that be'
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(false);
        expect(err.kind).to.equal('refusal');
    });

    it('still resolves a non-empty result when the CLI reports no error', async function () {
        let jsonOut = JSON.stringify({ is_error: false, subtype: 'success', result: 'the verdict' });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let out = await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' });
        expect(out.result).to.equal('the verdict');
    });

    // Review board #7755: the CLI's result envelope DOES carry a top-level stop_reason
    // (the shipped CLI emits it on the type:"result" frame, alongside end_turn / tool_use
    // / stop_sequence / refusal), so without a check on it a refusal or a truncated
    // answer arriving with is_error false and non-empty text resolves as a sound
    // verdict. The two direct HTTP transports reject those outcomes even when text is
    // (providers/llm.js refusal and truncation branches); this transport signs its text
    // into on-chain attestation answers, so it must not be the lane that accepts them.
    it('fails closed on stop_reason=refusal alongside result text', async function () {
        let jsonOut = JSON.stringify({
            is_error: false, subtype: 'success', result: 'I cannot help with that',
            stop_reason: 'refusal'
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err, 'a refusal must not resolve as a verdict').to.exist;
        expect(err.kind).to.equal('refusal');
        expect(err.transient, 'a reached-model refusal must not re-judge').to.equal(false);
    });
});
describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    for (const stop of ['max_tokens', 'model_context_window_exceeded']) {
        it('fails closed on stop_reason=' + stop + ' (a truncated verdict can still parse)', async function () {
            let jsonOut = JSON.stringify({
                is_error: false, subtype: 'success', result: '{"verdict":"eq',
                stop_reason: stop
            });
            let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
            let err;
            try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
            catch (e) { err = e; }
            expect(err, 'truncated text must not resolve').to.exist;
            expect(err.kind).to.equal('truncation');
            expect(err.transient).to.equal(false);
        });
    }

    it('is a NO-OP on an envelope with no stop_reason key at all', async function () {
        let jsonOut = JSON.stringify({ is_error: false, subtype: 'success', result: 'the verdict' });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let out = await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' });
        expect(out.result, 'absence must behave exactly as before').to.equal('the verdict');
    });

    for (const stop of ['end_turn', 'tool_use', 'stop_sequence', 'tool_deferred']) {
        it('resolves normally on stop_reason=' + stop + ' (reject-known-bad, not allow-known-good)', async function () {
            let jsonOut = JSON.stringify({
                is_error: false, subtype: 'success', result: 'the verdict', stop_reason: stop
            });
            let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
            let out = await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' });
            expect(out.result).to.equal('the verdict');
        });
    }

    it('does NOT walk nested per-turn messages for a stop_reason', async function () {
        // An agent loop can hit max_tokens on an INTERMEDIATE turn and still produce a
        // complete final answer, so only the top-level field may decide.
        let jsonOut = JSON.stringify({
            is_error: false, subtype: 'success', result: 'the complete verdict',
            messages: [{ type: 'assistant', message: { stop_reason: 'max_tokens' } }]
        });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let out = await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' });
        expect(out.result).to.equal('the complete verdict');
    });
});
describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('classifies a timeout as a transport failure (transient=true)', async function () {
        // Never emit close: let the internal timeout fire.
        let { runClaudePrint } = loadClaudeSpawn({ noClose: true });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6', timeoutMs: 20 }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.include('timeout');
        expect(err.transient).to.equal(true);
    });

    it('classifies a spawn error as a transport failure (transient=true)', async function () {
        let { runClaudePrint } = loadClaudeSpawn({ spawnError: 'ENOENT' });
        let err;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.transient).to.equal(true);
    });
});
