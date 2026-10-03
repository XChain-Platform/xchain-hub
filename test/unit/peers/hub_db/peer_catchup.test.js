'use strict';

const EventEmitter = require('events');
const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');

const PEER = 'ws://validator02.example:10002';
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

function peerManager(connected) {
    const pm = new EventEmitter();
    pm.peers = new Map();
    pm.validatorPubkeys = new Map([[PEER, 'aa'.repeat(32)]]);
    pm.effectiveSignerSet = new Set(['aa'.repeat(32)]);
    if (connected) pm.peers.set(PEER, { state: 'open' });
    return pm;
}

function priceDb() {
    return {
        findPriceSnapshotsForRound: sinon.stub().resolves([]),
        setFinalizedPriceSnapshotRound: sinon.stub().resolves({ affectedRows: 1 })
    };
}

function makeCatchup(overrides) {
    const opts = overrides || {};
    return new HubDbPeerCatchup({
        db: opts.db || priceDb(),
        peerManager: opts.peerManager || peerManager(true),
        tables: opts.tables || ['price_snapshots'],
        getVerifier: opts.getVerifier || (() => async () => true),
        fetchPage: opts.fetchPage,
        hasRow: opts.hasRow,
        storeRow: opts.storeRow,
        pageSize: opts.pageSize || 2,
        warnIntervalMs: 60000,
        logger: opts.logger || { warn: sinon.stub(), error: sinon.stub() }
    });
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

    it('does not fetch from a connected peer outside the effective signer set', async function () {
        const pm = peerManager(true);
        pm.effectiveSignerSet = new Set(['bb'.repeat(32)]);
        const fetchPage = sinon.stub();
        const catchup = makeCatchup({ peerManager: pm, fetchPage });

        await catchup.start();
        catchup.stop();

        expect(fetchPage.called).to.equal(false);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
    });
});

describe('hub DB peer catch-up lifecycle', function () {
    it('runs again when a peer link reconnects', async function () {
        const pm = peerManager(true);
        const fetchPage = sinon.stub().resolves({ table: 'price_snapshots', rows: [] });
        const catchup = makeCatchup({ peerManager: pm, fetchPage });

        await catchup.start();
        pm.emit('peer:connect', PEER);
        await catchup.runningPromise;
        catchup.stop();

        expect(fetchPage.callCount).to.equal(2);
    });

    it('attaches at hub startup through the admission source hook', async function () {
        let options;
        const start = sinon.stub().resolves();
        function CatchupStub(opts) {
            options = opts;
            this.start = start;
        }
        const HubDbAdmissionSampling = proxyquire('../../../../src/peers/hub_db/admission_sampling.js', {
            './peer_catchup.js': CatchupStub
        });
        const sampler = new HubDbAdmissionSampling();
        const db = { doQuery: sinon.stub() };
        const pm = peerManager(false);
        sampler.db = db;
        sampler.admissionSampleMs = 60000;

        expect(sampler.attachAdmissionSource({ peerManager: pm })).to.equal(true);
        await Promise.resolve();

        expect(start.calledOnce).to.equal(true);
        expect(options.db).to.equal(db);
        expect(options.peerManager).to.equal(pm);
    });
});
