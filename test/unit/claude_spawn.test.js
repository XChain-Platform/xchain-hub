'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const EventEmitter = require('events');
const os         = require('os');

// ────────────────────────────────────────────────────────────────────────────
// Helpers: mock child_process.spawn and hub-credentials
// ────────────────────────────────────────────────────────────────────────────

function makeFakeChild(opts) {
    // opts: { exitCode, stdout, stderr, spawnError, stdinError }
    let child = new EventEmitter();
    // Real child stdin is a stream (has .on for the async 'error'/EPIPE event);
    // model it as an EventEmitter so the production stdin error handler attaches.
    child.stdin  = new EventEmitter();
    child.stdin.write = opts && opts.stdinError === 'sync'
        ? (d, cb) => { throw new Error('stdin write failed'); }
        : sinon.stub();
    child.stdin.end = sinon.stub();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    // Schedule the lifecycle events
    setImmediate(() => {
        if (opts && opts.spawnError) {
            child.emit('error', new Error(opts.spawnError));
            return;
        }
        if (opts && opts.stdinError === 'async') {
            child.stdin.emit('error', new Error('write EPIPE'));
            return;
        }
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
    let { runClaudePrint, CLAUDE_BIN } = proxyquire('../../src/lib/claude-spawn', {
        'child_process': { spawn: spawnStub },
        './hub-credentials': { resolveHubLlmAuth: () => auth }
    });
    return { runClaudePrint, CLAUDE_BIN, spawnStub };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── Validation guards ────────────────────────────────────────────────────

    it('throws when prompt is missing', async function () {
        let { runClaudePrint } = loadClaudeSpawn();
        let threw = false;
        try { await runClaudePrint({ model: 'claude-sonnet-4-6' }); }
        catch (e) { threw = true; expect(e.message).to.include('prompt (string) required'); }
        expect(threw).to.be.true;
    });

    it('throws when model is missing', async function () {
        let { runClaudePrint } = loadClaudeSpawn();
        let threw = false;
        try { await runClaudePrint({ prompt: 'hello' }); }
        catch (e) { threw = true; expect(e.message).to.include('model (string) required'); }
        expect(threw).to.be.true;
    });

    it('throws when credentials are not ok', async function () {
        let { runClaudePrint } = loadClaudeSpawn({}, { ok: false, reason: 'no_credential', detail: 'no creds found' });
        let threw = false;
        try { await runClaudePrint({ prompt: 'hello', model: 'claude-sonnet-4-6' }); }
        catch (e) { threw = true; expect(e.message).to.include('no creds found'); }
        expect(threw).to.be.true;
    });

    it('throws when transport is not claude_spawn', async function () {
        let { runClaudePrint } = loadClaudeSpawn({}, { ok: true, transport: 'anthropic_api', env: {} });
        let threw = false;
        try { await runClaudePrint({ prompt: 'hello', model: 'claude-sonnet-4-6' }); }
        catch (e) { threw = true; expect(e.message).to.include('transport is anthropic_api'); }
        expect(threw).to.be.true;
    });

    // ── Happy path ────────────────────────────────────────────────────────────

    it('resolves with the result field from parsed JSON stdout', async function () {
        let jsonOut = JSON.stringify({ result: 'The answer is 42.' });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let res = await runClaudePrint({ prompt: 'What is 6*7?', model: 'claude-sonnet-4-6' });
        expect(res.result).to.equal('The answer is 42.');
        expect(res.json).to.deep.equal({ result: 'The answer is 42.' });
    });

    it('includes systemPrompt as --append-system-prompt arg when provided', async function () {
        let jsonOut = JSON.stringify({ result: 'ok' });
        let { runClaudePrint, spawnStub } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6', systemPrompt: 'Be concise.' });
        let args = spawnStub.firstCall.args[1];
        let idx  = args.indexOf('--append-system-prompt');
        expect(idx).to.not.equal(-1);
        expect(args[idx + 1]).to.equal('Be concise.');
    });

    it('includes --max-budget-usd when maxBudgetUsd is a positive number', async function () {
        let jsonOut = JSON.stringify({ result: 'ok' });
        let { runClaudePrint, spawnStub } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6', maxBudgetUsd: 0.5 });
        let args = spawnStub.firstCall.args[1];
        expect(args).to.include('--max-budget-usd');
    });

    it('does NOT include --max-budget-usd when maxBudgetUsd is 0', async function () {
        let jsonOut = JSON.stringify({ result: 'ok' });
        let { runClaudePrint, spawnStub } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6', maxBudgetUsd: 0 });
        let args = spawnStub.firstCall.args[1];
        expect(args).to.not.include('--max-budget-usd');
    });

    // ── Error paths ────────────────────────────────────────────────────────────

    it('rejects when the CLI exits non-zero', async function () {
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 1, stderr: 'auth failed' });
        let threw = false;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { threw = true; expect(e.message).to.include('exit 1'); }
        expect(threw).to.be.true;
    });

    it('rejects when stdout is not valid JSON', async function () {
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: 'NOT JSON' });
        let threw = false;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { threw = true; expect(e.message).to.include('unparseable JSON'); }
        expect(threw).to.be.true;
    });

    it('rejects when parsed JSON has no result field', async function () {
        let jsonOut = JSON.stringify({ error: 'api error' });
        let { runClaudePrint } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
        let threw = false;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { threw = true; expect(e.message).to.include('no result text'); }
        expect(threw).to.be.true;
    });

    it('rejects on spawn error', async function () {
        let { runClaudePrint } = loadClaudeSpawn({ spawnError: 'ENOENT' });
        let threw = false;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { threw = true; expect(e.message).to.include('spawn error'); }
        expect(threw).to.be.true;
    });

    it('rejects (rather than crashing the process) on an async stdin EPIPE', async function () {
        let { runClaudePrint } = loadClaudeSpawn({ stdinError: 'async' });
        let threw = false;
        try { await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' }); }
        catch (e) { threw = true; expect(e.message).to.include('stdin error'); }
        expect(threw).to.be.true;
    });

    // ── CLAUDE_BIN export ────────────────────────────────────────────────────

    it('exports CLAUDE_BIN constant (defaults to "claude")', function () {
        let { CLAUDE_BIN } = loadClaudeSpawn();
        expect(typeof CLAUDE_BIN).to.equal('string');
        // CLAUDE_BIN is either 'claude' or whatever CLAUDE_BIN env var says
        expect(CLAUDE_BIN.length).to.be.greaterThan(0);
    });
});
