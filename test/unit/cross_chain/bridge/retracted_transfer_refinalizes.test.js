'use strict';

const assert = require('assert');
const sinon = require('sinon');
const CrossChainDexConsensus = require('../../../../src/cross_chain/dex_consensus');
const ValidatorIdentity = require('../../../../src/validators/identity');

const TYPES = {
    PROPOSE: 'XBRIDGE_TRANSFER_PROPOSE', PREPARE: 'XBRIDGE_TRANSFER_PREPARE',
    COMMIT: 'XBRIDGE_TRANSFER_COMMIT', VIEW_CHANGE: 'XBRIDGE_TRANSFER_VIEW_CHANGE',
    NEW_VIEW: 'XBRIDGE_TRANSFER_NEW_VIEW', FINAL_SYNC: 'XBRIDGE_TRANSFER_FINAL_SYNC'
};

function transferRow(transferId, snapshotBlock, effectiveTime){
    return {
        transfer_id: transferId, snapshot_block: snapshotBlock, network: 'regtest',
        src_chain: 'BTC', src_action_index: 2057, src_address: 'source',
        dest_chain: 'DOGE', dest_address: 'destination', tick: 'RETH',
        decimals: 8, amount: '1.00000000', effective_time: effectiveTime
    };
}

function canonicalTransfer(row, view){
    return ['XBRIDGE', row.transfer_id, view, row.snapshot_block, row.effective_time].join('|');
}

function buildMember(bus, index){
    const identity = new ValidatorIdentity(String(index + 11).repeat(32).slice(0, 64));
    const member = { identity, pubkey: identity.getPubkeyHex().toLowerCase(), finalized: [] };
    const peerManager = {
        on(event, handler){ if(event === 'message') member.handler = handler; },
        removeListener(){ member.handler = null; },
        broadcast(type, data){
            const envelope = { type, sender: member.pubkey, data };
            if(bus.holdCommits && type === TYPES.COMMIT){
                bus.delayedCommits.push(envelope);
                return;
            }
            for(const peer of bus.members)
                if(peer !== member && peer.handler) peer.handler(envelope);
        }
    };
    const engine = {
        hub: { p2pConfig: {} }, peerManager, identity, capSnapshot: null,
        canonicalMatch: canonicalTransfer,
        persistCapabilitySnapshot: async () => 7,
        resolveCapabilityValidators: async () => validators(bus),
        validateProposedMatch: async () => true
    };
    member.consensus = new CrossChainDexConsensus(engine, {
        idField: 'transfer_id', messageTypes: TYPES,
        controlTags: { vc: 'XBRIDGEVC', nv: 'XBRIDGENV' }
    });
    member.consensus.on('match:finalized', event => member.finalized.push(event));
    return member;
}

function validators(bus){
    return bus.members.map(member => ({
        pubkey: member.pubkey, source: 'source:' + member.pubkey, weight: '1', amount: '1'
    }));
}

async function proposeEverywhere(bus, transferId, snapshotBlock, effectiveTime){
    const snapshot = { validators: validators(bus), count: bus.members.length };
    for(let index = 0; index < bus.members.length; index++){
        const row = transferRow(transferId, snapshotBlock + index, effectiveTime + index);
        await bus.members[index].consensus.propose(transferId, { row, snapshot });
    }
}

async function flushConsensus(){
    for(let pass = 0; pass < 30; pass++) await Promise.resolve();
}

function deliverDelayedCommits(bus){
    const delayed = bus.delayedCommits.splice(0);
    for(const envelope of delayed)
        for(const member of bus.members)
            if(member.pubkey !== envelope.sender && member.handler) member.handler(envelope);
}

function applySignedRetraction(bus, transferId){
    for(const member of bus.members)
        assert.strictEqual(member.consensus.forgetFinalized(transferId), true);
}

describe('retracted bridge transfer consensus', function(){
    const buses = [];
    let clock;

    afterEach(async function(){
        for(const bus of buses.splice(0))
            for(const member of bus.members) await member.consensus.stop();
        if(clock){ clock.restore(); clock = null; }
    });

    it('finalizes a transfer re-formed after a signed retraction exactly once', async function(){
        clock = sinon.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const bus = { members: [], holdCommits: false, delayedCommits: [] };
        buses.push(bus);
        for(let index = 0; index < 7; index++) bus.members.push(buildMember(bus, index));
        for(const member of bus.members) await member.consensus.start();
        const transferId = '7c'.repeat(32);

        await proposeEverywhere(bus, transferId, 43870, 1800000000);
        await flushConsensus();
        assert.ok(bus.members.every(member => member.finalized.length === 1));

        applySignedRetraction(bus, transferId);
        bus.holdCommits = true;
        await proposeEverywhere(bus, transferId, 43884, 1800000300);
        await flushConsensus();
        assert.ok(bus.members.every(member => member.consensus.pending.has(transferId)));

        await clock.tickAsync(10001);
        bus.holdCommits = false;
        deliverDelayedCommits(bus);
        await flushConsensus();

        assert.deepStrictEqual(bus.members.map(member => member.finalized.length), Array(7).fill(2));
        await proposeEverywhere(bus, transferId, 43884, 1800000300);
        assert.deepStrictEqual(bus.members.map(member => member.finalized.length), Array(7).fill(2));
    });
});
