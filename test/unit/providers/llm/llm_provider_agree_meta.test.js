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
 * XChain Hub - llm attestation provider tests: agree() meta canonicalization
 *
 * The two fail-closed gates on the model identifier a winning proposal
 * carries on-chain: the exact allowlist (live or block-anchored) and
 * corroboration by a second proposal.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

// Reload the module under each scenario so its env-dependent require-time
// state is fresh. cache-bust the dependency chain too.
function _reloadProvider(){
    delete require.cache[require.resolve('../../../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../../../src/lib/hub_credentials.js')];
    delete require.cache[require.resolve('../../../../src/providers/llm/claude_spawn.js')];
    return require('../../../../src/providers/llm.js');
}

const APPROVED = 'claude-sonnet-4-6';
const body = (s) => Buffer.from(s, 'utf8');

/*********************************************************************
 * agree() must not canonicalize an unvouched `meta`.
 *
 * `meta` (the model that served a response) is consensus-visible: the canonical
 * signature binds it and the ATTEST v1 wire records it on-chain. But proposals
 * come from other validators and the judge only ever evaluates their BODIES, so
 * whichever proposal won had its meta copied straight through. A Byzantine
 * validator could put arbitrary bytes on-chain without ever winning on content.
 *
 * Two fail-closed gates, mirroring the truncated_pick precedent in the same
 * function: an exact allowlist against the block-anchored approved identifiers,
 * and corroboration across proposals.
 ********************************************************************/
describe('llm provider, agree() meta canonicalization', function () {

    registerMetaAllowlistTests();

    // The corroboration half is exercised through the internal helper, because
    // reaching the judge-winner return requires a live judge transport. The gate is
    // the same function used on that path.
    describe('corroboration across proposals', function () {

        registerCorroborationTests();
        registerCorroborationAllowlistTests();
    });

    // fetch() honours the block-anchored pinned model, so the gate that
    // judges the meta it returns has to read the same block-anchored list. Reading
    // the live one made a governance delisting permanent: every retry re-pinned the
    // removed model, every meta came back unrecognized, and the request expired at
    // no_quorum despite successful provider responses.
    describe('block-anchored allowlist (options.pinnedApprovedModels)', function () {

        registerPinnedAllowlistTests();
        registerPinnedAllowlistControlTests();
    });
});

function registerMetaAllowlistTests() {
    it('passes an approved, corroborated meta through unchanged (single proposal)', async function () {
        const llm = _reloadProvider();
        const r = await llm.agree([{ body: body('solo'), meta: APPROVED }]);
        expect(r).to.not.be.null;
        expect(r.meta).to.equal(APPROVED);
    });

    it('rejects an unapproved meta on the single-proposal path', async function () {
        const llm = _reloadProvider();
        const outcome = {};
        // Nothing to corroborate against, but the allowlist still applies: an
        // unrecognized identifier must never reach the canonical signature.
        const r = await llm.agree([{ body: body('solo'), meta: 'evil-model-9000' }], { outcome });
        expect(r).to.be.null;
        expect(outcome.inconclusive).to.equal(true);
        expect(outcome.reason).to.equal('meta_unrecognized');
    });

    it('rejects a non-string or empty meta rather than coercing it', async function () {
        for (const bad of [undefined, null, '', 42, { model: APPROVED }, Buffer.from(APPROVED)]) {
            const llm = _reloadProvider();
            const outcome = {};
            const r = await llm.agree([{ body: body('solo'), meta: bad }], { outcome });
            expect(r, 'meta=' + String(bad)).to.be.null;
            expect(outcome.reason).to.equal('meta_unrecognized');
        }
    });

    it('does not accept a near-miss of an approved identifier', async function () {
        // Exact membership only: no prefix, suffix or case-insensitive matching, any
        // of which would let a crafted value ride in alongside a legitimate one.
        for (const near of [APPROVED + '-evil', 'x' + APPROVED, APPROVED.toUpperCase(), ' ' + APPROVED]) {
            const llm = _reloadProvider();
            const outcome = {};
            const r = await llm.agree([{ body: body('solo'), meta: near }], { outcome });
            expect(r, near).to.be.null;
            expect(outcome.reason).to.equal('meta_unrecognized');
        }
    });

    it('honours a governance-updated approved_models list', async function () {
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { approved_models: ['some-new-approved-model', 'claude-opus-4-7'] } });
        const r = await llm.agree([{ body: body('solo'), meta: 'some-new-approved-model' }]);
        expect(r).to.not.be.null;
        expect(r.meta).to.equal('some-new-approved-model');
        // ...and the earlier default stops being approved once governance replaces it.
        const outcome = {};
        expect(await llm.agree([{ body: body('solo'), meta: APPROVED }], { outcome })).to.be.null;
        expect(outcome.reason).to.equal('meta_unrecognized');
    });
}

