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

const { expect }            = require('chai');
const StateAnchorPublisher  = require('../../src/StateAnchorPublisher');

// #1224: _resolveCapabilitySet's local capability_snapshots-table fallback must be
// gated to seeded/regtest stacks. On mainnet/testnet a null snapshot means THIS
// hub's indexer is down (CapabilitySnapshot returns null on any fetch/auth/echo
// failure), so resolving from per-hub-local rows while healthy peers resolve the
// on-chain snapshot forks the set bytes for the same (capability, block). It must
// fail closed off regtest, matching the sibling resolvers.
describe('StateAnchorPublisher._resolveCapabilitySet local-table gating (#1224)', () => {

    function buildPub(network) {
        let queried = { count: 0 };
        let hub = {
            db: { async doQuery() { queried.count++; return [
                { signing_pubkey: 'AA'.repeat(16), amount: '1', source: '' }
            ]; } },
            network,
            // Snapshot resolver returns null on both paths (indexer outage).
            capabilitySnapshot: { async getSnapshot() { return null; }, async getWeightSnapshot() { return null; } },
            getIdentity: () => null,
            getPeerManager: () => null,
            p2pConfig: {}
        };
        return { pub: new StateAnchorPublisher(hub), queried };
    }

    it('fails closed on mainnet when the snapshot resolver returns null (no local-table read)', async () => {
        let { pub, queried } = buildPub('mainnet');
        let threw = false;
        try { await pub._resolveCapabilitySet('cross_chain', 100); }
        catch (e) { threw = true; expect(e.message).to.match(/not a valid shared source off regtest/); }
        expect(threw).to.equal(true);
        expect(queried.count).to.equal(0);   // never touched the local table
    });

    it('fails closed on testnet when the snapshot resolver returns null', async () => {
        let { pub, queried } = buildPub('testnet');
        let threw = false;
        try { await pub._resolveCapabilitySet('cross_chain', 100); }
        catch (e) { threw = true; }
        expect(threw).to.equal(true);
        expect(queried.count).to.equal(0);
    });

    it('still uses the local-table fallback on regtest (seeded stack path unchanged)', async () => {
        let { pub, queried } = buildPub('regtest');
        let set = await pub._resolveCapabilitySet('cross_chain', 100);
        expect(queried.count).to.equal(1);
        expect(set).to.deep.equal([{ pubkey: 'aa'.repeat(16), amount: '1', source: '' }]);
    });
});
