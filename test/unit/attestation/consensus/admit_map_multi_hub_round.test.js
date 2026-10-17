'use strict';

const { expect }           = require('chai');
const AttestationConsensus = require('../../../../src/attestation/consensus.js');
const ValidatorIdentity    = require('../../../../src/validators/identity.js');

const RID      = 'ef'.repeat(16);
const BODY     = Buffer.from('shared admission-map winner');
const META     = 'source=test';
const BLOCK    = 200000;
const PROVIDER = 'http_get';

function pub(identity){
    return identity.getPubkeyHex().toLowerCase();
}

function roundState(nodes, node){
    return {
        request: { request_id: RID, block_index: BLOCK, deadline_block: BLOCK + 100 },
        providerId: PROVIDER,
        redundancy: nodes.length,
        snapshot: { validators: nodes.map(n => ({ pubkey: n.pubkey })) },
        responsible: nodes.map(n => ({ pubkey: n.pubkey })),
        leaderPubkey: nodes[0].pubkey,
        role: node === nodes[0] ? 'leader' : 'follower',
        myProposal: { body: BODY, meta: META, status: 'ok' },
        pinnedConsensusStrategy: 'byte_equality',
        pinnedMaxResponseBytes: 65536
    };
}

function makeFederation(tips){
    const bus = { queue: [] };
    const nodes = tips.map((tip, index) => {
        const identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const peerManager = {
            on: () => {},
            removeListener: () => {},
            broadcast: (type, data) => bus.queue.push({ from: index, type, data: JSON.parse(JSON.stringify(data)) })
        };
        const hub = {
            network: 'testnet',
            db: { doQuery: async () => [] },
            p2pConfig: {},
            getPeerManager: () => peerManager,
            getIdentity: () => identity,
            resolveAdmitBlocks: async () => ({ BTC: tip + 4 }),
            resolveAdmissionTips: async () => ({ BTC: tip })
        };
        const registry = {
            getDef: () => ({ max_response_bytes: 65536, consensus_strategy: 'byte_equality' }),
            getModule: () => ({ agree: proposals => proposals[0] || null })
        };
        const engine = new AttestationConsensus(hub, registry);
        engine.isMirrorEra = () => false;
        return { engine, identity, pubkey: pub(identity), finalized: [] };
    });
    for(const node of nodes)
        node.engine.on('request:finalized', payload => node.finalized.push(payload));

    bus.drain = async () => {
        for(let pass = 0; pass < 100; pass++){
            while(bus.queue.length){
                const message = bus.queue.shift();
                for(let i = 0; i < nodes.length; i++){
                    if(i === message.from) continue;
                    await Promise.resolve(nodes[i].engine.handleMessage({ type: message.type, data: message.data }));
                }
            }
            await new Promise(resolve => setImmediate(resolve));
            if(bus.queue.length === 0) return;
        }
        throw new Error('attestation bus did not settle');
    };
    return { bus, nodes };
}

function cleanup(nodes){
    for(const node of nodes){
        for(const pending of node.engine.pending.values())
            if(pending.timer) clearTimeout(pending.timer);
    }
}

describe('attestation admission map across a multi-hub round', function () {
    it('converges divergent tips on the elected leader map and finalizes verifiable signatures', async function () {
        const { bus, nodes } = makeFederation([1000, 1001, 1002]);
        try {
            for(const node of nodes) await node.engine.propose(RID, roundState(nodes, node));

            expect(nodes.map(n => n.engine.pending.get(RID).admitBlocks))
                .to.deep.equal([{ BTC: 1004 }, { BTC: 1005 }, { BTC: 1006 }]);
            const proposes = bus.queue.filter(message => message.type === 'ATTEST_PROPOSE');
            expect(proposes.map(message => message.data.admit_blocks)).to.deep.equal(['BTC:1004', 'BTC:1005', 'BTC:1006']);

            await bus.drain();

            for(const node of nodes){
                const pending = node.engine.pending.get(RID);
                expect(pending.admitBlocks).to.deep.equal({ BTC: 1004 });
                expect(node.finalized).to.have.length(1);
                expect(node.finalized[0].admitBlocks).to.deep.equal({ BTC: 1004 });
                expect(node.finalized[0].signatures).to.have.length(3);
                const canonical = node.engine.buildCanonical(RID, PROVIDER, BODY, 'ok', META, BLOCK, null, { BTC: 1004 });
                for(const signed of node.finalized[0].signatures)
                    expect(ValidatorIdentity.verify(canonical.toString('utf8'), signed.sig, signed.pubkey)).to.equal(true);
            }
        } finally {
            cleanup(nodes);
        }
    });

    it('refuses a peer proposal whose admission map is absent after activation', async function () {
        const { bus, nodes } = makeFederation([1000, 1001]);
        try {
            for(const node of nodes) await node.engine.propose(RID, roundState(nodes, node));
            const proposal = bus.queue.find(message => message.type === 'ATTEST_PROPOSE' && message.from === 0);
            delete proposal.data.admit_blocks;
            await Promise.resolve(nodes[1].engine.handleMessage({ type: proposal.type, data: proposal.data }));
            expect(nodes[1].engine.pending.get(RID).proposals.has(nodes[0].pubkey)).to.equal(false);
        } finally {
            cleanup(nodes);
        }
    });
});

describe('attestation admission map on COMMIT', function () {
    it('refuses a bounded COMMIT map that differs from the settled leader map', async function () {
        const { nodes } = makeFederation([1000, 1001, 1002]);
        try {
            const sender = nodes[1];
            const target = nodes[2];
            await target.engine.propose(RID, roundState(nodes, target));
            const pending = target.engine.pending.get(RID);
            pending.winner = { body: BODY, meta: META };
            pending.admitBlocks = { BTC: 1004 };

            const canonical = target.engine.buildCanonical(
                RID, PROVIDER, BODY, 'ok', META, BLOCK, null, pending.admitBlocks);
            const envelope = { type: 'ATTEST_COMMIT', data: {
                requestId: RID,
                sig_pubkey: sender.pubkey,
                sig: sender.identity.sign(canonical.toString('utf8')),
                admit_blocks: 'BTC:1005'
            } };
            expect(await target.engine.readWireAdmitBlocks(pending, envelope.data))
                .to.deep.equal({ ok: true, admitBlocks: { BTC: 1005 } });
            expect(ValidatorIdentity.verify(canonical.toString('utf8'), envelope.data.sig, sender.pubkey))
                .to.equal(true);

            await target.engine.handleMessage(envelope);

            expect(pending.commits.has(sender.pubkey)).to.equal(false);
            expect(pending.signatures.has(sender.pubkey)).to.equal(false);
        } finally {
            cleanup(nodes);
        }
    });
});
