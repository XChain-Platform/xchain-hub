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

function row(paramName, value, coin) {
    return { coin: coin || 'Bitcoin', param_name: paramName, param_value: value };
}


function installSuiteHooks1() {
    afterEach(function () {
            sinon.restore();
        });
}

// ── Block-anchored provider-config history (consensus model identity) ─────
describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('getAdditionalConfig (block-anchored)', function () {
it('returns the genesis config before any activation', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            let ac = reg.getAdditionalConfig('llm', 500);
            expect(ac.approved_models[0]).to.equal('claude-sonnet-4-6');
            expect(ac.judge_model).to.equal('claude-haiku-4-5');
        });
it('resolves the activation-N config at block N and later, genesis before', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, { approved_models: ['claude-opus-4-8'], judge_model: 'claude-haiku-4-6' });
            expect(reg.getAdditionalConfig('llm', 999).approved_models[0]).to.equal('claude-sonnet-4-6');
            expect(reg.getAdditionalConfig('llm', 1000).approved_models[0]).to.equal('claude-opus-4-8');
            expect(reg.getAdditionalConfig('llm', 5000).judge_model).to.equal('claude-haiku-4-6');
        });
it('falls back to the current def additional_config when no history exists', function () {
            let reg = new ProviderRegistry(makeHub());
            // No seedProviderConfigGenesis call: history is empty.
            let ac = reg.getAdditionalConfig('llm', 100);
            expect(ac.approved_models[0]).to.equal('claude-sonnet-4-6');
        });
});
describe('applyProviderConfigActivation', function () {
it('is idempotent by activation_block (overwrites, no duplicate entry)', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
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
});

// ── Block-anchored provider stake floor ──────────────────────────
describe('ProviderRegistry', function () {
    installSuiteHooks1();
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
});

// consensus_strategy selects which PBFT state machine AttestationConsensus runs
// for a round (judge_model: leader-only agree() + follower PREPARE-adoption;
// byte_equality: every hub agrees + first-verified-PREPARE-wins). Read live off
// the hot-reloaded registry it was the one round-shaping field two hubs could
// disagree on mid-round, because hotReload() re-parses every provider def out of
// the local configs table on EVERY proposal:finalized event whatever the proposal
// was about. These pin the anchoring that closes that.
describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('getMinStake (block-anchored provider floor)', function () {
it('resolves the spec floors from the genesis seed', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            expect(reg.getMinStake('http_get', 500)).to.equal('10000');
            expect(reg.getMinStake('llm', 500)).to.equal('25000');
        });
it('resolves the activation floor at its block and later, genesis before', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, { approved_models: ['x'] }, '40000');
            expect(reg.getMinStake('llm', 999)).to.equal('25000');
            expect(reg.getMinStake('llm', 1000)).to.equal('40000');
            expect(reg.getMinStake('llm', 999999)).to.equal('40000');
        });
it('keeps the previous floor across an activation that only moves additional_config', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, { approved_models: ['x'] }, '40000');
            reg.applyProviderConfigActivation('llm', 2000, { approved_models: ['y'] });   // no floor change
            expect(reg.getMinStake('llm', 2000)).to.equal('40000');
            expect(reg.getAdditionalConfig('llm', 2000).approved_models[0]).to.equal('y');
        });
it('is order-independent: a later-appended earlier activation still resolves correctly', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 3000, {}, '60000');
            reg.applyProviderConfigActivation('llm', 2000, {}, '40000');   // appended out of order
            expect(reg.getMinStake('llm', 1999)).to.equal('25000');
            expect(reg.getMinStake('llm', 2000)).to.equal('40000');
            expect(reg.getMinStake('llm', 3000)).to.equal('60000');
        });
it('returns the latest configured floor when no block is given', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 5000, {}, '90000');
            expect(reg.getMinStake('llm')).to.equal('90000');
        });
it('falls back to the live definition when no history exists', function () {
            let reg = new ProviderRegistry(makeHub());
            // No seedProviderConfigGenesis call: history is empty.
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
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, {}, 'not-a-number');
            expect(reg.getMinStake('llm', 1000)).to.equal('25000');
        });
});
});

describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('getMinStake (block-anchored provider floor)', function () {
it('re-seeding genesis does not wipe a later activation floor', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, {}, '40000');
            reg.seedProviderConfigGenesis();
            expect(reg.getMinStake('llm', 999)).to.equal('25000');
            expect(reg.getMinStake('llm', 1000)).to.equal('40000');
        });
it('genesis stays pinned to DEFAULTS even when the configs table raised the live floor', async function () {
            let db = { ...DB_METHODS,
                getConfigRowsByModule: sinon.stub().resolves([
                    row('llm', JSON.stringify({ provider_id: 'llm', min_stake_xchain: '99999' }))
                ]),
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
});

describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('getConsensusStrategy (block-anchored PBFT strategy)', function () {
it('resolves the DEFAULTS strategies from the genesis seed', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            expect(reg.getConsensusStrategy('http_get', 500)).to.equal('byte_equality');
            expect(reg.getConsensusStrategy('llm', 500)).to.equal('judge_model');
        });
it('resolves the activation strategy at its block and later, genesis before', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, { approved_models: ['x'] }, null, 'byte_equality');
            expect(reg.getConsensusStrategy('llm', 999)).to.equal('judge_model');
            expect(reg.getConsensusStrategy('llm', 1000)).to.equal('byte_equality');
            expect(reg.getConsensusStrategy('llm', 999999)).to.equal('byte_equality');
        });
