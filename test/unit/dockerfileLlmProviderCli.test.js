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

// The llm attestation provider's default transport spawns a CLI BY NAME, and
// resolveHubLlmAuth prefers that transport over an API key whenever
// HUB_CLAUDE_CONFIG_DIR is set. So a hub image without the binary answers every
// llm request with `spawn ... ENOENT` -> status provider_error, and the round
// cannot finalize no matter how far the responsible set widens.
//
// THIS GUARD EXISTS BECAUSE THAT ALREADY HAPPENED AND WAS INVISIBLE.
// The testnet fleet ran on a hand-built image carrying the binary; the v0.16.0
// roll rebuilt the tag from the Dockerfile, which had never installed it, and
// the capability vanished with no failing test anywhere. Every llm request on
// BTC testnet then expired with zero responses. Nothing in the suite noticed,
// because the defect lives in the image recipe rather than in any module.
//
// It asserts the RECIPE, not a running container: unit tests cannot spawn the
// binary, and an assertion that the CLI answers would only pass on a machine
// that happens to have it, which is the very confusion that hid this for twelve
// days. The pin is asserted too, for the reason the base tag is pinned.

const { expect } = require('chai');
const fs         = require('fs');
const path       = require('path');

const DOCKERFILE  = path.join(__dirname, '..', '..', 'Dockerfile');
const CLI_PACKAGE = '@anthropic-ai/claude-code';

// The name claude-spawn.js falls back to when CLAUDE_BIN is unset. Read from the
// module rather than restated, so a rename there fails this guard instead of
// leaving it asserting a string the code no longer uses.
const { CLAUDE_BIN } = require('../../src/lib/claude-spawn.js');

describe('Dockerfile: the llm provider CLI is in the image', () => {
    let dockerfile;

    before(() => {
        expect(fs.existsSync(DOCKERFILE), DOCKERFILE + ' does not exist').to.equal(true);
        dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
    });

    // Coverage floor: if the file stops looking like the hub's Dockerfile at all,
    // every assertion below could pass vacuously against an empty read.
    it('reads a Dockerfile that still builds the hub', () => {
        expect(dockerfile).to.match(/^FROM node:22-bookworm$/m);
        expect(dockerfile).to.include('/XChainHub/src');
    });

    it('installs the provider CLI package globally', () => {
        const line = dockerfile
            .split('\n')
            .find((l) => l.startsWith('RUN') && l.includes(CLI_PACKAGE));
        expect(line, 'no RUN line installs ' + CLI_PACKAGE + '; an llm attestation ' +
            'cannot be served without it').to.be.a('string');
        expect(line, 'the CLI must be installed globally so it lands on PATH as ' +
            CLAUDE_BIN).to.match(/npm install -g|npm i -g/);
    });

    it('pins the CLI to an exact version', () => {
        const m = dockerfile.match(
            new RegExp(CLI_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '@([^\\s\\\\]+)'));
        expect(m, 'the CLI install carries no @version pin; a floating install moves ' +
            'the provider transport with no signal').to.not.equal(null);
        expect(m[1], 'the pin must be an exact version, not a range or a tag')
            .to.match(/^\d+\.\d+\.\d+$/);
    });

    // The default binary name is what makes the global install sufficient. If
    // CLAUDE_BIN's default ever becomes an absolute path, the install line has to
    // put it there instead, and this guard should fail rather than quietly pass.
    it('the spawn transport still resolves the binary by bare name', () => {
        expect(CLAUDE_BIN).to.not.include('/');
    });
});
