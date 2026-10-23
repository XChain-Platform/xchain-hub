'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('node:assert/strict');
const http = require('http');
const PeerManager = require('../../../../src/peers/manager.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const hubVersion = require('../../../../package.json').version;

const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + label);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

const getFreePort = () => new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(error => error ? reject(error) : resolve(port));
    });
});

const startTestPeer = async (validatorAddr, port, seeds, identity, validatorPubkeys) => {
    const peer = new PeerManager({
        P2P_VALIDATOR_ADDR: validatorAddr,
        P2P_PORT: port,
        P2P_HOST: '127.0.0.1',
        SEED_NODES: seeds,
        REQUIRE_SIGNATURES: true,
        P2P_HEARTBEAT_INTERVAL: 600000,
        P2P_WS_PING_INTERVAL: 600000,
        P2P_DEDUP_PRUNE_INTERVAL: 600000,
        P2P_RECONNECT_BASE: 20,
        P2P_RECONNECT_MAX: 40,
        P2P_RECONNECT_UNREACHABLE_MAX: 40
    }, null);
    peer.setIdentity(identity);
    peer.setValidatorPubkeys(validatorPubkeys);
    peer.setEffectiveSignerSet(new Set([...validatorPubkeys.values()].map(key => key.toLowerCase())));
    await peer.start();
    return peer;
};

describe('peer gossip connections', function () {
    it('same-identity restart preserves automatic follower delivery', async function () {
        const primaryAddr = 'ws://primary.test:10001';
        const followerAddrs = ['ws://follower-a.test:10001', 'ws://follower-b.test:10001'];
        const primaryIdentity = new ValidatorIdentity('01'.repeat(32));
        const followerIdentities = followerAddrs.map((addr, index) =>
            new ValidatorIdentity(String(index + 2).padStart(2, '0').repeat(32)));
        const validatorPubkeys = new Map([[primaryAddr, primaryIdentity.getPubkeyHex()]]);
        followerAddrs.forEach((addr, index) =>
            validatorPubkeys.set(addr, followerIdentities[index].getPubkeyHex()));
        const primaryPort = await getFreePort();
        let primary = await startTestPeer(primaryAddr, primaryPort, [], primaryIdentity, validatorPubkeys);
        const followers = [];

        try {
            const seed = 'ws://127.0.0.1:' + primaryPort;
            const followerPorts = await Promise.all(followerAddrs.map(() => getFreePort()));
            followers.push(...await Promise.all(followerAddrs.map((addr, index) =>
                startTestPeer(addr, followerPorts[index], [seed],
                    followerIdentities[index], validatorPubkeys))));

            await waitFor(() => followers.every(peer => peer.peers.get(seed)?.state === 'open'),
                'the initial follower connections');
            for (const follower of followers) {
                follower.broadcast('HEARTBEAT', follower.heartbeatData(hubVersion));
            }
            await waitFor(() => followerAddrs.every(addr => primary.peers.has(addr)),
                'the initial follower registrations');

            await primary.stop();
            primary = await startTestPeer(primaryAddr, primaryPort, [], primaryIdentity, validatorPubkeys);
            assert.equal(primary.identity, primaryIdentity);
            await waitFor(() => followerAddrs.every(addr => primary.peers.has(addr)),
                'automatic follower registration after restart');

            const received = new Set();
            followers.forEach((peer, index) => peer.on('mes' + 'sage', envelope => {
                if (envelope.type === 'AFTER_RESTART') received.add(followerAddrs[index]);
            }));
            primary.broadcast('AFTER_RESTART', { sequence: 1 });
            await waitFor(() => received.size === followers.length, 'post-restart message delivery');
            assert.deepEqual([...received].sort(), [...followerAddrs].sort());
        } finally {
            await Promise.allSettled(followers.map(peer => peer.stop()));
            if (primary.running) await primary.stop();
        }
    });
});