it('keeps the previous strategy across an activation that only moves additional_config', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, { approved_models: ['x'] }, null, 'byte_equality');
            reg.applyProviderConfigActivation('llm', 2000, { approved_models: ['y'] });   // no strategy change
            expect(reg.getConsensusStrategy('llm', 2000)).to.equal('byte_equality');
        });
it('carries an unrecognised strategy verbatim rather than walking back to an older one', function () {
            // A hub on older code must resolve the same UNKNOWN value every peer does and
            // decline the round, not silently run the previous state machine while the
            // rest of the federation runs the new one.
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, {}, null, 'threshold_vote');
            expect(reg.getConsensusStrategy('llm', 1000)).to.equal('threshold_vote');
        });
it('genesis stays pinned to DEFAULTS even when the configs table flipped the live strategy', async function () {
            // This is the exact divergence the anchoring exists for: an operator (or a
            // governance hotReload of an unrelated proposal) re-parses the configs table
            // into the live def, and a restarted hub would otherwise disagree with a
            // long-running one about which state machine a historical block runs.
            let db = { ...DB_METHODS,
                getConfigRowsByModule: sinon.stub().resolves([
                    row('llm', JSON.stringify({ provider_id: 'llm', consensus_strategy: 'byte_equality' }))
                ]),
                doQuery: sinon.stub().resolves([])
            };
            let reg = new ProviderRegistry(makeHub({ db }));
            await reg.load();
            await reg.loadGovernanceHistory();
            expect(reg.getDef('llm').consensus_strategy).to.equal('byte_equality');
            expect(reg.getConsensusStrategy('llm', 500)).to.equal('judge_model');
        });
});
});

describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('getConsensusStrategy (block-anchored PBFT strategy)', function () {
it('anchors a full-def governance strategy change at its activation block', async function () {
            let db = { ...DB_METHODS,
                getConfigRowsByModule: sinon.stub().resolves([]),
                doQuery:   sinon.stub().resolves([
                    { parameter: 'ATTESTATION_PROVIDER:llm', activation_block: 7000,
                      proposed_value: JSON.stringify({ provider_id: 'llm', consensus_strategy: 'byte_equality' }) }
                ])
            };
            let reg = new ProviderRegistry(makeHub({ db }));
            await reg.loadGovernanceHistory();
            expect(reg.getConsensusStrategy('llm', 6999)).to.equal('judge_model');
            expect(reg.getConsensusStrategy('llm', 7000)).to.equal('byte_equality');
        });
it('falls back to the live definition when no history exists', function () {
            let reg = new ProviderRegistry(makeHub());
            // No seedProviderConfigGenesis call: history is empty. No worse than the
            // pre-anchoring behaviour, which read live unconditionally.
            expect(reg.getConsensusStrategy('llm', 100)).to.equal('judge_model');
        });
it('returns null for a provider with no strategy anywhere, so a caller can fail closed', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.providers.set('strategyless', { provider_id: 'strategyless' });
            expect(reg.getConsensusStrategy('strategyless', 100)).to.equal(null);
            expect(reg.getConsensusStrategy('nonexistent', 100)).to.equal(null);
        });
it('re-seeding genesis does not wipe a later activation strategy', function () {
            let reg = new ProviderRegistry(makeHub());
            reg.seedProviderConfigGenesis();
            reg.applyProviderConfigActivation('llm', 1000, {}, null, 'byte_equality');
            reg.seedProviderConfigGenesis();
            expect(reg.getConsensusStrategy('llm', 999)).to.equal('judge_model');
            expect(reg.getConsensusStrategy('llm', 1000)).to.equal('byte_equality');
        });
});
});

describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('loadGovernanceHistory', function () {
it('anchors a full-def proposal floor at its activation block', async function () {
            let db = { ...DB_METHODS,
                getConfigRowsByModule: sinon.stub().resolves([]),
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
            // A hub that applies the change live (XChainHub.applyProviderGovernanceChange)
            // and one that restarts and replays it from governance_proposals must resolve
            // the SAME floor at the same block; a floor read by only one of the two paths
            // is a cross-hub divergence.
            const XChainHub = require('../../../src/XChainHub');
            let proposal = { provider_id: 'llm', min_stake_xchain: '30000',
                             additional_config: { approved_models: ['z'] } };

            let liveReg = new ProviderRegistry(makeHub());
            liveReg.seedProviderConfigGenesis();
            await XChainHub.prototype.applyProviderGovernanceChange.call(
                { providerRegistry: liveReg },
                { parameter: 'ATTESTATION_PROVIDER:llm', activationBlock: 7000,
                  newValue: JSON.stringify(proposal) });

            let db = { ...DB_METHODS,
                getConfigRowsByModule: sinon.stub().resolves([]),
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
});
});

describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('loadGovernanceHistory', function () {
it('leaves the floor untouched for a bare additional_config proposal', async function () {
            let db = { ...DB_METHODS,
                getConfigRowsByModule: sinon.stub().resolves([]),
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
            let db = { ...DB_METHODS,
                getConfigRowsByModule: sinon.stub().resolves([]),
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
            let db = { ...DB_METHODS,
                getConfigRowsByModule: sinon.stub().resolves([]),
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
});
