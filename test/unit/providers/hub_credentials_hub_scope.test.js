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
 * XChain Hub - hub-credentials.js: hub-scoped credentials outrank ambient ones
 *
 * Hermetic. Uses the `ctx.env` + `ctx.defaultConfigDir` seams so no real
 * filesystem or process.env access leaks in.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveHubLlmAuth } = require('../../../src/lib/hub_credentials');

function _tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hubcred-scope-'));
}
// A config dir holding the shape the CLI writes after `claude login`, placeholder tokens.
function _populate(dir) {
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'placeholder-access', refreshToken: 'placeholder-refresh', expiresAt: 1 }
  }));
  return dir;
}

let defaultDir;
// Resolve against a fresh, empty default dir so the last-resort fallback never fires.
function _resolveHermetic(env) {
  return resolveHubLlmAuth({ env, defaultConfigDir: defaultDir });
}

describe('resolveHubLlmAuth: hub-scoped credentials outrank ambient ones', function () {
  beforeEach(function () {
    defaultDir = _tmpDir();
  });
  registerHubApiKeyRanking();
  registerHubScopeRanking();
});

// Every HUB_-scoped credential outranks every ambient one.
function registerHubApiKeyRanking() {
  it('HUB_ANTHROPIC_API_KEY alone resolves to the direct API', function () {
    const r = _resolveHermetic({ HUB_ANTHROPIC_API_KEY: 'sk-hub' });
    expect(r.transport).to.equal('anthropic_api');
    expect(r.source).to.equal('hub_api_key');
    expect(r.apiKey).to.equal('sk-hub');
  });
  it('HUB_ANTHROPIC_API_KEY beats ANTHROPIC_API_KEY', function () {
    const r = _resolveHermetic({ HUB_ANTHROPIC_API_KEY: 'sk-hub', ANTHROPIC_API_KEY: 'sk-ambient' });
    expect(r.source).to.equal('hub_api_key');
    expect(r.apiKey).to.equal('sk-hub');
  });
  it('HUB_ANTHROPIC_API_KEY beats a populated ambient CLAUDE_CONFIG_DIR', function () {
    const r = _resolveHermetic({ HUB_ANTHROPIC_API_KEY: 'sk-hub', CLAUDE_CONFIG_DIR: _populate(_tmpDir()) });
    expect(r.transport).to.equal('anthropic_api');
    expect(r.source).to.equal('hub_api_key');
  });
  it('HUB_ANTHROPIC_API_KEY beats an ambient CLAUDE_CODE_OAUTH_TOKEN', function () {
    const r = _resolveHermetic({ HUB_ANTHROPIC_API_KEY: 'sk-hub', CLAUDE_CODE_OAUTH_TOKEN: 'tok-ambient' });
    expect(r.transport).to.equal('anthropic_api');
    expect(r.source).to.equal('hub_api_key');
  });
  it('an uncredentialed HUB_CLAUDE_CONFIG_DIR falls to the hub API key before an ambient dir', function () {
    const r = _resolveHermetic({
      HUB_CLAUDE_CONFIG_DIR: _tmpDir(),
      HUB_ANTHROPIC_API_KEY: 'sk-hub',
      CLAUDE_CONFIG_DIR: _populate(_tmpDir())
    });
    expect(r.source).to.equal('hub_api_key');
  });
}

// The ranking inside the hub scope, and the hub token's own dir.
function registerHubScopeRanking() {
  it('a populated HUB_CLAUDE_CONFIG_DIR still beats HUB_ANTHROPIC_API_KEY', function () {
    const dir = _populate(_tmpDir());
    const r = _resolveHermetic({ HUB_CLAUDE_CONFIG_DIR: dir, HUB_ANTHROPIC_API_KEY: 'sk-hub' });
    expect(r.source).to.equal('hub_config_dir');
    expect(r.env.CLAUDE_CONFIG_DIR).to.equal(dir);
  });
  it('HUB_CLAUDE_CODE_OAUTH_TOKEN beats HUB_ANTHROPIC_API_KEY', function () {
    const r = _resolveHermetic({ HUB_CLAUDE_CODE_OAUTH_TOKEN: 'tok-hub', HUB_ANTHROPIC_API_KEY: 'sk-hub' });
    expect(r.source).to.equal('hub_token');
  });
  it('HUB_CLAUDE_CODE_OAUTH_TOKEN beats a populated ambient CLAUDE_CONFIG_DIR and keeps off it', function () {
    const ambient = _populate(_tmpDir());
    const r = _resolveHermetic({ HUB_CLAUDE_CODE_OAUTH_TOKEN: 'tok-hub', CLAUDE_CONFIG_DIR: ambient });
    expect(r.source).to.equal('hub_token');
    expect(r.env.CLAUDE_CONFIG_DIR).to.equal(defaultDir);
    expect(r.env.CLAUDE_CONFIG_DIR).to.not.equal(ambient);
  });
  it('the ambient OAuth token still pairs with the ambient dir when nothing hub-scoped is set', function () {
    const ambient = _tmpDir();
    const r = _resolveHermetic({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-ambient', CLAUDE_CONFIG_DIR: ambient });
    expect(r.source).to.equal('cli_token');
    expect(r.env.CLAUDE_CONFIG_DIR).to.equal(ambient);
  });
}
