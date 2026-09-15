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


// ── only the RESOLVED credential reaches the child ────────────────────────
// resolveHubLlmAuth picks exactly one source and reports it, so the spawn must not
// merge the ambient env underneath it: a shell-exported credential the resolver has
// already REJECTED would ride along and let the CLI, not the resolver, decide which
// account pays. hub-credentials' own note says an ambient CLAUDE_CODE_OAUTH_TOKEN is
// honoured whatever the config dir holds, so that precedence is documented behavior.

function withAmbientCreds(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    Object.assign(process.env, vars);
    try { return fn(); }
    finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else                 process.env[k] = v;
        }
    }
}
describe('claude-spawn runClaudePrint()', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('scrubs ambient credentials so a config-dir source is the only live one', async function () {
        await withAmbientCreds({
            ANTHROPIC_API_KEY:       'sk-ambient',
            ANTHROPIC_AUTH_TOKEN:    'gw-ambient',
            CLAUDE_CODE_OAUTH_TOKEN: 'tok-ambient',
            CLAUDE_CONFIG_DIR:       '/tmp/operator-dir'
        }, async () => {
            let jsonOut = JSON.stringify({ result: 'ok' });
            let { runClaudePrint, spawnStub } = loadClaudeSpawn(
                { exitCode: 0, stdout: jsonOut },
                { ok: true, transport: 'claude_spawn', source: 'hub_config_dir',
                  env: { CLAUDE_CONFIG_DIR: '/tmp/hub-dir' } });
            await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' });
            let env = spawnStub.firstCall.args[2].env;
            expect(env).to.not.have.property('ANTHROPIC_API_KEY');
            expect(env).to.not.have.property('ANTHROPIC_AUTH_TOKEN');
            expect(env).to.not.have.property('CLAUDE_CODE_OAUTH_TOKEN');
            expect(env.CLAUDE_CONFIG_DIR, 'the resolver, not the shell, names the dir')
                .to.equal('/tmp/hub-dir');
        });
    });

    it('scrubs an ambient API key that would outrank the resolved OAuth token', async function () {
        await withAmbientCreds({ ANTHROPIC_API_KEY: 'sk-ambient' }, async () => {
            let jsonOut = JSON.stringify({ result: 'ok' });
            let { runClaudePrint, spawnStub } = loadClaudeSpawn(
                { exitCode: 0, stdout: jsonOut },
                { ok: true, transport: 'claude_spawn', source: 'hub_token',
                  env: { CLAUDE_CODE_OAUTH_TOKEN: 'hub-tok', CLAUDE_CONFIG_DIR: '/tmp/iso' } });
            await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' });
            let env = spawnStub.firstCall.args[2].env;
            expect(env).to.not.have.property('ANTHROPIC_API_KEY');
            expect(env.CLAUDE_CODE_OAUTH_TOKEN).to.equal('hub-tok');
        });
    });

    it('leaves every non-credential var inherited', async function () {
        await withAmbientCreds({ XCHAIN_SPAWN_PROBE: 'kept' }, async () => {
            let jsonOut = JSON.stringify({ result: 'ok' });
            let { runClaudePrint, spawnStub } = loadClaudeSpawn({ exitCode: 0, stdout: jsonOut });
            await runClaudePrint({ prompt: 'hi', model: 'claude-sonnet-4-6' });
            let env = spawnStub.firstCall.args[2].env;
            expect(env.XCHAIN_SPAWN_PROBE).to.equal('kept');
            expect(env.PATH, 'PATH still resolves the binary').to.equal(process.env.PATH);
        });
    });
});

