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
