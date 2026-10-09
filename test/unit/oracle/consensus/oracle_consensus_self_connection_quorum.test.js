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

const { expect } = require('chai');
const PeerManager = require('../../../../src/peers/manager.js');
const membership = require('../../../../src/oracle/consensus/membership.js');

describe('Oracle consensus self-connection quorum', function () {
    it('does not count a self-identified connection toward standalone quorum', function () {
        const self = 'ws://listener.example:10001';
        const peerManager = {
            validatorAddr: self,
            getQuorumPeerStatus: () => [{
                addr: 'ws://seed-alias.example:10001',
                validatorAddr: self,
                state: 'open',
                selfConnection: true
            }]
        };

        expect(membership.getQuorum.call({ validatorSet: [], peerManager })).to.equal(0);
    });

    it('does not dial a seed that resolves to its bound listener', async function () {
        let dialed = 0;
        const peerManager = {
            config: {
                HUB_NETWORK: 'mainnet',
                P2P_HOST: '127.0.0.1',
                P2P_PORT: 10001,
                SEED_NODES: ['ws://seed-alias.example:10001']
            },
            constructor: { bootstrapSeeds: () => [] },
            validatorAddr: 'ws://listener.example:10001',
            httpServer: { address: () => ({ address: '127.0.0.1', port: 10001 }) },
            running: true,
            seedLookup: async () => [{ address: '127.0.0.1', family: 4 }],
            isOwnListener: PeerManager.prototype.isOwnListener,
            connectToPeer: () => { dialed++; },
            recordPeer: () => {}
        };

        await PeerManager.prototype.dialSeedPeers.call(peerManager);

        expect(dialed).to.equal(0);
    });
});
