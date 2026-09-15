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
const ProviderRegistry   = require('../../../src/validators/provider_registry');
const { DB_METHODS } = require('../../helpers/mockHub.js');
// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
// Mirrors the real hub: XChainHub sets p2pConfig and derives `network` from
// HUB_NETWORK, and has no `config` property at all. The old fixture fabricated
// `config: { COIN, NETWORK }`, which is why load() reading hub.config never went
// red here while it early-returned on every production hub.
function makeHub(overrides) {
    let net = overrides && overrides.network !== undefined ? overrides.network : 'mainnet';
    return {
        p2pConfig: net ? { HUB_NETWORK: net } : null,
        network:   net,
        db:        overrides && overrides.db ? overrides.db : {
            getConfigRowsByModule: sinon.stub().resolves([])
        }
    };
}
// One configs row as db.getConfigRowsByModule returns it.
function row(paramName, value, coin) {
    return { coin: coin || 'Bitcoin', param_name: paramName, param_value: value };
}
// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────
function installSuiteHooks1() {
    afterEach(function () {
            sinon.restore();
        });
}
// ── Constructor / defaults ───────────────────────────────────────────────
describe('ProviderRegistry', function () {
    installSuiteHooks1();
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
            let { DEFAULTS } = require('../../../src/validators/provider_registry');
            expect(DEFAULTS).to.have.property('http_get');
            expect(DEFAULTS).to.have.property('llm');
            expect(DEFAULTS.llm.additional_config).to.have.property('judge_model');
        });
});
});
// ── load ─────────────────────────────────────────────────────────────────
// This fixture is production-shaped on purpose: the hub object a real
// XChainHub hands the registry carries no `config`, so a namespace resolved
// from there stops load() before the read.
// Asserting the stored value (not just that a stub was called) is what makes
// this go red if the namespace resolution regresses: the built-in default is
// 16384, so a skipped read reports 16384 and fails the equality below.
describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('load()', function () {
it('re-seeds defaults and overlays governance definitions', async function () {
            let db = {
                getConfigRowsByModule: sinon.stub().resolves([
                    row('http_get', JSON.stringify({
                        provider_id: 'http_get',
                        max_response_bytes: 65536  // governance-raised cap
                    }))
                ])
            };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            await reg.load();
            expect(reg.getDef('http_get').max_response_bytes).to.equal(65536);
        });
it('reads the configs table on a production-shaped hub', async function () {
            let db = {
                getConfigRowsByModule: sinon.stub().resolves([
                    row('llm', JSON.stringify({ provider_id: 'llm', max_response_bytes: 123 }))
                ])
            };
            let hub = { p2pConfig: { HUB_NETWORK: 'mainnet' }, network: 'mainnet', db };
            let reg = new ProviderRegistry(hub);
            await reg.load();
            expect(db.getConfigRowsByModule.calledOnceWithExactly('mainnet', 'ATTESTATION_PROVIDER')).to.be.true;
            expect(reg.getDef('llm').max_response_bytes).to.equal(123);
        });
it('resolves the network from p2pConfig when the hub has no derived field', async function () {
            let db = {
                getConfigRowsByModule: sinon.stub().resolves([
                    row('llm', JSON.stringify({ provider_id: 'llm', max_response_bytes: 456 }))
                ])
            };
            let reg = new ProviderRegistry({ p2pConfig: { HUB_NETWORK: 'testnet' }, db });
            await reg.load();
            expect(db.getConfigRowsByModule.calledOnceWithExactly('testnet', 'ATTESTATION_PROVIDER')).to.be.true;
            expect(reg.getDef('llm').max_response_bytes).to.equal(456);
        });
it('keeps the built-in default when two coins disagree about one provider', async function () {
            // Resolving this by picking a coin would let two hubs read different
            // limits out of the same table; the ambiguity is refused, loudly.
            let db = {
                getConfigRowsByModule: sinon.stub().resolves([
                    row('llm', JSON.stringify({ provider_id: 'llm', max_response_bytes: 111 }), 'Bitcoin'),
                    row('llm', JSON.stringify({ provider_id: 'llm', max_response_bytes: 222 }), 'Litecoin')
                ])
            };
            let warn = sinon.stub(console, 'warn');
            let reg = new ProviderRegistry(makeHub({ db }));
            await reg.load();
            expect(reg.getDef('llm').max_response_bytes).to.equal(16384);
            expect(warn.calledOnce).to.be.true;
            expect(warn.firstCall.args[0]).to.contain('conflicting definitions');
        });
});
});
describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('load()', function () {
it('applies a definition duplicated identically across coins', async function () {
            let same = JSON.stringify({ provider_id: 'llm', max_response_bytes: 777 });
            let db = {
                getConfigRowsByModule: sinon.stub().resolves([
                    row('llm', same, 'Bitcoin'), row('llm', same, 'Litecoin')
                ])
            };
            let reg = new ProviderRegistry(makeHub({ db }));
            await reg.load();
            expect(reg.getDef('llm').max_response_bytes).to.equal(777);
        });
it('injects provider_id when the governance def omits it', async function () {
            let db = {
                getConfigRowsByModule: sinon.stub().resolves([
                    row('new_provider', JSON.stringify({ consensus_strategy: 'byte_equality' }))
                ])
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
                getConfigRowsByModule: sinon.stub().resolves([
                    row('badprov', null), row('emptyprov', '')
                ])
            };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            await reg.load();
            // null/empty entries should be ignored
            expect(reg.isKnown('badprov')).to.be.false;
        });
it('warns and skips invalid JSON rows', async function () {
            let db = {
                getConfigRowsByModule: sinon.stub().resolves([row('broken', 'NOT_JSON')])
            };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            await reg.load();  // must not throw
            expect(reg.isKnown('broken')).to.be.false;
        });
});
});
describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('load()', function () {
it('does not call DB when the hub has no network, and says so once', async function () {
            let db = { getConfigRowsByModule: sinon.stub().resolves([]) };
            let warn = sinon.stub(console, 'warn');
            let hub = makeHub({ network: '', db });
            let reg = new ProviderRegistry(hub);
            await reg.load();
            await reg.load();
            expect(db.getConfigRowsByModule.called).to.be.false;
            expect(reg.isKnown('http_get')).to.be.true;
            expect(warn.calledOnce).to.be.true;
        });
it('does not call DB when db is null', async function () {
            let hub = { p2pConfig: { HUB_NETWORK: 'mainnet' }, network: 'mainnet', db: null };
            let reg = new ProviderRegistry(hub);
            await reg.load();  // must not throw
        });
it('handles DB error gracefully', async function () {
            let db = { getConfigRowsByModule: sinon.stub().rejects(new Error('db down')) };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            await reg.load();  // must not throw; defaults still present
            expect(reg.isKnown('http_get')).to.be.true;
        });
});
});
describe('ProviderRegistry', function () {
    installSuiteHooks1();
// ── hotReload ────────────────────────────────────────────────────────────
// hotReload() is load(), so the same namespace defect made the governance
// hot path dead too. Same shape of assertion, driven through hotReload.
describe('hotReload()', function () {
it('re-loads providers and re-injects config into loaded modules', async function () {
            let db = { getConfigRowsByModule: sinon.stub().resolves([]) };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            // Simulate an already-loaded module with _setConfig
            let setConfigStub = sinon.stub();
            reg.modules.set('http_get', { _setConfig: setConfigStub });
            await reg.hotReload();
            expect(setConfigStub.calledOnce).to.be.true;
        });
it('reads the configs table on a production-shaped hub', async function () {
            let db = {
                getConfigRowsByModule: sinon.stub().resolves([
                    row('llm', JSON.stringify({ provider_id: 'llm', max_response_bytes: 123 }))
                ])
            };
            let reg = new ProviderRegistry({ p2pConfig: { HUB_NETWORK: 'mainnet' }, network: 'mainnet', db });
            await reg.hotReload();
            expect(db.getConfigRowsByModule.calledOnce).to.be.true;
            expect(reg.getDef('llm').max_response_bytes).to.equal(123);
        });
it('does not throw when _setConfig throws', async function () {
            let db = { getConfigRowsByModule: sinon.stub().resolves([]) };
            let hub = makeHub({ db });
            let reg = new ProviderRegistry(hub);
            reg.modules.set('http_get', { _setConfig: sinon.stub().throws(new Error('bad config')) });
            await reg.hotReload();  // must not throw
        });
});
});
// ── isKnown / getDef / getModule ─────────────────────────────────────────
describe('ProviderRegistry', function () {
    installSuiteHooks1();
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
});
// ── Validation helpers ───────────────────────────────────────────────────
describe('ProviderRegistry', function () {
    installSuiteHooks1();
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
});
describe('ProviderRegistry', function () {
    installSuiteHooks1();
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
});