function registerCorroborationTests() {
    it('requires a second proposal reporting the identical meta', async function () {
        const llm = _reloadProvider();
        // Two proposals, only one claiming the approved model: uncorroborated.
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: APPROVED },
            { body: body('B'), meta: 'claude-opus-4-7' }
        ], 0, outcome);
        expect(r).to.be.null;
        expect(outcome.reason).to.equal('meta_uncorroborated');
    });

    it('accepts when a second proposal corroborates', async function () {
        const llm = _reloadProvider();
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: APPROVED },
            { body: body('B'), meta: APPROVED }
        ], 0, outcome);
        expect(r).to.equal(APPROVED);
        expect(outcome.inconclusive).to.be.undefined;
    });

    it('fails closed on honest divergence too, rather than recording an unsupported claim', async function () {
        // A validator that legitimately fell back to another model and whose body
        // the judge then picked lands here as well. Inconclusive is the correct
        // outcome: the federation cannot corroborate which model served it.
        const llm = _reloadProvider();
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: 'claude-opus-4-7' },
            { body: body('B'), meta: APPROVED },
            { body: body('C'), meta: APPROVED }
        ], 0, outcome);
        expect(r).to.be.null;
        expect(outcome.reason).to.equal('meta_uncorroborated');
    });
}

function registerCorroborationAllowlistTests() {
    it('does not admit a judge-fallback identifier, which no fetch can produce', async function () {
        // The judge chain picks who EVALUATES bodies; a proposal's meta is always
        // the fetch model. A corroborated pair naming a judge fallback is therefore
        // two validators vouching for a model that served nothing.
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: {
            approved_models:       [APPROVED],
            judge_fallback_models: ['gpt-5-mini']
        } });
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: 'gpt-5-mini' },
            { body: body('B'), meta: 'gpt-5-mini' }
        ], 0, outcome);
        expect(r).to.be.null;
        expect(outcome.reason).to.equal('meta_unrecognized');
    });

    it('an unapproved meta is rejected before corroboration is even considered', async function () {
        // Even a fully corroborated value must be an approved identifier: a
        // colluding pair must not be able to vote an arbitrary string onto the chain.
        const llm = _reloadProvider();
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: 'evil-model-9000' },
            { body: body('B'), meta: 'evil-model-9000' }
        ], 0, outcome);
        expect(r).to.be.null;
        expect(outcome.reason).to.equal('meta_unrecognized');
    });
}

function registerPinnedAllowlistTests() {
    it('accepts a meta pinned at the request block after governance delists the model', async function () {
        const llm = _reloadProvider();
        // Governance hot reload removes 'retired-model-1' from the live set.
        llm._setConfig({ additional_config: { approved_models: ['claude-opus-4-7'] } });
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: 'retired-model-1' },
            { body: body('B'), meta: 'retired-model-1' }
        ], 0, outcome, ['retired-model-1', 'claude-opus-4-7']);
        expect(r).to.equal('retired-model-1');
        expect(outcome.inconclusive).to.be.undefined;
    });

    it('still rejects that same meta when no block-anchored list is threaded', async function () {
        // The regression this fix removes, kept as the control: without the pinned
        // list the live set decides and the round is frozen at no_quorum.
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { approved_models: ['claude-opus-4-7'] } });
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: 'retired-model-1' },
            { body: body('B'), meta: 'retired-model-1' }
        ], 0, outcome);
        expect(r).to.be.null;
        expect(outcome.reason).to.equal('meta_unrecognized');
    });

    it('does not widen the allowlist: a meta in neither list is still refused', async function () {
        // The pinned list REPLACES the live one, it does not union with arbitrary
        // values. This control has to survive the liveness fix intact.
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { approved_models: ['claude-opus-4-7'] } });
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: 'evil-model-9000' },
            { body: body('B'), meta: 'evil-model-9000' }
        ], 0, outcome, ['retired-model-1', 'claude-opus-4-7']);
        expect(r).to.be.null;
        expect(outcome.reason).to.equal('meta_unrecognized');
    });
}

function registerPinnedAllowlistControlTests() {
    it('keeps corroboration in force under a block-anchored list', async function () {
        const llm = _reloadProvider();
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: 'retired-model-1' },
            { body: body('B'), meta: 'claude-opus-4-7' }
        ], 0, outcome, ['retired-model-1', 'claude-opus-4-7']);
        expect(r).to.be.null;
        expect(outcome.reason).to.equal('meta_uncorroborated');
    });

    it('falls back to the live set when the pinned list is empty or absent', async function () {
        const llm = _reloadProvider();
        const outcome = {};
        const r = llm._canonicalMetaForTest([
            { body: body('A'), meta: APPROVED },
            { body: body('B'), meta: APPROVED }
        ], 0, outcome, []);
        expect(r).to.equal(APPROVED);
    });
}
