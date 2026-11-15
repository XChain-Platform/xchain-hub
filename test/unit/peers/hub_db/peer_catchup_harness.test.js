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
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');
const { connectedSignerPeers } = HubDbPeerCatchup;
const { PEER, PEER_B, peerManager, makeCatchup } = require('./helpers/peer_catchup_harness.js');

describe('peer catch-up harness', () => {
    it('lists two connected signer peers in order when asked for two', () => {
        const peers = connectedSignerPeers(peerManager(true, { peers: 2 }));
        expect(peers.map(p => p.feedUrl)).to.deep.equal([PEER, PEER_B]);
    });

    it('keeps one signer peer by default', () => {
        expect(connectedSignerPeers(peerManager(true)).map(p => p.feedUrl)).to.deep.equal([PEER]);
        expect(connectedSignerPeers(peerManager(false, { peers: 2 }))).to.deep.equal([]);
    });

    it('leaves the class default page size when pageSize is passed as undefined', () => {
        expect(makeCatchup({ pageSize: undefined }).pageSize).to.equal(new HubDbPeerCatchup({}).pageSize);
        expect(makeCatchup({}).pageSize).to.equal(2);
    });
});
