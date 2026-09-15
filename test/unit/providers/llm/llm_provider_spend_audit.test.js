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
 * XChain Hub - llm attestation provider tests: durable spend audit
 *
 * Every paid dispatch on the claude_spawn transport leaves an intent line
 * on disk before the vendor is dialed and a settle line after, in a
 * fallback sink when the primary is unwritable, and never blocks a round.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const path = require('path');
const os = require('os');

// The spawn transport is stubbed through the require cache exactly as in
// llm_provider_claude_spawn.test.js, which explains the technique.

let emptyDir;
let savedCacheEntry;

const fsSync = require('fs');
let sinkPath, savedSink;

// Inject a fake claude-spawn module into the cache, reload llm.js so its
// destructured binding picks up our stub, then restore after the test.
function reloadWithSpawnStub(spawnResolveValue) {
    const spawnKey = require.resolve('../../../../src/providers/llm/claude_spawn.js');
    savedCacheEntry = require.cache[spawnKey];

    const fakeRunClaudePrint = sinon.stub().resolves(spawnResolveValue);
    // Inject a fake module whose exports.runClaudePrint is our stub
    require.cache[spawnKey] = {
        id: spawnKey, filename: spawnKey, loaded: true,
        exports: { runClaudePrint: fakeRunClaudePrint, CLAUDE_BIN: 'claude' }
    };

    // Now reload llm.js; its `const { runClaudePrint }` will pick up our stub
    delete require.cache[require.resolve('../../../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../../../src/lib/hub_credentials.js')];
    const llm = require('../../../../src/providers/llm.js');
    return { llm, stub: fakeRunClaudePrint };
}

function withSpawnEnv(fn) {
    const saved = {
        HUB_CLAUDE_CODE_OAUTH_TOKEN: process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN,
        CLAUDE_CONFIG_DIR:           process.env.CLAUDE_CONFIG_DIR,
        ANTHROPIC_API_KEY:           process.env.ANTHROPIC_API_KEY,
        HUB_CLAUDE_CONFIG_DIR:       process.env.HUB_CLAUDE_CONFIG_DIR
    };
    process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN = 'test-spawn-token';
    process.env.CLAUDE_CONFIG_DIR = emptyDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HUB_CLAUDE_CONFIG_DIR;
    try {
        return fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else                 process.env[k] = v;
        }
    }
}

