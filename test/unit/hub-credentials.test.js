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
 * XChain Hub - hub-credentials.js unit tests
 *
 * Hermetic. Uses the `ctx.env` + `ctx.defaultConfigDir` seams so no real
 * filesystem or process.env access leaks in.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { resolveHubLlmAuth } = require('../../src/lib/hub-credentials');

function _tmpDir(){
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubcred-'));
    return dir;
}
function _populate(dir){ fs.writeFileSync(path.join(dir, '.credentials.json'), '{}'); return dir; }

describe('resolveHubLlmAuth: credential resolution chain', function () {

    let hermeticDefaultDir;
    beforeEach(function () {
        // Empty dir as the "default isolated dir": won't satisfy the
        // pre-populated fallback (rule 6) unless a test populates it.
        hermeticDefaultDir = _tmpDir();
    });

    it('returns ok:false with no_credential_configured when nothing is set', function () {
        const r = resolveHubLlmAuth({ env: {}, defaultConfigDir: hermeticDefaultDir });
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('no_credential_configured');
    });

    it('prefers HUB_CLAUDE_CONFIG_DIR when populated', function () {
        const dir = _populate(_tmpDir());
        const r = resolveHubLlmAuth({
            env: { HUB_CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: 'sk-xxx' },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(true);
        expect(r.transport).to.equal('claude_spawn');
        expect(r.source).to.equal('hub_config_dir');
        expect(r.env.CLAUDE_CONFIG_DIR).to.equal(dir);
    });

    it('skips an empty HUB_CLAUDE_CONFIG_DIR and falls through to CLAUDE_CONFIG_DIR', function () {
        const empty    = _tmpDir();              // empty dir: _checkConfigDir returns false
        const populated = _populate(_tmpDir());
        const r = resolveHubLlmAuth({
            env: { HUB_CLAUDE_CONFIG_DIR: empty, CLAUDE_CONFIG_DIR: populated },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(true);
        expect(r.source).to.equal('cli_config_dir');
        expect(r.env.CLAUDE_CONFIG_DIR).to.equal(populated);
    });

    it('uses HUB_CLAUDE_CODE_OAUTH_TOKEN with isolated dir when no CONFIG_DIR is populated', function () {
        const r = resolveHubLlmAuth({
            env: { HUB_CLAUDE_CODE_OAUTH_TOKEN: 'tok-abc' },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(true);
        expect(r.transport).to.equal('claude_spawn');
        expect(r.source).to.equal('hub_token');
        expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).to.equal('tok-abc');
        // Isolated dir must be set so the CLI doesn't pick up host credentials.
        expect(r.env.CLAUDE_CONFIG_DIR).to.equal(hermeticDefaultDir);
    });

    it('CLAUDE_CODE_OAUTH_TOKEN (unprefixed) is the next fallback after HUB_*', function () {
        const r = resolveHubLlmAuth({
            env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-xyz' },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(true);
        expect(r.source).to.equal('cli_token');
        expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).to.equal('tok-xyz');
    });

    it('ANTHROPIC_API_KEY → anthropic_api transport', function () {
        const r = resolveHubLlmAuth({
            env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(true);
        expect(r.transport).to.equal('anthropic_api');
        expect(r.source).to.equal('api_key');
        expect(r.apiKey).to.equal('sk-ant-test');
    });

    it('CONFIG_DIR wins over API_KEY (deliberate spawn config beats API key)', function () {
        const dir = _populate(_tmpDir());
        const r = resolveHubLlmAuth({
            env: { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: 'sk-xxx' },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.transport).to.equal('claude_spawn');
        expect(r.source).to.equal('cli_config_dir');
    });

    it('OAUTH_TOKEN wins over API_KEY', function () {
        const r = resolveHubLlmAuth({
            env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'sk-xxx' },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.transport).to.equal('claude_spawn');
        expect(r.source).to.equal('cli_token');
    });

    it('default isolated dir is the last resort below API_KEY', function () {
        _populate(hermeticDefaultDir);
        const r = resolveHubLlmAuth({
            env: { ANTHROPIC_API_KEY: 'sk-yyy' },
            defaultConfigDir: hermeticDefaultDir
        });
        // API_KEY (rule 5) outranks default_config_dir (rule 6): deliberate
        // env-var wins over opportunistic default discovery.
        expect(r.transport).to.equal('anthropic_api');
        expect(r.source).to.equal('api_key');
    });

    it('default isolated dir resolves when nothing else is set', function () {
        _populate(hermeticDefaultDir);
        const r = resolveHubLlmAuth({ env: {}, defaultConfigDir: hermeticDefaultDir });
        expect(r.transport).to.equal('claude_spawn');
        expect(r.source).to.equal('default_config_dir');
        expect(r.env.CLAUDE_CONFIG_DIR).to.equal(hermeticDefaultDir);
    });

    it('trims whitespace from env values', function () {
        const dir = _populate(_tmpDir());
        const r = resolveHubLlmAuth({
            env: { HUB_CLAUDE_CONFIG_DIR: '  ' + dir + '  ' },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(true);
        expect(r.env.CLAUDE_CONFIG_DIR).to.equal(dir);
    });

    it('treats a non-directory path as missing', function () {
        const filePath = path.join(_tmpDir(), 'not-a-dir.txt');
        fs.writeFileSync(filePath, 'hi');
        const r = resolveHubLlmAuth({
            env: { HUB_CLAUDE_CONFIG_DIR: filePath },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(false);
    });

    // : the gate accepted mere non-emptiness, so a dir holding only
    // settings/logs/state - or one the operator logged out of - masked the valid
    // downstream candidate. healthCheck then reported ready while paid calls
    // spawned an unauthenticated CLI and mapped to provider_error.
    it('falls through an uncredentialed but NON-EMPTY config dir to the API key', function () {
        const dir = _tmpDir();
        fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
        const r = resolveHubLlmAuth({
            env: { HUB_CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: 'sk-ant-test' },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(true);
        expect(r.transport).to.equal('anthropic_api');
        expect(r.source).to.equal('api_key');
    });

    it('falls through an uncredentialed CLAUDE_CONFIG_DIR to the OAuth token', function () {
        const dir = _tmpDir();
        fs.mkdirSync(path.join(dir, 'logs'));
        const r = resolveHubLlmAuth({
            env: { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: 'tok-xyz' },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(true);
        expect(r.source).to.equal('cli_token');
        expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).to.equal('tok-xyz');
    });

    it('reports no credential when an uncredentialed dir is the only candidate', function () {
        const dir = _tmpDir();
        fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
        const r = resolveHubLlmAuth({
            env: { HUB_CLAUDE_CONFIG_DIR: dir },
            defaultConfigDir: hermeticDefaultDir
        });
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('no_credential_configured');
    });
});
