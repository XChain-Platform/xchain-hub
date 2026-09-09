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

// ci.yml decides which branch the declared siblings ride, and it decides it at
// TWO call sites: the shared workflow call and the coverage job's own
// checkout-siblings step. The coverage job re-runs the unit suite, so the two
// expressions disagreeing means the ratchet measures a different suite from the
// gate, with cross-repo guards that fail or skip for a reason the gate does not
// have. That second call site is the one every previous conversion of this
// expression missed, and nothing asserted the pair.
//
// The default the shared workflow applies to any pull request is `develop`. A
// hotfix branch cut from a master tag has no sibling branch of its own, so that
// default compares master-lineage code against siblings carrying develop-only
// work; measured on the v0.16.2 cut, the chain-registry guard read the wallet's
// develop snapshot against this tree's master one and reddened a commit that
// touches neither. The pre-push venue gate ships master siblings for such a
// branch (ci-dispatch.sh: pushed branch, then master, then main), so the base
// ref is also what makes the two venues agree rather than disagree by default.

const { expect } = require('chai');
const fs         = require('fs');
const path       = require('path');

const CI_YML = path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');

// Every `${{ ... }}` on a line whose key selects which branch a companion repo is
// read at: the shared workflow call, the coverage job's checkout-siblings step,
// and the two in drift-guards (the canonical wallet checkout and the observability
// consumers). Matched by KEY rather than by line number or count, so a fifth call
// site added later joins this guard instead of slipping past it.
function companionRefExpressions(yaml) {
    return yaml
        .split('\n')
        .map(l => l.match(/^\s*(?:siblings-ref|ref|SIBLINGS_REF):\s*(\$\{\{.*\}\})\s*$/))
        .filter(Boolean)
        .map(m => m[1]);
}

describe('ci.yml: the companion-ref expressions', () => {
    let yaml, expressions, siblingExpressions;

    before(() => {
        expect(fs.existsSync(CI_YML), CI_YML + ' does not exist').to.equal(true);
        yaml        = fs.readFileSync(CI_YML, 'utf8');
        expressions = companionRefExpressions(yaml);
        // The two that feed the .ci-siblings roster, as opposed to the two
        // drift-guard checkouts, which name their own repositories.
        siblingExpressions = expressions.filter(e => e.includes("'release/'"));
    });

    // Coverage floor: without this, a file that stopped carrying these call sites
    // would pass every assertion below against an empty list.
    it('carries every call site that reads a companion repo', () => {
        expect(yaml).to.include('ci-reusable.yml@');
        expect(yaml).to.include('actions/checkout-siblings@');
        expect(yaml).to.include('XChain-Platform/xchain-wallet');
        expect(expressions.length).to.be.at.least(4);
    });

    it('uses one identical expression at both sibling call sites', () => {
        expect(siblingExpressions.length).to.equal(2);
        expect(siblingExpressions[0]).to.equal(siblingExpressions[1]);
    });

    it('sends a release PR to its own release branch', () => {
        for (const e of siblingExpressions) {
            expect(e).to.include("startsWith(github.head_ref, 'release/')");
            expect(e).to.include('github.head_ref');
        }
    });

    // The arm this guard was written for, asserted on EVERY call site: a hotfix
    // rides its base branch, never the develop default and never a
    // `hotfix/vX.Y.Z` that no companion repo publishes.
    it('sends a hotfix PR to the branch it is merging into, everywhere', () => {
        for (const e of expressions) {
            expect(e, e).to.include("startsWith(github.head_ref, 'hotfix/')");
            expect(e, e).to.include('github.base_ref');
        }
    });

    // Anything else keeps each call site's own prior default, which is what makes
    // an ordinary develop PR behave exactly as it did before the arm existed.
    it('falls through to its prior default on every other branch', () => {
        for (const e of siblingExpressions) expect(e).to.match(/\|\|\s*''\s*\}\}$/);
        for (const e of expressions.filter(x => !x.includes("'release/'")))
            expect(e).to.match(/\|\|\s*'develop'\s*\}\}$/);
    });
});
