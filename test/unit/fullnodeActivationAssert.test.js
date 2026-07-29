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

// : NODEPROOF full-node tier activation preflight. The tier ships INERT
// (REWARD_SHARE '0', GENESIS_VERIFIERS []) and activation is a fleet-wide
// consensus change, so the hub (a) refuses a per-operator FULLNODE override that
// diverges from the pinned coin bundle, (b) refuses an incoherent activation that
// could never pay out or could never reach verifier quorum, and (c) seeds its own
// FULLNODE config from that bundle instead of hardcoded literals.

const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');

const XChainHub  = require('../../src/XChainHub.js');
const coins      = require('../../src/coins');
const activation = require('../../src/lib/fullnode_activation.js');

const CANONICAL = coins.getCoinConfig('BTC', 'mainnet').FULLNODE;
const PK1 = 'a'.repeat(64);
const PK2 = 'b'.repeat(64);

function makeHub(network) {
    return new XChainHub(null, null, null, null, null,
        network === undefined ? null : { HUB_NETWORK: network });
}

// An activated block that is internally coherent: what a real activation looks like.
function activatedCfg(overrides) {
    return Object.assign({}, CANONICAL, {
        REWARD_SHARE: '0.25',
        GENESIS_VERIFIERS: [PK1, PK2],
    }, overrides || {});
}

