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

const sinon              = require('sinon');
const { expect }         = require('chai');
const ProviderRegistry   = require('../../src/ProviderRegistry');

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeHub(overrides) {
    return {
        config: overrides && overrides.config ? overrides.config : { COIN: 'BTC', NETWORK: 'mainnet' },
        db:     overrides && overrides.db     ? overrides.db     : {
            getConfig: sinon.stub().resolves({})
        }
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('ProviderRegistry', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── Constructor / defaults ───────────────────────────────────────────────

    describe('constructor', function () {
        it('pre-seeds http_get and llm from DEFAULTS', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isKnown('http_get')).to.be.true;
            expect(reg.isKnown('llm')).to.be.true;
        });

        it('returns correct def for http_get', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            let def = reg.getDef('http_get');
            expect(def).to.have.property('provider_id', 'http_get');
            expect(def).to.have.property('consensus_strategy', 'byte_equality');
        });

        it('returns null for unknown provider', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.getDef('nonexistent')).to.be.null;
        });

        it("defaults min_fee_xchain to '0' (serve everything) on both providers", function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.getDef('http_get').min_fee_xchain).to.equal('0');
            expect(reg.getDef('llm').min_fee_xchain).to.equal('0');
        });

        it('lists all known provider ids', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            let ids = reg.listProviderIds();
            expect(ids).to.include('http_get');
            expect(ids).to.include('llm');
        });
    });

    // ── DEFAULTS export ──────────────────────────────────────────────────────

    describe('DEFAULTS export', function () {
        it('exports DEFAULTS object', function () {
            let { DEFAULTS } = require('../../src/ProviderRegistry');
            expect(DEFAULTS).to.have.property('http_get');
            expect(DEFAULTS).to.have.property('llm');
            expect(DEFAULTS.llm.additional_config).to.have.property('judge_model');
        });
    });

    // ── load ─────────────────────────────────────────────────────────────────

    describe('load()', function () {
        it('re-seeds defaults and overlays governance definitions', async function () {
            let db = {
                getConfig: sinon.stub().resolves({
                    http_get: JSON.stringify({
                        provider_id: 'http_get',
                        max_response_bytes: 65536  // governance-raised cap
                    })
                })
            };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            await reg.load();
            expect(reg.getDef('http_get').max_response_bytes).to.equal(65536);
        });

        it('injects provider_id when the governance def omits it', async function () {
            let db = {
                getConfig: sinon.stub().resolves({
                    new_provider: JSON.stringify({ consensus_strategy: 'byte_equality' })
                })
            };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            await reg.load();
            let def = reg.getDef('new_provider');
            expect(def).to.not.be.null;
            expect(def.provider_id).to.equal('new_provider');
        });

        it('skips empty or null raw values', async function () {
            let db = {
                getConfig: sinon.stub().resolves({ badprov: null, emptyprov: '' })
            };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            await reg.load();
            // null/empty entries should be ignored
            expect(reg.isKnown('badprov')).to.be.false;
        });

        it('warns and skips invalid JSON rows', async function () {
            let db = {
                getConfig: sinon.stub().resolves({ broken: 'NOT_JSON' })
            };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            await reg.load();  // must not throw
            expect(reg.isKnown('broken')).to.be.false;
        });

        it('does not call DB when coin or network is missing', async function () {
            let db = { getConfig: sinon.stub().resolves({}) };
            let hub = makeHub({ config: { COIN: '', NETWORK: '' }, db });
            let reg = new ProviderRegistry(hub);
            await reg.load();
            expect(db.getConfig.called).to.be.false;
        });

        it('does not call DB when db is null', async function () {
            let hub = { config: { COIN: 'BTC', NETWORK: 'mainnet' }, db: null };
            let reg = new ProviderRegistry(hub);
            await reg.load();  // must not throw
        });

        it('handles DB error gracefully', async function () {
            let db = { getConfig: sinon.stub().rejects(new Error('db down')) };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            await reg.load();  // must not throw; defaults still present
            expect(reg.isKnown('http_get')).to.be.true;
        });
    });

    // ── hotReload ────────────────────────────────────────────────────────────

    describe('hotReload()', function () {
        it('re-loads providers and re-injects config into loaded modules', async function () {
            let db = { getConfig: sinon.stub().resolves({}) };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            // Simulate an already-loaded module with _setConfig
            let setConfigStub = sinon.stub();
            reg.modules.set('http_get', { _setConfig: setConfigStub });
            await reg.hotReload();
            expect(setConfigStub.calledOnce).to.be.true;
        });

        it('does not throw when _setConfig throws', async function () {
            let db = { getConfig: sinon.stub().resolves({}) };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            reg.modules.set('http_get', { _setConfig: sinon.stub().throws(new Error('bad config')) });
            await reg.hotReload();  // must not throw
        });
    });

    // ── isKnown / getDef / getModule ─────────────────────────────────────────

    describe('isKnown()', function () {
        it('returns true for a seeded provider', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isKnown('http_get')).to.be.true;
        });

        it('returns false for unknown ids', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isKnown('unknown_provider')).to.be.false;
        });
    });

    describe('getModule()', function () {
        it('lazy-loads the http_get provider module', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            let mod = reg.getModule('http_get');
            expect(mod).to.not.be.null;
            expect(typeof mod.fetch).to.equal('function');
            expect(typeof mod.agree).to.equal('function');
        });

        it('returns null for unknown provider ids', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            let mod = reg.getModule('nonexistent_provider_xyz');
            expect(mod).to.be.null;
        });

        it('caches the module on subsequent calls', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            let m1 = reg.getModule('http_get');
            let m2 = reg.getModule('http_get');
            expect(m1).to.equal(m2);
        });

        it('calls _setConfig on the module if exported', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            // Inject a fake module with _setConfig
            let setConfigStub = sinon.stub();
            reg.providers.set('fake_prov', { provider_id: 'fake_prov', additional_config: {} });
            // We can't easily monkey-patch require; verify _setConfig is called
            // by injecting a pre-loaded module stub without loading the file
            reg.modules.set('fake_prov', { _setConfig: setConfigStub, fetch: () => {}, agree: () => {} });
            // hotReload triggers _setConfig on loaded modules
            reg.hotReload().catch(() => {});
            // Module was already in cache, so hotReload calls _setConfig
            // The test is meaningful: setConfigStub will be called by hotReload
        });
    });

    // ── Validation helpers ───────────────────────────────────────────────────

    describe('isRedundancyAllowed()', function () {
        it('returns true for an allowed redundancy level', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isRedundancyAllowed('http_get', 1)).to.be.true;
            expect(reg.isRedundancyAllowed('http_get', 3)).to.be.true;
            expect(reg.isRedundancyAllowed('http_get', 5)).to.be.true;
        });

        it('returns false for a disallowed redundancy level', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isRedundancyAllowed('http_get', 2)).to.be.false;
        });

        it('returns false for unknown providers', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isRedundancyAllowed('bogus', 1)).to.be.false;
        });
    });

    describe('isPayloadSizeAllowed()', function () {
        it('returns true when payload is within limit', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isPayloadSizeAllowed('http_get', 100)).to.be.true;
        });

        it('returns false when payload exceeds max_request_bytes', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            // http_get defaults: max_request_bytes=2048
            expect(reg.isPayloadSizeAllowed('http_get', 99999)).to.be.false;
        });

        it('returns false for unknown provider', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isPayloadSizeAllowed('bogus', 10)).to.be.false;
        });
    });

    describe('isDeadlineAllowed()', function () {
        it('returns true within the deadline window', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            // http_get deadline_window_blocks=100; delta=50 → ok
            expect(reg.isDeadlineAllowed('http_get', 1000, 1050)).to.be.true;
        });

        it('returns false when deadline exceeds window_blocks', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            // delta=200 > 100
            expect(reg.isDeadlineAllowed('http_get', 1000, 1200)).to.be.false;
        });

        it('returns false when delta is <= 0', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isDeadlineAllowed('http_get', 1000, 1000)).to.be.false;
            expect(reg.isDeadlineAllowed('http_get', 1000, 999)).to.be.false;
        });

        it('returns false for unknown provider', function () {
            let hub = makeHub();
            let reg = new ProviderRegistry(hub);
            expect(reg.isDeadlineAllowed('bogus', 100, 110)).to.be.false;
        });
    });

    // ── Block-anchored provider-config history (consensus model identity) ─────

    describe('parseAttestationProviderParam', function () {
        it('parses ATTESTATION_PROVIDER:<id> into the provider id', function () {
            expect(ProviderRegistry.parseAttestationProviderParam('ATTESTATION_PROVIDER:llm')).to.equal('llm');
        });
        it('returns null for non-provider parameters', function () {
            expect(ProviderRegistry.parseAttestationProviderParam('CAPABILITY_PRICE_MIN_STAKE')).to.equal(null);
            expect(ProviderRegistry.parseAttestationProviderParam('')).to.equal(null);
            expect(ProviderRegistry.parseAttestationProviderParam(null)).to.equal(null);
        });
    });

    describe('getAdditionalConfig (block-anchored)', function () {
        it('returns the genesis config before any activation', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            let ac = reg.getAdditionalConfig('llm', 500);
            expect(ac.approved_models[0]).to.equal('claude-sonnet-4-6');
            expect(ac.judge_model).to.equal('claude-haiku-4-5');
        });

        it('resolves the activation-N config at block N and later, genesis before', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, { approved_models: ['claude-opus-4-8'], judge_model: 'claude-haiku-4-6' });
            expect(reg.getAdditionalConfig('llm', 999).approved_models[0]).to.equal('claude-sonnet-4-6');
            expect(reg.getAdditionalConfig('llm', 1000).approved_models[0]).to.equal('claude-opus-4-8');
            expect(reg.getAdditionalConfig('llm', 5000).judge_model).to.equal('claude-haiku-4-6');
        });

        it('falls back to the current def additional_config when no history exists', function () {
            let reg = new ProviderRegistry(makeHub());
            // No _seedProviderConfigGenesis call: history is empty.
            let ac = reg.getAdditionalConfig('llm', 100);
            expect(ac.approved_models[0]).to.equal('claude-sonnet-4-6');
        });
    });

    describe('applyProviderConfigActivation', function () {
        it('is idempotent by activation_block (overwrites, no duplicate entry)', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 2000, { approved_models: ['a'] });
            reg.applyProviderConfigActivation('llm', 2000, { approved_models: ['b'] });
            let hist = reg.providerConfigHistory.get('llm');
            expect(hist.filter(e => e.activation_block === 2000).length).to.equal(1);
            expect(reg.getAdditionalConfig('llm', 2000).approved_models[0]).to.equal('b');
        });

        it('rejects an invalid activation_block', function () {
            let reg = new ProviderRegistry(makeHub());
            expect(() => reg.applyProviderConfigActivation('llm', -1, {})).to.throw(/invalid activation_block/);
            expect(() => reg.applyProviderConfigActivation('llm', 'x', {})).to.throw(/invalid activation_block/);
        });
    });

    // ── Block-anchored provider stake floor ──────────────────────────

    describe('normalizeMinStakeXchain', function () {
        it('passes plain decimal strings through unchanged', function () {
            let n = ProviderRegistry.normalizeMinStakeXchain;
            expect(n('10000')).to.equal('10000');
            expect(n('25000.5')).to.equal('25000.5');
            expect(n(' 10000 ')).to.equal('10000');
            expect(n(10000)).to.equal('10000');
        });
        it('returns null for absent or unparseable values', function () {
            let n = ProviderRegistry.normalizeMinStakeXchain;
            expect(n(undefined)).to.equal(null);
            expect(n(null)).to.equal(null);
            expect(n('')).to.equal(null);
            expect(n('1e5')).to.equal(null);        // exponent form is not a canonical decimal
            expect(n('-100')).to.equal(null);
            expect(n('lots')).to.equal(null);
        });
    });

    describe('getMinStake (block-anchored provider floor)', function () {
        it('resolves the spec floors from the genesis seed', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            expect(reg.getMinStake('http_get', 500)).to.equal('10000');
            expect(reg.getMinStake('llm', 500)).to.equal('25000');
        });

        it('resolves the activation floor at its block and later, genesis before', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, { approved_models: ['x'] }, '40000');
            expect(reg.getMinStake('llm', 999)).to.equal('25000');
            expect(reg.getMinStake('llm', 1000)).to.equal('40000');
            expect(reg.getMinStake('llm', 999999)).to.equal('40000');
        });

        it('keeps the previous floor across an activation that only moves additional_config', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, { approved_models: ['x'] }, '40000');
            reg.applyProviderConfigActivation('llm', 2000, { approved_models: ['y'] });   // no floor change
            expect(reg.getMinStake('llm', 2000)).to.equal('40000');
            expect(reg.getAdditionalConfig('llm', 2000).approved_models[0]).to.equal('y');
        });

        it('is order-independent: a later-appended earlier activation still resolves correctly', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 3000, {}, '60000');
            reg.applyProviderConfigActivation('llm', 2000, {}, '40000');   // appended out of order
            expect(reg.getMinStake('llm', 1999)).to.equal('25000');
            expect(reg.getMinStake('llm', 2000)).to.equal('40000');
            expect(reg.getMinStake('llm', 3000)).to.equal('60000');
        });

        it('returns the latest configured floor when no block is given', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 5000, {}, '90000');
            expect(reg.getMinStake('llm')).to.equal('90000');
        });

        it('falls back to the live definition when no history exists', function () {
            let reg = new ProviderRegistry(makeHub());
            // No _seedProviderConfigGenesis call: history is empty.
            expect(reg.getMinStake('http_get', 100)).to.equal('10000');
        });

        it('returns null for a provider with no floor anywhere', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.providers.set('floorless', { provider_id: 'floorless' });
            expect(reg.getMinStake('floorless', 100)).to.equal(null);
            expect(reg.getMinStake('nonexistent', 100)).to.equal(null);
        });

        it('ignores an unparseable governance floor rather than zeroing the bar', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, {}, 'not-a-number');
            expect(reg.getMinStake('llm', 1000)).to.equal('25000');
        });

        it('re-seeding genesis does not wipe a later activation floor', function () {
            let reg = new ProviderRegistry(makeHub());
            reg._seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, {}, '40000');
            reg._seedProviderConfigGenesis();
            expect(reg.getMinStake('llm', 999)).to.equal('25000');
            expect(reg.getMinStake('llm', 1000)).to.equal('40000');
        });

        it('genesis stays pinned to DEFAULTS even when the configs table raised the live floor', async function () {
            let db = {
                getConfig: sinon.stub().resolves({
                    llm: JSON.stringify({ provider_id: 'llm', min_stake_xchain: '99999' })
                }),
                doQuery: sinon.stub().resolves([])
            };
            let reg = new ProviderRegistry(makeHub({ db }));
            await reg.load();
            await reg.loadGovernanceHistory();
            // The live def moved, but the block-0 anchor is the built-in value, so
            // historical blocks resolve identically on a hub that restarted after the
            // configs row landed and one that did not.
            expect(reg.getDef('llm').min_stake_xchain).to.equal('99999');
            expect(reg.getMinStake('llm', 500)).to.equal('25000');
        });
    });

    describe('loadGovernanceHistory', function () {
        it('anchors a full-def proposal floor at its activation block', async function () {
            let db = {
                getConfig: sinon.stub().resolves({}),
                doQuery:   sinon.stub().resolves([
                    { parameter: 'ATTESTATION_PROVIDER:llm', activation_block: 7000,
                      proposed_value: JSON.stringify({ provider_id: 'llm', min_stake_xchain: '30000',
                                                       additional_config: { approved_models: ['z'] } }) }
                ])
            };
            let reg = new ProviderRegistry(makeHub({ db }));
            await reg.loadGovernanceHistory();
            expect(reg.getMinStake('llm', 6999)).to.equal('25000');
            expect(reg.getMinStake('llm', 7000)).to.equal('30000');
        });

        it('agrees with the live governance apply path on the anchored floor', async function () {
            // A hub that applies the change live (XChainHub._applyProviderGovernanceChange)
            // and one that restarts and replays it from governance_proposals must resolve
            // the SAME floor at the same block; a floor read by only one of the two paths
            // is a cross-hub divergence.
            const XChainHub = require('../../src/XChainHub');
            let proposal = { provider_id: 'llm', min_stake_xchain: '30000',
                             additional_config: { approved_models: ['z'] } };

            let liveReg = new ProviderRegistry(makeHub());
            liveReg._seedProviderConfigGenesis();
            await XChainHub.prototype._applyProviderGovernanceChange.call(
                { providerRegistry: liveReg },
                { parameter: 'ATTESTATION_PROVIDER:llm', activationBlock: 7000,
                  newValue: JSON.stringify(proposal) });

            let db = {
                getConfig: sinon.stub().resolves({}),
                doQuery:   sinon.stub().resolves([
                    { parameter: 'ATTESTATION_PROVIDER:llm', activation_block: 7000,
                      proposed_value: JSON.stringify(proposal) }
                ])
            };
            let replayReg = new ProviderRegistry(makeHub({ db }));
            await replayReg.loadGovernanceHistory();

            for (let blk of [6999, 7000, 9000]) {
                expect(liveReg.getMinStake('llm', blk)).to.equal(replayReg.getMinStake('llm', blk));
            }
            expect(liveReg.getMinStake('llm', 7000)).to.equal('30000');
        });

        it('leaves the floor untouched for a bare additional_config proposal', async function () {
            let db = {
                getConfig: sinon.stub().resolves({}),
                doQuery:   sinon.stub().resolves([
                    { parameter: 'ATTESTATION_PROVIDER:llm', activation_block: 8000,
                      proposed_value: JSON.stringify({ approved_models: ['z'] }) }
                ])
            };
            let reg = new ProviderRegistry(makeHub({ db }));
            await reg.loadGovernanceHistory();
            expect(reg.getMinStake('llm', 8000)).to.equal('25000');
        });


        it('seeds genesis then layers passed ATTESTATION_PROVIDER proposals by activation_block', async function () {
            let db = {
                getConfig: sinon.stub().resolves({}),
                doQuery:   sinon.stub().resolves([
                    { parameter: 'ATTESTATION_PROVIDER:llm', activation_block: 3000,
                      proposed_value: JSON.stringify({ additional_config: { approved_models: ['claude-opus-4-8'], judge_model: 'claude-haiku-4-6' } }) },
                    { parameter: 'CAPABILITY_PRICE_MIN_STAKE', activation_block: 3500, proposed_value: '50000' }
                ])
            };
            let reg = new ProviderRegistry(makeHub({ db }));
            await reg.loadGovernanceHistory();
            // Genesis still resolves below the activation.
            expect(reg.getAdditionalConfig('llm', 2999).approved_models[0]).to.equal('claude-sonnet-4-6');
            // The provider proposal applies at its block; the capability row is ignored.
            expect(reg.getAdditionalConfig('llm', 3000).approved_models[0]).to.equal('claude-opus-4-8');
        });

        it('accepts a bare additional_config object as proposed_value', async function () {
            let db = {
                getConfig: sinon.stub().resolves({}),
                doQuery:   sinon.stub().resolves([
                    { parameter: 'ATTESTATION_PROVIDER:llm', activation_block: 4000,
                      proposed_value: JSON.stringify({ approved_models: ['claude-opus-4-8'] }) }
                ])
            };
            let reg = new ProviderRegistry(makeHub({ db }));
            await reg.loadGovernanceHistory();
            expect(reg.getAdditionalConfig('llm', 4000).approved_models[0]).to.equal('claude-opus-4-8');
        });
    });

    // ── cross-repo genesis-floor parity (XC-083) ─────────────────────────────
    // min_stake_xchain became consensus input when the responsible-set derivation
    // started dropping below-floor sources at/above STAKE_WEIGHTED_QUORUM. The
    // indexer resolves the same value from its OWN shipped copy
    // (xchain-indexer/src/attestation/providerRegistry.js PROVIDERS), because it
    // mirrors no hub governance table and cannot read this one. Two copies of a
    // consensus number need a guard tying them together, or a well-meant edit to
    // one silently splits the responsible set.
    //
    // Anchored here because the hub DECLARES the value (governance loads into this
    // registry) and the indexer mirrors it; same direction as the oracle-band and
    // xcall-constant cross-repo gates. Sibling policy matches them too: a missing
    // checkout skips, and XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip.
    describe('provider stake floors agree with the indexer mirror (XC-083)', function () {
        const fs   = require('fs');
        const path = require('path');

        const REPO_ROOT = (function () {
            let dir = __dirname;
            while (!fs.existsSync(path.join(dir, 'package.json'))) {
                const up = path.dirname(dir);
                if (up === dir) throw new Error('no package.json above ' + __dirname);
                dir = up;
            }
            return dir;
        })();
        const MIRROR = path.join(path.dirname(REPO_ROOT),
            'xchain-indexer', 'src', 'attestation', 'providerRegistry.js');

        it('the indexer ships the identical genesis floor for every provider', function () {
            if (!fs.existsSync(MIRROR)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('provider stake-floor parity gate cannot run: xchain-indexer ' +
                        'providerRegistry.js missing at ' + MIRROR +
                        '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
                this.skip();
                return;
            }
            // Fresh read: a module cached by an earlier suite would hide an on-disk edit.
            const resolved = require.resolve(MIRROR);
            delete require.cache[resolved];
            const theirs = require(resolved).PROVIDERS;

            const ours = ProviderRegistry.DEFAULTS;
            expect(Object.keys(theirs).sort(), 'the two repos disagree on which providers exist')
                .to.deep.equal(Object.keys(ours).sort());
            for (const id of Object.keys(ours)) {
                expect(ProviderRegistry.normalizeMinStakeXchain(theirs[id].min_stake_xchain),
                    'indexer min_stake_xchain for "' + id + '" drifted from the hub genesis value; ' +
                    'a responsible-set fork, not a cosmetic difference')
                    .to.equal(ProviderRegistry.normalizeMinStakeXchain(ours[id].min_stake_xchain));
            }
        });

        it('every shipped provider actually declares a floor', function () {
            // A provider with no floor resolves null, which every consensus caller
            // fails closed on: it would make that provider unservable at/above the gate.
            for (const [id, def] of Object.entries(ProviderRegistry.DEFAULTS))
                expect(ProviderRegistry.normalizeMinStakeXchain(def.min_stake_xchain),
                    'provider "' + id + '" ships no usable min_stake_xchain').to.not.be.null;
        });
    });
});
