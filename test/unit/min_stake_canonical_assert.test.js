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

// startup assertion that operator capability MIN_STAKE thresholds match
// the canonical coins registry. The configured value is the qualifying floor
// every CapabilitySnapshot query sends the indexer, so a divergent value forks
// the qualified validator set / quorum N across hubs. mainnet/testnet refuse
// the config fail-closed; regtest/standalone warn (test venues run low floors);
// XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT=1 is a loud bypass.

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const sinon    = require('sinon');
const { expect } = require('chai');

const XChainHub = require('../../src/XChainHub.js');
const coins     = require('../../src/coins');

const CANONICAL = coins.getCoinConfig('BTC', 'mainnet').STAKING.CAPABILITIES;

function makeHub(network) {
    return new XChainHub(null, null, null, null, null,
        network === undefined ? null : { HUB_NETWORK: network });
}

// Operator config that mirrors the canonical registry exactly.
function canonicalCaps() {
    let caps = {};
    for (let [cap, entry] of Object.entries(CANONICAL)) {
        caps[cap] = { MIN_STAKE: entry.MIN_STAKE };
    }
    return caps;
}

describe('XChainHub._assertCanonicalMinStakes', function () {

    let warnStub;
    beforeEach(function () { warnStub = sinon.stub(console, 'warn'); });
    afterEach(function () {
        warnStub.restore();
        delete process.env.XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT;
    });

    it('accepts the canonical thresholds on mainnet', function () {
        expect(() => makeHub('mainnet')._assertCanonicalMinStakes(canonicalCaps())).to.not.throw();
    });

    it('accepts numerically-equal spellings ("5000" == "5000.00000000")', function () {
        let caps = canonicalCaps();
        caps.cross_chain.MIN_STAKE = '5000';
        expect(() => makeHub('mainnet')._assertCanonicalMinStakes(caps)).to.not.throw();
    });

    it('refuses a divergent floor on mainnet (the ValidatorService 1000-vs-5000 footgun)', function () {
        let caps = canonicalCaps();
        caps.cross_chain.MIN_STAKE = '1000.00000000';
        let err = null;
        try { makeHub('mainnet')._assertCanonicalMinStakes(caps); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('MIN_STAKE_MISMATCH');
        expect(err.message).to.include('cross_chain');
        expect(err.message).to.include('5000.00000000');
    });

    it('refuses on testnet too', function () {
        let caps = canonicalCaps();
        caps.price.MIN_STAKE = '1';
        expect(() => makeHub('testnet')._assertCanonicalMinStakes(caps))
            .to.throw().with.property('code', 'MIN_STAKE_MISMATCH');
    });

    it('treats a missing MIN_STAKE key as a mismatch (would seed a genesis floor of 0)', function () {
        let caps = canonicalCaps();
        delete caps.attestation.MIN_STAKE;
        let err = null;
        try { makeHub('mainnet')._assertCanonicalMinStakes(caps); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('MIN_STAKE_MISMATCH');
        expect(err.message).to.include('attestation');
    });

    it('treats a non-numeric MIN_STAKE as a mismatch', function () {
        let caps = canonicalCaps();
        caps.price.MIN_STAKE = 'lots';
        expect(() => makeHub('mainnet')._assertCanonicalMinStakes(caps))
            .to.throw().with.property('code', 'MIN_STAKE_MISMATCH');
    });

    it('warns instead of throwing on regtest (venues run deliberately low floors)', function () {
        let caps = canonicalCaps();
        caps.cross_chain.MIN_STAKE = '1000.00000000';
        expect(() => makeHub('regtest')._assertCanonicalMinStakes(caps)).to.not.throw();
        expect(warnStub.calledWithMatch(/MIN_STAKE mismatch/)).to.equal(true);
    });

    it('warns instead of throwing in standalone mode (no HUB_NETWORK)', function () {
        let caps = canonicalCaps();
        caps.cross_chain.MIN_STAKE = '1000.00000000';
        expect(() => makeHub(undefined)._assertCanonicalMinStakes(caps)).to.not.throw();
        expect(warnStub.calledWithMatch(/MIN_STAKE mismatch/)).to.equal(true);
    });

    it('XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT=1 bypasses loudly, even on mainnet', function () {
        process.env.XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT = '1';
        let caps = canonicalCaps();
        caps.cross_chain.MIN_STAKE = '1000.00000000';
        expect(() => makeHub('mainnet')._assertCanonicalMinStakes(caps)).to.not.throw();
        expect(warnStub.calledWithMatch(/XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT/)).to.equal(true);
    });

    it('ignores capabilities unknown to the canonical registry (warn only)', function () {
        let caps = canonicalCaps();
        caps.custom_thing = { MIN_STAKE: '7' };
        expect(() => makeHub('mainnet')._assertCanonicalMinStakes(caps)).to.not.throw();
        expect(warnStub.calledWithMatch(/custom_thing/)).to.equal(true);
    });

    it('is a no-op for a missing/invalid CAPABILITIES object', function () {
        let hub = makeHub('mainnet');
        expect(() => hub._assertCanonicalMinStakes(null)).to.not.throw();
        expect(() => hub._assertCanonicalMinStakes([])).to.not.throw();
        expect(() => hub._assertCanonicalMinStakes('nope')).to.not.throw();
    });

    // A capability ABSENT from the file was never visited by the
    // per-configured-capability loop, so the hub started, logged one warning,
    // and then failed EVERY consensus round for it (min_stake_unconfigured).
    describe('a canonical capability missing from the config entirely', function () {

        function without(cap) {
            let caps = canonicalCaps();
            delete caps[cap];
            return caps;
        }

        it('refuses at startup on mainnet, naming the capability and that consensus cannot run', function () {
            let err = null;
            try { makeHub('mainnet')._assertCanonicalMinStakes(without('full_node')); } catch (e) { err = e; }
            expect(err).to.not.equal(null);
            expect(err.code).to.equal('CAPABILITY_UNCONFIGURED');
            expect(err.capabilities).to.deep.equal(['full_node']);
            expect(err.message).to.include('CONSENSUS CANNOT RUN');
            expect(err.message).to.include('full_node');
            expect(err.message).to.include('min_stake_unconfigured');
            // The canonical value the operator has to paste in.
            expect(err.message).to.include(CANONICAL.full_node.MIN_STAKE);
        });

        it('refuses on testnet too', function () {
            expect(() => makeHub('testnet')._assertCanonicalMinStakes(without('attestation')))
                .to.throw().with.property('code', 'CAPABILITY_UNCONFIGURED');
        });

        // Unlike a low threshold (deliberate on a test venue), a hole is never
        // deliberate and breaks every round on regtest exactly as it does on mainnet.
        it('refuses on regtest, where a low floor would only warn', function () {
            expect(() => makeHub('regtest')._assertCanonicalMinStakes(without('full_node')))
                .to.throw().with.property('code', 'CAPABILITY_UNCONFIGURED');
        });

        it('refuses in standalone mode (no HUB_NETWORK)', function () {
            expect(() => makeHub(undefined)._assertCanonicalMinStakes(without('price')))
                .to.throw().with.property('code', 'CAPABILITY_UNCONFIGURED');
        });

        it('names every missing capability in one message', function () {
            let caps = canonicalCaps();
            delete caps.full_node;
            delete caps.attestation;
            let err = null;
            try { makeHub('mainnet')._assertCanonicalMinStakes(caps); } catch (e) { err = e; }
            expect(err.capabilities.sort()).to.deep.equal(['attestation', 'full_node']);
            expect(err.message).to.include('attestation');
            expect(err.message).to.include('full_node');
        });

        it('refuses an empty CAPABILITIES object (a config that declares none)', function () {
            expect(() => makeHub('mainnet')._assertCanonicalMinStakes({}))
                .to.throw().with.property('code', 'CAPABILITY_UNCONFIGURED');
        });

        // The snapshot is federation-wide, so a hub that opts out of SERVING a
        // capability still has to resolve its threshold for every round its peers run.
        it('is not excused by DISABLED_CAPABILITIES', function () {
            let hub = makeHub('mainnet');
            hub.p2pConfig = { DISABLED_CAPABILITIES: ['full_node'] };
            expect(() => hub._assertCanonicalMinStakes(without('full_node')))
                .to.throw().with.property('code', 'CAPABILITY_UNCONFIGURED');
        });

        it('surfaces threshold mismatches alongside the refusal', function () {
            let caps = without('full_node');
            caps.cross_chain.MIN_STAKE = '1000.00000000';
            expect(() => makeHub('mainnet')._assertCanonicalMinStakes(caps)).to.throw();
            expect(warnStub.calledWithMatch(/cross_chain/)).to.equal(true);
        });

        it('XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT=1 bypasses the refusal too', function () {
            process.env.XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT = '1';
            expect(() => makeHub('mainnet')._assertCanonicalMinStakes(without('full_node'))).to.not.throw();
        });

        it('accepts a canonical config with every capability present', function () {
            expect(() => makeHub('regtest')._assertCanonicalMinStakes(canonicalCaps())).to.not.throw();
        });
    });

    describe('_loadCapabilityConfigFile integration', function () {

        let tmpPath;
        afterEach(function () { if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} } });

        function writeConfig(caps) {
            tmpPath = path.join(os.tmpdir(), 'xc092_caps_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.json');
            fs.writeFileSync(tmpPath, JSON.stringify({ CAPABILITIES: caps }));
            return tmpPath;
        }

        it('refuses a divergent config file on mainnet WITHOUT merging it', function () {
            let hub = makeHub('mainnet');
            let caps = canonicalCaps();
            caps.cross_chain.MIN_STAKE = '1000.00000000';
            expect(() => hub._loadCapabilityConfigFile(writeConfig(caps)))
                .to.throw().with.property('code', 'MIN_STAKE_MISMATCH');
            // The refused config must not have leaked into p2pConfig (hot-reload
            // keeps serving the previous validated thresholds).
            expect((hub.p2pConfig && hub.p2pConfig.CAPABILITIES) || undefined).to.equal(undefined);
        });

        it('refuses a config file with a missing capability WITHOUT merging it', function () {
            let hub = makeHub('mainnet');
            let caps = canonicalCaps();
            delete caps.full_node;
            expect(() => hub._loadCapabilityConfigFile(writeConfig(caps)))
                .to.throw().with.property('code', 'CAPABILITY_UNCONFIGURED');
            expect((hub.p2pConfig && hub.p2pConfig.CAPABILITIES) || undefined).to.equal(undefined);
        });

        // The refusal has to reach the boot path, not be swallowed by the
        // warn-and-degrade branch that read/parse errors take.
        it('halts startCapabilities instead of booting into a hub that fails every round', async function () {
            let hub = makeHub('regtest');
            let caps = canonicalCaps();
            delete caps.full_node;
            let p = writeConfig(caps);
            let err = null;
            try { await hub.startCapabilities(p); } catch (e) { err = e; }
            expect(err).to.not.equal(null);
            expect(err.code).to.equal('CAPABILITY_UNCONFIGURED');
            // Boot stopped before the registry existed, so nothing can serve a
            // snapshot at a locally-invented threshold.
            expect(hub.capabilityRegistry || null).to.equal(null);
        });

        it('loads a canonical config file on mainnet', function () {
            let logStub = sinon.stub(console, 'log');
            try {
                let hub = makeHub('mainnet');
                hub._loadCapabilityConfigFile(writeConfig(canonicalCaps()));
                expect(hub.p2pConfig.CAPABILITIES.cross_chain.MIN_STAKE)
                    .to.equal(CANONICAL.cross_chain.MIN_STAKE);
            } finally { logStub.restore(); }
        });
    });
});