function readSink() {
    let raw = '';
    try { raw = fsSync.readFileSync(sinkPath, 'utf8'); } catch { return []; }
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('llm provider, fetch via claude_spawn', function () {

    before(function () {
        const fsSync = require('fs');
        emptyDir = path.join(os.tmpdir(), 'llm-spawn-empty-' + process.pid);
        fsSync.mkdirSync(emptyDir, { recursive: true });
    });

    afterEach(function () {
        sinon.restore();
        // Restore any patched cache entry
        const spawnKey = require.resolve('../../../../src/providers/llm/claude_spawn.js');
        if (savedCacheEntry !== undefined) {
            require.cache[spawnKey] = savedCacheEntry;
            savedCacheEntry = undefined;
        } else {
            delete require.cache[spawnKey];
        }
    });

    // - a crash mid-call must still leave local evidence that a vendor
    // charge was initiated, on the CLI transport most of all: it recorded nothing.
    describe('durable spend audit', function () {

        beforeEach(function () {
            savedSink = process.env.LLM_SPEND_LOG_PATH;
            sinkPath = path.join(os.tmpdir(),
                'llm-spend-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.jsonl');
            process.env.LLM_SPEND_LOG_PATH = sinkPath;
        });

        afterEach(function () {
            if (savedSink === undefined) delete process.env.LLM_SPEND_LOG_PATH;
            else process.env.LLM_SPEND_LOG_PATH = savedSink;
            try { fsSync.unlinkSync(sinkPath); } catch { /* never written */ }
        });

        registerSpendAuditIntentTests();
        registerSpendAuditFallbackTests();
    });
});

function registerSpendAuditIntentTests() {
    it('writes the intent BEFORE the vendor is dialed, and settles it after', async function () {
        let sinkAtDispatch = null;
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
        stub.callsFake(async () => {
            // Observed from inside the call: the durable record already exists.
            sinkAtDispatch = readSink();
            return { result: 'ok', json: {} };
        });

        await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

        expect(sinkAtDispatch, 'the intent must be on disk before the call').to.have.length(1);
        expect(sinkAtDispatch[0].phase).to.equal('intent');
        expect(sinkAtDispatch[0].transport).to.equal('claude_spawn');

        const lines = readSink();
        expect(lines.map(l => l.phase)).to.deep.equal(['intent', 'settle']);
        expect(lines[1].id).to.equal(lines[0].id);
        expect(lines[1].status).to.equal('ok');
    });

    it('settles the CLI cost the branch used to discard', async function () {
        const { llm, stub } = reloadWithSpawnStub({
            result: 'ok',
            json: { total_cost_usd: 0.0123, usage: { input_tokens: 11, output_tokens: 7 } }
        });
        expect(stub.called).to.equal(false);

        await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

        const settle = readSink().find(l => l.phase === 'settle');
        expect(settle.usage.costUsd).to.equal(0.0123);
        expect(settle.usage.tokens).to.deep.equal({ input_tokens: 11, output_tokens: 7 });
        // The same numbers now reach healthCheck's in-memory accounting, which
        // the CLI transport was absent from entirely.
        const health = await withSpawnEnv(() => llm.healthCheck());
        expect(health.tokenUsage.calls).to.equal(1);
        expect(health.tokenUsage.inputTokens).to.equal(11);
    });

    it('leaves an intent with an error settle when the call throws', async function () {
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
        stub.rejects(new Error('cli exploded'));

        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } catch { /* expected */ }

        const lines = readSink();
        expect(lines.map(l => l.phase)).to.deep.equal(['intent', 'settle']);
        expect(lines[1].status).to.equal('error');
        expect(lines[1].error).to.contain('cli exploded');
    });
}

function registerSpendAuditFallbackTests() {
    it('is best-effort: an unwritable sink never blocks the round', async function () {
        process.env.LLM_SPEND_LOG_PATH = '/dev/null/not-a-dir/spend.jsonl';
        const { llm } = reloadWithSpawnStub({ result: 'still served' });

        const out = await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

        expect(out.body.toString('utf8')).to.equal('still served');
    });

    // Best-effort must not mean "silently nothing". Dispatch stays unconditional
    // (refusing to call would turn an audit fault into a wrong on-chain outcome),
    // so an unwritable primary sink has to leave the per-dispatch identity
    // somewhere else. The aggregate spend-state file cannot stand in: it holds a
    // rolling cost window and no call id.
    it('keeps the dispatch identity in a fallback sink when the primary is unwritable', async function () {
        const fallback = path.join(os.tmpdir(),
            'llm-spend-fb-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.jsonl');
        process.env.LLM_SPEND_LOG_PATH = '/dev/null/not-a-dir/spend.jsonl';
        process.env.LLM_SPEND_LOG_FALLBACK_PATH = fallback;
        try {
            const { llm } = reloadWithSpawnStub({ result: 'still served' });
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

            const lines = fsSync.readFileSync(fallback, 'utf8')
                                .split('\n').filter(Boolean).map(l => JSON.parse(l));
            expect(lines.map(l => l.phase)).to.deep.equal(['intent', 'settle']);
            expect(lines[1].id, 'the settle still ties back to its intent').to.equal(lines[0].id);
            expect(lines[0].auditFallbackFrom, 'a fallback line names the sink it could not reach')
                .to.equal('/dev/null/not-a-dir/spend.jsonl');

            const audit = llm.spendStats().audit;
            expect(audit.total, 'the fault is a standing counter, not a scrolled-away warning')
                .to.equal(2);
            expect(audit.toFallback).to.equal(2);
            expect(audit.toStderr, 'the fallback took them, so stderr was not needed').to.equal(0);
        } finally {
            delete process.env.LLM_SPEND_LOG_FALLBACK_PATH;
            try { fsSync.unlinkSync(fallback); } catch { /* never written */ }
        }
    });
}
