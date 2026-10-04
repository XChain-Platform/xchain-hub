'use strict';
const EventEmitter = require('events');
const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');
const PeerManager = require('../../../../src/peers/manager.js');
const { PEER, VALIDATOR_ADDR, peerManager, priceDb, makeCatchup } = require('./helpers/peer_catchup_harness.js');
const CONTENT_READS = {
    price_snapshots: ['findPriceSnapshotsForRound', [1], { round_number: 1, coin_pair: 'BTC/USD' }],
    oracle_prices: ['getOraclePrice', ['addr', 'DOGE', 2],
        { source_address: 'addr', source_chain: 'DOGE', action_index: 2 }],
    cross_chain_matches: ['getCrossChainMatchByMatchId', ['match'], { match_id: 'match' }],
    capability_snapshots: ['getCapabilitySnapshot', [3, 'oracle', 'key', 'source'],
        { snapshot_block: 3, capability: 'oracle', signing_pubkey: 'key', source: 'source' }],
    cross_chain_calls: ['getCrossChainCallByCallIdAndPhase', ['call', 'result'],
        { call_id: 'call', phase: 'result' }],
    state_checkpoints: ['getStateCheckpointByChainAndNetworkAndCheckpointSeq', ['BTC', 'testnet', 4],
        { chain: 'BTC', network: 'testnet', checkpoint_seq: 4 }],
    anchor_reward_attestations: ['getAnchorRewardAttestation',
        ['DOGE', 'testnet', 'anchor_DOGE', 5, 6, 'publisher'],
        { chain: 'DOGE', network: 'testnet', reward_type: 'anchor_DOGE', round_reference: 5,
            snapshot_block: 6, publisher: 'publisher' }],
    attestation_responses: ['getAttestationResponse', ['testnet', 'request', 7],
        { network: 'testnet', request_id: 'request', effective_time: 7 }],
    bridge_transfers: ['getBridgeTransferByTransferId', ['transfer'], { transfer_id: 'transfer' }],
    policy_snapshots: ['getPolicySnapshotAtSeq', ['testnet', 'BTC', 'TOKEN', 8],
        { network: 'testnet', origin_chain: 'BTC', tick: 'TOKEN', policy_seq: 8 }],
    list_snapshots: ['getListSnapshotAtSeq', ['testnet', 'LTC', 9, 10],
        { network: 'testnet', home_chain: 'LTC', home_list_index: 9, seq: 10 }]
};
function outboundHandshakePeerManager() {
    const sockets = [];
    class FakeWebSocket extends EventEmitter {
        constructor() { super(); sockets.push(this); }
    }
    Object.assign(FakeWebSocket, { OPEN: 1, '@noCallThru': true });
    const PeerConnections = proxyquire('../../../../src/peers/gossip/connections.js', {
        ws: FakeWebSocket
    });
    const identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    const pm = new PeerManager({
        P2P_VALIDATOR_ADDR: 'rValidator01', REQUIRE_SIGNATURES: true,
        P2P_MSG_DEDUP_TTL: 60000, P2P_RECONNECT_BASE: 2000
    }, null);
    const pubkey = identity.getPubkeyHex();
    pm.setValidatorPubkeys(new Map([[VALIDATOR_ADDR, pubkey]]));
    pm.setEffectiveSignerSet(new Set([pubkey.toLowerCase()]));
    PeerConnections.prototype.connectToPeer.call(pm, PEER);
    const ws = sockets[0];
    ws.readyState = FakeWebSocket.OPEN;
    ws.emit('open');
    const envelope = {
        id: 'handshake-1', type: 'TEST', sender: VALIDATOR_ADDR,
        timestamp: Date.now(), data: {}, sig_pubkey: pubkey
    };
    envelope.sig = identity.signEnvelope(envelope);
    pm.handleInbound(ws, JSON.stringify(envelope), PEER);
    return pm;
}
afterEach(function () { sinon.restore(); });
describe('hub DB peer catch-up paging', function () {
    it('pages to the end, assigns local ids, and flips the table caught up', async function () {
        const db = priceDb();
        const fetchPage = sinon.stub();
        fetchPage.onFirstCall().resolves({
            table: 'price_snapshots',
            rows: [{ id: 41, round_number: 7 }, { id: 44, round_number: 8 }]
        });
        fetchPage.onSecondCall().resolves({ table: 'price_snapshots', rows: [] });
        const catchup = makeCatchup({ db, fetchPage });
        await catchup.start();
        catchup.stop();
        expect(fetchPage.firstCall.args.slice(0, 4)).to.deep.equal([PEER, 'price_snapshots', 0, 2]);
        expect(fetchPage.secondCall.args[2]).to.equal(44);
        expect(db.setFinalizedPriceSnapshotRound.callCount).to.equal(2);
        expect(db.setFinalizedPriceSnapshotRound.firstCall.args[0]).to.equal(7);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
        expect(catchup.isCaughtUp()).to.equal(true);
    });
    it('skips a held content key without relying on writer affectedRows', async function () {
        const db = priceDb();
        db.findPriceSnapshotsForRound.resolves([{ round_number: 3, coin_pair: 'BTC/USD' }]);
        const catchup = makeCatchup({
            db,
            fetchPage: sinon.stub().resolves({
                table: 'price_snapshots', rows: [{ id: 9, round_number: 3, coin_pair: 'BTC/USD' }]
            })
        });
        await catchup.start();
        catchup.stop();
        expect(db.findPriceSnapshotsForRound.calledOnceWithExactly(3)).to.equal(true);
        expect(db.setFinalizedPriceSnapshotRound.called).to.equal(false);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });
});
describe('hub DB peer catch-up verification', function () {
    it('accepts an oracle row from an authenticated connected signer peer', async function () {
        const storeRow = sinon.stub().resolves();
        const verifier = sinon.stub().callsFake(async (row, context) => ({
            ok: context.authenticated === true && context.signerSetPeer === true
        }));
        const catchup = makeCatchup({
            tables: ['oracle_prices'],
            getVerifier: () => verifier,
            hasRow: sinon.stub().resolves(false),
            storeRow,
            fetchPage: sinon.stub().resolves({
                table: 'oracle_prices', rows: [{ id: 3, source_address: 'oracle-address' }]
            })
        });
        await catchup.start();
        catchup.stop();
        expect(verifier.calledOnce).to.equal(true);
        expect(verifier.firstCall.args[1]).to.include({
            table: 'oracle_prices', peer: PEER, authenticated: true, signerSetPeer: true
        });
        expect(storeRow.calledOnceWithExactly(
            'oracle_prices', { source_address: 'oracle-address' })).to.equal(true);
        expect(catchup.isCaughtUp()).to.equal(true);
    });
    it('logs a verifier refusal and does not insert the row', async function () {
        const logger = { warn: sinon.stub(), error: sinon.stub() };
        const db = priceDb();
        const catchup = makeCatchup({
            db,
            logger,
            getVerifier: () => async () => ({ ok: false, reason: 'bad quorum' }),
            fetchPage: sinon.stub().resolves({
                table: 'price_snapshots', rows: [{ id: 12, round_number: 4 }]
            })
        });
        await catchup.start();
        catchup.stop();
        expect(db.setFinalizedPriceSnapshotRound.called).to.equal(false);
        expect(logger.warn.calledWithMatch('bad quorum')).to.equal(true);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });
    it('skips an unregistered table and leaves it not caught up', async function () {
        const fetchPage = sinon.stub();
        const catchup = makeCatchup({ getVerifier: () => undefined, fetchPage });
        await catchup.start();
        catchup.stop();
        expect(fetchPage.called).to.equal(false);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
        expect(catchup.isCaughtUp()).to.equal(false);
    });
});
describe('hub DB peer catch-up persistence dispatch', function () {
    it('uses the named content-key writer for every mirrored table', async function () {
        const methodByTable = {
            price_snapshots: 'setFinalizedPriceSnapshotRound',
            oracle_prices: 'setOraclePriceByGeneration',
            cross_chain_matches: 'createCrossChainMatch',
            capability_snapshots: 'createCapabilitySnapshots',
            cross_chain_calls: 'setCrossChainCallFinalized',
            state_checkpoints: 'createStateCheckpoint',
            anchor_reward_attestations: 'createAnchorRewardAttestation',
            attestation_responses: 'createAttestationResponseMirrorRow',
            bridge_transfers: 'insertBridgeTransfer',
            policy_snapshots: 'insertPolicySnapshot',
            list_snapshots: 'insertListSnapshot'
        };
        const db = {};
        for (const method of Object.values(methodByTable)) db[method] = sinon.stub().resolves();
        for (const [table, method] of Object.entries(methodByTable)) {
            await HubDbPeerCatchup.storeVerifiedRow(db, table, {});
            expect(db[method].calledOnce, table).to.equal(true);
        }
    });
});
describe('hub DB peer catch-up local ids', function () {
    it('removes the peer wire id before direct row-object writers receive a row', async function () {
        const methodByTable = {
            oracle_prices: 'setOraclePriceByGeneration',
            cross_chain_matches: 'createCrossChainMatch',
            capability_snapshots: 'createCapabilitySnapshots',
            cross_chain_calls: 'setCrossChainCallFinalized',
            attestation_responses: 'createAttestationResponseMirrorRow',
            bridge_transfers: 'insertBridgeTransfer',
            policy_snapshots: 'insertPolicySnapshot',
            list_snapshots: 'insertListSnapshot'
        };
        for (const [table, method] of Object.entries(methodByTable)) {
            const db = { [method]: sinon.stub().resolves() };
            const peerRow = { id: 91, marker: 'content' };
            await HubDbPeerCatchup.storeVerifiedRow(db, table, peerRow);
            const argument = table === 'capability_snapshots'
                ? db[method].firstCall.args[0][0] : db[method].firstCall.args[0];
            expect(argument, table).to.deep.equal({ marker: 'content' });
            expect(peerRow, table).to.deep.equal({ id: 91, marker: 'content' });
        }
    });
    it('removes the wire id before an injected persistence writer receives a row', async function () {
        const storeRow = sinon.stub().resolves();
        const catchup = makeCatchup({
            hasRow: sinon.stub().resolves(false),
            storeRow,
            fetchPage: sinon.stub().resolves({
                table: 'price_snapshots', rows: [{ id: 77, round_number: 5 }]
            })
        });
        await catchup.start();
        catchup.stop();
        expect(storeRow.calledOnce).to.equal(true);
        expect(storeRow.firstCall.args).to.deep.equal([
            'price_snapshots', { round_number: 5 }
        ]);
    });
});
describe('hub DB peer catch-up content-key lookups', function () {
    it('checks the schema content key for every mirrored table', async function () {
        for (const [table, [method, args, row]] of Object.entries(CONTENT_READS)) {
            const held = table === 'price_snapshots' ? [row] : [{}];
            const db = { [method]: sinon.stub().resolves(held) };
            expect(await HubDbPeerCatchup.rowAlreadyHeld(db, table, row), table).to.equal(true);
            expect(db[method].calledOnceWithExactly(...args), table).to.equal(true);
        }
    });
});
describe('hub DB peer catch-up peer resolution', function () {
    it('learns an outbound signer binding at handshake and catches up every table', async function () {
        const tables = Object.keys(CONTENT_READS);
        const fetchPage = sinon.stub().callsFake(async (peer, table) => ({ table, rows: [] }));
        const pm = outboundHandshakePeerManager();
        const peer = pm.peers.get(PEER);
        expect(peer).to.include({ feedUrl: PEER, validatorAddr: VALIDATOR_ADDR });
        const catchup = makeCatchup({
            peerManager: pm, tables, getVerifier: () => async () => true, fetchPage
        });
        await catchup.start(); catchup.stop();
        expect(fetchPage.callCount).to.equal(tables.length);
        for (const call of fetchPage.getCalls()) expect(call.args[0]).to.equal(PEER);
        expect(catchup.caughtUpState()).to.deep.equal(Object.fromEntries(
            tables.map(table => [table, true])));
        expect(catchup.isCaughtUp()).to.equal(true);
    });
    it('skips and throttles a signer peer known only by validator address', async function () {
        const logger = { warn: sinon.stub(), error: sinon.stub() };
        const pm = peerManager(false);
        pm.peers.set(VALIDATOR_ADDR, { state: 'open', inbound: true,
            feedUrl: null, validatorAddr: VALIDATOR_ADDR });
        const fetchPage = sinon.stub();
        const catchup = makeCatchup({ peerManager: pm, logger, fetchPage });
        await catchup.start(); await catchup.schedule(); catchup.stop();
        expect(fetchPage.called).to.equal(false);
        expect(catchup.allCaughtUp()).to.equal(false);
        expect(logger.warn.calledOnce).to.equal(true);
        expect(logger.warn.firstCall.args[0]).to.include(VALIDATOR_ADDR)
            .and.include('no fetchable feed URL');
        // No usable peer, so admission is not gated on catch-up (the v0.21.3 behaviour).
        expect(catchup.isCaughtUp()).to.equal(true);
        expect(logger.warn.calledWithMatch('admission is not gated')).to.equal(true);
    });
    it('reports caught up, ungated, when no signer peer is connected at all', async function () {
        const logger = { warn: sinon.stub(), error: sinon.stub() };
        const catchup = makeCatchup({ peerManager: peerManager(false), logger, fetchPage: sinon.stub() });
        await catchup.start(); catchup.stop();
        expect(catchup.allCaughtUp()).to.equal(false);
        expect(catchup.isCaughtUp()).to.equal(true);
    });
    it('still gates admission while a usable signer peer has not caught every table up', async function () {
        const catchup = makeCatchup({ getVerifier: () => undefined, fetchPage: sinon.stub() });
        await catchup.start(); catchup.stop();
        expect(catchup.lastUsablePeerCount).to.be.above(0);
        expect(catchup.isCaughtUp()).to.equal(false);
    });
});
describe('hub DB peer catch-up peer eligibility', function () {
    it('leaves every table not caught up and logs when no signer peer is reachable', async function () {
        const logger = { warn: sinon.stub(), error: sinon.stub() };
        const fetchPage = sinon.stub();
        const catchup = makeCatchup({
            peerManager: peerManager(false),
            tables: ['price_snapshots', 'oracle_prices'],
            logger,
            fetchPage
        });
        await catchup.start();
        catchup.warnIfNoPeer();
        catchup.stop();
        expect(fetchPage.called).to.equal(false);
        expect(catchup.caughtUpState()).to.deep.equal({ price_snapshots: false, oracle_prices: false });
        expect(logger.warn.calledWithMatch('no connected signer-set peer')).to.equal(true);
        expect(logger.warn.callCount).to.equal(1);
    });
    it('does not fetch from a connected peer outside the effective signer set and registry', async function () {
        const pm = peerManager(true);
        pm.effectiveSignerSet = new Set(['bb'.repeat(32)]);
        pm.registryHasPubkey = sinon.stub().returns(false);
        const fetchPage = sinon.stub();
        const catchup = makeCatchup({ peerManager: pm, fetchPage });
        await catchup.start();
        catchup.stop();
        expect(fetchPage.called).to.equal(false);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
    });
    it('fetches from a registry peer when the effective signer set is empty', async function () {
        const pm = peerManager(true);
        pm.effectiveSignerSet = new Set();
        const fetchPage = sinon.stub().resolves({ table: 'price_snapshots', rows: [] });
        const catchup = makeCatchup({ peerManager: pm, fetchPage });
        await catchup.start();
        catchup.stop();
        expect(fetchPage.calledOnceWithExactly(PEER, 'price_snapshots', 0, 2)).to.equal(true);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });
});