describe('fullnode_activation ', function () {

    describe('the shipped canonical bundle', function () {

        it('is INERT: REWARD_SHARE 0 and no genesis verifiers (GENESIS-PARAMETERS B7)', function () {
            expect(Number(CANONICAL.REWARD_SHARE)).to.equal(0);
            expect(CANONICAL.GENESIS_VERIFIERS).to.deep.equal([]);
            expect(activation.isActive(CANONICAL)).to.equal(false);
        });

        it('is coherent, so a hub booting the shipped bundle never warns', function () {
            expect(activation.validateActivation(CANONICAL)).to.deep.equal([]);
        });

        it('describes itself as INERT for the boot log', function () {
            expect(activation.describeActivation(CANONICAL)).to.match(/^INERT/);
        });
    });

    describe('validateActivation', function () {

        it('accepts a coherent activation', function () {
            expect(activation.validateActivation(activatedCfg())).to.deep.equal([]);
            expect(activation.describeActivation(activatedCfg()))
                .to.equal('ACTIVE (REWARD_SHARE=0.25, 2 genesis verifiers)');
        });

        it('rejects activation with no genesis verifiers (the tranche is unearnable)', function () {
            let problems = activation.validateActivation(activatedCfg({ GENESIS_VERIFIERS: [] }));
            expect(problems.length).to.equal(1);
            expect(problems[0]).to.include('GENESIS_VERIFIERS is empty');
        });

        it('rejects a REWARD_SHARE above 1 (pays out more than the round budget)', function () {
            let problems = activation.validateActivation(activatedCfg({ REWARD_SHARE: '1.5' }));
            expect(problems.join(' ')).to.include('outside [0,1]');
        });

        it('rejects a negative or non-numeric REWARD_SHARE', function () {
            expect(activation.validateActivation(activatedCfg({ REWARD_SHARE: '-0.1' })).join(' '))
                .to.include('outside [0,1]');
            expect(activation.validateActivation(activatedCfg({ REWARD_SHARE: 'a quarter' })).join(' '))
                .to.include('not a number');
        });

        it('rejects a malformed genesis verifier the runtime would silently drop', function () {
            let problems = activation.validateActivation(activatedCfg({ GENESIS_VERIFIERS: [PK1, 'nope'] }));
            expect(problems.join(' ')).to.include('not 64-hex');
            expect(problems.join(' ')).to.include('"nope"');
        });

        it('rejects duplicate genesis verifiers (case-insensitive)', function () {
            let problems = activation.validateActivation(
                activatedCfg({ GENESIS_VERIFIERS: [PK1, PK1.toUpperCase()] }));
            expect(problems.join(' ')).to.include('duplicate');
        });

        it('rejects a proof window shorter than the challenge interval', function () {
            let problems = activation.validateActivation(
                activatedCfg({ CHALLENGE_INTERVAL_BLOCKS: 144, PROOF_WINDOW_BLOCKS: 100 }));
            expect(problems.join(' ')).to.include('PROOF_WINDOW_BLOCKS 100 is shorter');
        });

        it('rejects a reward-pass window shorter than the challenge interval', function () {
            let problems = activation.validateActivation(
                activatedCfg({ CHALLENGE_INTERVAL_BLOCKS: 144, REWARD_PASS_WINDOW_BLOCKS: 10 }));
            expect(problems.join(' ')).to.include('REWARD_PASS_WINDOW_BLOCKS 10 is shorter');
        });

        it('rejects an out-of-range MIN_PASS_RATE_BPS', function () {
            expect(activation.validateActivation(activatedCfg({ MIN_PASS_RATE_BPS: 20000 })).join(' '))
                .to.include('MIN_PASS_RATE_BPS 20000');
        });

        it('rejects a non-integer block count', function () {
            expect(activation.validateActivation(activatedCfg({ CONFIRM_DEPTH: '100.5' })).join(' '))
                .to.include('CONFIRM_DEPTH is not an integer');
        });

        it('does not apply the deadlock checks while the tier is inert', function () {
            // Same windows that fail above, but REWARD_SHARE 0 means nothing reads them.
            let inert = Object.assign({}, CANONICAL, { PROOF_WINDOW_BLOCKS: 1, REWARD_PASS_WINDOW_BLOCKS: 1 });
            expect(activation.validateActivation(inert)).to.deep.equal([]);
        });
    });

    describe('diffCanonical', function () {

        it('passes an override that matches the bundle', function () {
            expect(activation.diffCanonical({ REWARD_SHARE: '0' }, CANONICAL)).to.deep.equal([]);
        });

        it('tolerates numerically-equal spellings and verifier order/case', function () {
            let canonical = activatedCfg();
            let operator  = { REWARD_SHARE: 0.25, CHALLENGE_INTERVAL_BLOCKS: '144',
                              GENESIS_VERIFIERS: [PK2.toUpperCase(), PK1] };
            expect(activation.diffCanonical(operator, canonical)).to.deep.equal([]);
        });

        it('reports a divergent consensus knob', function () {
            let problems = activation.diffCanonical({ CHALLENGE_INTERVAL_BLOCKS: 10 }, CANONICAL);
            expect(problems.length).to.equal(1);
            expect(problems[0]).to.include('CHALLENGE_INTERVAL_BLOCKS');
        });

        it('reports a verifier list the bundle does not carry', function () {
            expect(activation.diffCanonical({ GENESIS_VERIFIERS: [PK1] }, CANONICAL).join(' '))
                .to.include('GENESIS_VERIFIERS');
        });

        it('ignores local, non-consensus keys (BTC_RPC, POLL_MS)', function () {
            expect(activation.diffCanonical({ BTC_RPC: 'http://x', POLL_MS: 5000 }, CANONICAL))
                .to.deep.equal([]);
        });

        it('covers every consensus key the bundle declares', function () {
            // Guard against a knob being added to coins/BTC.js and quietly escaping
            // the assert: the key list is derived from the bundle, not hardcoded.
            let keys = activation.consensusKeys(CANONICAL);
            expect(keys).to.include.members(['REWARD_SHARE', 'GENESIS_VERIFIERS',
                'CHALLENGE_INTERVAL_BLOCKS', 'CONFIRM_DEPTH', 'PROOF_WINDOW_BLOCKS',
                'VERDICT_ACCEPT_WINDOW_BLOCKS', 'REWARD_PASS_WINDOW_BLOCKS', 'MIN_PASS_RATE_BPS']);
            expect(keys.some(k => k.charAt(0) === '$')).to.equal(false);
        });
    });

    describe('mergeWithCanonical', function () {

        it('keeps the bundle values and adds the operator local keys', function () {
            let merged = activation.mergeWithCanonical(CANONICAL, { BTC_RPC: 'http://coin' });
            expect(merged.REWARD_SHARE).to.equal(CANONICAL.REWARD_SHARE);
            expect(merged.CHALLENGE_INTERVAL_BLOCKS).to.equal(CANONICAL.CHALLENGE_INTERVAL_BLOCKS);
            expect(merged.BTC_RPC).to.equal('http://coin');
        });

        it('strips $-prefixed descriptors', function () {
            let merged = activation.mergeWithCanonical({ A: 1, $regtestSidecar: 'x.json' }, null);
            expect(merged).to.deep.equal({ A: 1 });
        });
    });
});

