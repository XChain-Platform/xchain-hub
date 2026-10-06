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

const sinon        = require('sinon');
const { expect }   = require('chai');
const PeerManager  = require('../../../../src/peers/manager');
const { DB_METHODS } = require('../../../helpers/mockHub');

const SENDER  = 'ws://sender:10001';
const RELAY_A = 'ws://relay-a:10001';
const RELAY_B = 'ws://relay-b:10001';

function frame(id, sender) {
    return JSON.stringify({ id, type: 'T', sender, timestamp: Date.now(), data: {} });
}

function outboundPeer(feedUrl, validatorAddr) {
    return { ws: {}, inbound: false, state: 'open', lastSeen: 0, feedUrl, validatorAddr };
}

describe('PeerManager relayed gossip and feed URLs', function () {
    let pm;

    beforeEach(function () {
        pm = new PeerManager({
            P2P_VALIDATOR_ADDR: 'ws://self:10001',
            P2P_PORT: 0,
            P2P_HOST: '127.0.0.1',
            SEED_NODES: [],
            REQUIRE_SIGNATURES: false,
            P2P_MSG_DEDUP_TTL: 60000
        }, { ...DB_METHODS, doQuery: sinon.stub().resolves([]) });
        pm.peers.set(SENDER, { ws: {}, inbound: true, state: 'open', lastSeen: 0, feedUrl: null });
        pm.peers.set(RELAY_A, outboundPeer(RELAY_A, RELAY_A));
        pm.peers.set(RELAY_B, outboundPeer(RELAY_B, RELAY_B));
    });

    afterEach(function () {
        sinon.restore();
    });

    function relayed(id, relayAddr) {
        pm.handleInbound({ _peerAddr: relayAddr }, frame(id, SENDER), relayAddr);
    }

    it('does not give a relayed sender the relaying peer feed URL', function () {
        relayed('r1', RELAY_A);
        relayed('r2', RELAY_B);
        expect(pm.peers.get(SENDER).feedUrl).to.equal(null);
        expect(pm.validatorFeedUrls.has(SENDER)).to.equal(false);
    });

    it('emits no peer:connect for a message another peer relayed', function () {
        const connects = [];
        pm.on('peer:connect', a => connects.push(a));
        relayed('c1', RELAY_A);
        relayed('c2', RELAY_B);
        relayed('c3', RELAY_A);
        relayed('c4', RELAY_B);
        expect(connects).to.deep.equal([]);
    });

    it('still gives an inbound peer the feed URL of its own outbound connection', function () {
        pm.peers.set(SENDER + '/out', outboundPeer('http://sender-feed:10001', SENDER));
        const connects = [];
        pm.on('peer:connect', a => connects.push(a));
        pm.handleInbound({ _peerAddr: SENDER + '/out' }, frame('d1', SENDER), SENDER + '/out');
        expect(pm.peers.get(SENDER).feedUrl).to.equal('http://sender-feed:10001');
        expect(connects).to.deep.equal([SENDER]);
    });
});