describe('XChainHub._assertCanonicalFullnode ', function () {

    let warnStub;
    beforeEach(function () { warnStub = sinon.stub(console, 'warn'); });
    afterEach(function () {
        warnStub.restore();
        delete process.env.XCHAIN_HUB_SKIP_FULLNODE_ASSERT;
    });

    it('accepts a local-keys-only override on mainnet', function () {
        expect(() => makeHub('mainnet')._assertCanonicalFullnode({ BTC_RPC: 'http://coin' })).to.not.throw();
    });

    it('refuses a divergent challenge interval on mainnet', function () {
        let err = null;
        try { makeHub('mainnet')._assertCanonicalFullnode({ CHALLENGE_INTERVAL_BLOCKS: 10 }); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('FULLNODE_CONFIG_MISMATCH');
        expect(err.message).to.include('CHALLENGE_INTERVAL_BLOCKS');
        expect(err.message).to.include('NODEPROOF-ACTIVATION-RUNBOOK');
    });

    it('refuses a per-operator activation on mainnet (consensus change, must ship in the bundle)', function () {
        let err = null;
        try {
            makeHub('mainnet')._assertCanonicalFullnode({ REWARD_SHARE: '0.25', GENESIS_VERIFIERS: [PK1] });
        } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('FULLNODE_CONFIG_MISMATCH');
        expect(err.message).to.include('REWARD_SHARE');
    });

    it('refuses on testnet too', function () {
        expect(() => makeHub('testnet')._assertCanonicalFullnode({ REWARD_SHARE: '0.5' }))
            .to.throw().with.property('code', 'FULLNODE_CONFIG_MISMATCH');
    });

    it('warns instead of throwing on regtest (venues run their own cadence)', function () {
        expect(() => makeHub('regtest')._assertCanonicalFullnode({ CHALLENGE_INTERVAL_BLOCKS: 4 })).to.not.throw();
        expect(warnStub.calledWithMatch(/FULLNODE config problem/)).to.equal(true);
    });

    it('warns instead of throwing in standalone mode (no HUB_NETWORK)', function () {
        expect(() => makeHub(undefined)._assertCanonicalFullnode({ CHALLENGE_INTERVAL_BLOCKS: 4 })).to.not.throw();
        expect(warnStub.calledWithMatch(/FULLNODE config problem/)).to.equal(true);
    });

    it('XCHAIN_HUB_SKIP_FULLNODE_ASSERT=1 bypasses loudly, even on mainnet', function () {
        process.env.XCHAIN_HUB_SKIP_FULLNODE_ASSERT = '1';
        expect(() => makeHub('mainnet')._assertCanonicalFullnode({ CHALLENGE_INTERVAL_BLOCKS: 10 })).to.not.throw();
        expect(warnStub.calledWithMatch(/XCHAIN_HUB_SKIP_FULLNODE_ASSERT/)).to.equal(true);
    });

    it('is a no-op for a missing/invalid FULLNODE block', function () {
        let hub = makeHub('mainnet');
        expect(() => hub._assertCanonicalFullnode(undefined)).to.not.throw();
        expect(() => hub._assertCanonicalFullnode([])).to.not.throw();
        expect(() => hub._assertCanonicalFullnode('nope')).to.not.throw();
    });
});

describe('XChainHub._seedCanonicalFullnode ', function () {

    it('seeds at CONSTRUCTION, before startP2P builds FullNodeChallengeRound', function () {
        // The engine snapshots cfg.FULLNODE in its constructor, so a seed that only
        // ran in startCapabilities (which api.js calls AFTER startP2P) would never
        // reach it and the hub would keep running hardcoded literals.
        let hub = makeHub('mainnet');
        expect(hub.p2pConfig.FULLNODE).to.be.an('object');
        expect(hub.p2pConfig.FULLNODE.PROOF_WINDOW_BLOCKS).to.equal(CANONICAL.PROOF_WINDOW_BLOCKS);
    });

    it('never creates p2pConfig (a null one is standalone mode, startP2P returns early)', function () {
        let hub = makeHub(undefined);
        expect(hub.p2pConfig).to.equal(null);
        hub._seedCanonicalFullnode();
        expect(hub.p2pConfig).to.equal(null);
    });

    it('seeds the canonical bundle when the operator supplied nothing', function () {
        let hub = makeHub('mainnet');
        hub._seedCanonicalFullnode();
        expect(hub.p2pConfig.FULLNODE.REWARD_SHARE).to.equal(CANONICAL.REWARD_SHARE);
        expect(hub.p2pConfig.FULLNODE.CHALLENGE_INTERVAL_BLOCKS)
            .to.equal(CANONICAL.CHALLENGE_INTERVAL_BLOCKS);
        expect(hub.p2pConfig.FULLNODE.GENESIS_VERIFIERS).to.deep.equal([]);
    });

    it('keeps operator local keys on top of the bundle', function () {
        let hub = makeHub('mainnet');
        hub.p2pConfig.FULLNODE = { BTC_RPC: 'http://coin' };
        hub._seedCanonicalFullnode();
        expect(hub.p2pConfig.FULLNODE.BTC_RPC).to.equal('http://coin');
        expect(hub.p2pConfig.FULLNODE.PROOF_WINDOW_BLOCKS).to.equal(CANONICAL.PROOF_WINDOW_BLOCKS);
    });

    it('is idempotent across a config hot-reload', function () {
        let hub = makeHub('mainnet');
        hub._seedCanonicalFullnode();
        let first = JSON.stringify(hub.p2pConfig.FULLNODE);
        hub._seedCanonicalFullnode();
        expect(JSON.stringify(hub.p2pConfig.FULLNODE)).to.equal(first);
    });

    it('picks up the regtest env override so the hub matches its indexer', function () {
        // The regtest venue activates the tier with FULLNODE_* env vars; before
        //  those reached the indexer only, and the hub kept the inert values.
        process.env.FULLNODE_GENESIS_VERIFIERS = PK1 + ',' + PK2.toUpperCase();
        process.env.FULLNODE_CHALLENGE_INTERVAL_BLOCKS = '4';
        try {
            let hub = makeHub('regtest');
            hub._seedCanonicalFullnode();
            expect(hub.p2pConfig.FULLNODE.GENESIS_VERIFIERS).to.deep.equal([PK1, PK2]);
            expect(hub.p2pConfig.FULLNODE.CHALLENGE_INTERVAL_BLOCKS).to.equal(4);
        } finally {
            delete process.env.FULLNODE_GENESIS_VERIFIERS;
            delete process.env.FULLNODE_CHALLENGE_INTERVAL_BLOCKS;
        }
    });
});

describe('XChainHub._loadCapabilityConfigFile FULLNODE integration ', function () {

    let tmpPath, warnStub, logStub;
    beforeEach(function () {
        warnStub = sinon.stub(console, 'warn');
        logStub  = sinon.stub(console, 'log');
    });
    afterEach(function () {
        warnStub.restore();
        logStub.restore();
        if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    });

    function writeConfig(obj) {
        tmpPath = path.join(os.tmpdir(), 'xc283_caps_' + process.pid + '_' +
            Math.random().toString(36).slice(2) + '.json');
        fs.writeFileSync(tmpPath, JSON.stringify(obj));
        return tmpPath;
    }

    it('refuses a divergent FULLNODE file on mainnet WITHOUT merging it', function () {
        let hub = makeHub('mainnet');
        expect(() => hub._loadCapabilityConfigFile(writeConfig({ FULLNODE: { REWARD_SHARE: '0.25' } })))
            .to.throw().with.property('code', 'FULLNODE_CONFIG_MISMATCH');
        // The refused value must not have leaked in: the hub keeps the pinned bundle.
        expect(hub.p2pConfig.FULLNODE.REWARD_SHARE).to.equal(CANONICAL.REWARD_SHARE);
    });

    it('applies the assert to the "full_node" spelling alias too', function () {
        let hub = makeHub('mainnet');
        expect(() => hub._loadCapabilityConfigFile(writeConfig({ full_node: { REWARD_SHARE: '0.25' } })))
            .to.throw().with.property('code', 'FULLNODE_CONFIG_MISMATCH');
    });

    it('loads a local-keys-only FULLNODE file and seeds the canonical knobs under it', function () {
        let hub = makeHub('mainnet');
        hub._loadCapabilityConfigFile(writeConfig({ FULLNODE: { BTC_RPC: 'http://coin' } }));
        expect(hub.p2pConfig.FULLNODE.BTC_RPC).to.equal('http://coin');
        expect(hub.p2pConfig.FULLNODE.REWARD_SHARE).to.equal(CANONICAL.REWARD_SHARE);
        expect(hub.p2pConfig.FULLNODE.CONFIRM_DEPTH).to.equal(CANONICAL.CONFIRM_DEPTH);
    });
});
