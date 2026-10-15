'use strict';

// The remote-token pin in the admission era (remote_token_admission_activation, armed on regtest
// by XC_REMOTE_TOKEN_ADMISSION_REGTEST_ACTIVATION, which every case here sets): the stamp a leader puts on a row, the signed tail, the follower bound,
// the height watermark entry and the late-finalization refusal, and the byte match with the
// indexer canonical that verifies it.

const assert = require('node:assert');
const path = require('node:path');

const remote = require('../../../src/cross_chain/remote_token_snapshots.js');
const queries = require('../../../src/db/snapshots/remote_token_snapshots.js');
const CrossChainDexConsensus = require('../../../src/cross_chain/dex_consensus.js');
const { AdmissionHeightWatermark, ADMISSION_WATERMARK_TABLES } = require('../../../src/peers/hub_db/admission_height_watermark.js');
const ah = require('../../../src/lib/admission_height.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const SNAPSHOT_BLOCK = 840000;
const MAP = { BTC: 840004, DOGE: 5000004, LTC: 3000004 };
const offer = () => ({ action_index: 91, give_tick: 'ART', give_decimals: 0, give_owner: 'doge-owner', source: 'doge-owner' });
const row = (network) => remote.buildRemoteTokenSnapshot(network || 'regtest', SNAPSHOT_BLOCK, 'DOGE', offer());
const ARM = 'XC_REMOTE_TOKEN_ADMISSION_REGTEST_ACTIVATION';

// Arms the era for one describe's cases and clears it after each.
function armEra() {
    beforeEach(() => { process.env[ARM] = 'armed'; });
    afterEach(() => { delete process.env[ARM]; });
}

function engine(resolveAdmitBlocks) {
    const calls = [];
    return { calls, e: Object.assign({
        hub: { resolveAdmitBlocks: async (table, readSet) => { calls.push([table, readSet]); return resolveAdmitBlocks(); } }
    }, remote.enginePart) };
}

describe('remote-token admission era: stamp and signed bytes @regression', function () {
    armEra();

    it('stamps every chain from the hub admission tips before proposing', async function () {
        const r = row();
        const { e, calls } = engine(() => MAP);
        assert.strictEqual(await e.stampRemoteTokenAdmission(r), true);
        assert.deepStrictEqual(calls, [['remote_token_snapshots', ['BTC', 'DOGE', 'LTC']]]);
        assert.deepStrictEqual([r.admit_block_btc, r.admit_block_ltc, r.admit_block_doge], [840004, 3000004, 5000004]);
    });

    it('opens no round when a chain has no fresh admission tip', async function () {
        const r = row();
        const { e } = engine(() => null);
        assert.strictEqual(await e.stampRemoteTokenAdmission(r), false);
        assert.strictEqual(r.admit_block_btc, undefined);
    });

    it('stamps nothing below the era, on a regtest venue without the variable included', async function () {
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            if (network === 'regtest') delete process.env[ARM];
            const r = row(network);
            const { e, calls } = engine(() => MAP);
            assert.strictEqual(await e.stampRemoteTokenAdmission(r), true);
            assert.strictEqual(calls.length, 0);
            assert.strictEqual('admit_block_btc' in r, false);
        }
    });

    it('signs the admission map last and refuses a row in the era without one', function () {
        const r = Object.assign(row(), ah.admitBlocksToColumns(MAP));
        assert.strictEqual(remote.canonicalRemoteTokenSnapshot(r, 2),
            'XREMOTE|' + r.snapshot_id + '|2|regtest|DOGE|ART|0|doge-owner|91|840000|BTC:840004,DOGE:5000004,LTC:3000004');
        assert.throws(() => remote.canonicalRemoteTokenSnapshot(row(), 0), /carries no admission map/);
    });

    it('keeps the follower agreement on the leader map and refuses a row in the era without one', function () {
        const r = Object.assign(row(), ah.admitBlocksToColumns(MAP));
        assert.strictEqual(remote.remoteTokenProposalAgrees(r, offer()), true);
        assert.strictEqual(remote.remoteTokenProposalAgrees(row(), offer()), false);
        assert.strictEqual(remote.remoteTokenProposalAgrees(r, Object.assign(offer(), { give_decimals: 2 })), false);
    });

    it('stores the map, and explicit NULLs for a row that carries none', async function () {
        const seen = [];
        const db = Object.assign({ doQuery: async (sql, args) => { seen.push({ sql, args }); return { affectedRows: 1 }; } }, queries);
        await db.insertRemoteTokenSnapshot(Object.assign(row(), ah.admitBlocksToColumns(MAP), { validator_signatures: '[]' }), null);
        await db.insertRemoteTokenSnapshot(Object.assign(row('testnet'), { validator_signatures: '[]' }), null);
        const cols = seen[0].sql.match(/\(([^)]*)\) VALUES/)[1].split(', ');
        const at = (i, c) => seen[i].args[cols.indexOf(c)];
        assert.deepStrictEqual([at(0, 'admit_block_btc'), at(0, 'admit_block_ltc'), at(0, 'admit_block_doge')], [840004, 3000004, 5000004]);
        assert.deepStrictEqual([at(1, 'admit_block_btc'), at(1, 'admit_block_ltc'), at(1, 'admit_block_doge')], [null, null, null]);
    });
});

describe('remote-token admission era: follower bound and watermark @regression', function () {
    armEra();

    function follower(ownTips) {
        const adapter = remote.createRemoteTokenConsensus({}, function Fake(a) { this.adapter = a; }).adapter;
        return { engine: adapter, hub: { resolveAdmissionTips: async () => ownTips } };
    }

    it('signs a map inside its own per-chain bound and refuses one outside it', async function () {
        const tips = { BTC: 840000, DOGE: 5000000, LTC: 3000000 };
        const r = Object.assign(row(), ah.admitBlocksToColumns(MAP));
        assert.strictEqual(await CrossChainDexConsensus.prototype.admissionBoundHolds.call(follower(tips), r, r.snapshot_id), true);
        const far = Object.assign(row(), ah.admitBlocksToColumns(Object.assign({}, MAP, { BTC: 840100 })));
        assert.strictEqual(await CrossChainDexConsensus.prototype.admissionBoundHolds.call(follower(tips), far, far.snapshot_id), false);
        const partial = Object.assign(row(), ah.admitBlocksToColumns({ BTC: 840004 }));
        assert.strictEqual(await CrossChainDexConsensus.prototype.admissionBoundHolds.call(follower(tips), partial, partial.snapshot_id), false);
    });

    it('applies no bound below the era', async function () {
        const r = row('testnet');
        assert.strictEqual(remote.remoteTokenAdmissionScope(r), null);
        assert.strictEqual(await CrossChainDexConsensus.prototype.admissionBoundHolds.call(follower({}), r, r.snapshot_id), true);
    });

    it('publishes a remote_token_snapshots height on the xdex round window', function () {
        assert.deepStrictEqual(ADMISSION_WATERMARK_TABLES.remote_token_snapshots, { chains: null, round: 'xdex' });
        const w = new AdmissionHeightWatermark({ HUB_NETWORK: 'regtest' });
        w.observeTip('LTC', 3000000, 0);
        assert.strictEqual(w.heights(10 * 3600 * 1000).remote_token_snapshots.LTC, 2999999);
    });

    it('refuses to broadcast a late finalization below the claimed height, never a legacy row', function () {
        const w = new AdmissionHeightWatermark({ HUB_NETWORK: 'regtest' });
        w.observeTip('LTC', 3000000, 0);
        const late = Object.assign(row(), ah.admitBlocksToColumns({ BTC: 840004, DOGE: 5000004, LTC: 3000002 }));
        assert.strictEqual(w.isLateFinalization('remote_token_snapshots', late, 10 * 3600 * 1000).chain, 'LTC');
        assert.strictEqual(w.isLateFinalization('remote_token_snapshots', row('testnet'), 10 * 3600 * 1000), null);
    });
});

describe('remote-token admission era: indexer canonical byte match @regression', function () {
    armEra();
    const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR || path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer');
    const TWIN = path.join(INDEXER_DIR, 'src', 'actions', 'cross_chain_remote_token.js');

    before(function () {
        skipOrFail(this, siblingCheckout(__dirname, TWIN), 'the indexer remote token canonical byte match');
    });

    it('builds the bytes the indexer verifies, in the era and below it', function () {
        const indexer = require(TWIN);
        const rows = [Object.assign(row(), ah.admitBlocksToColumns(MAP), { finalizing_view: 3 }),
                      Object.assign(row('testnet'), { finalizing_view: 1 }),
                      Object.assign(row('mainnet'), ah.admitBlocksToColumns(MAP), { finalizing_view: 0 })];
        for (const r of rows)
            assert.strictEqual(remote.canonicalRemoteTokenSnapshot(r, r.finalizing_view), indexer.remoteTokenCanonical(r), r.network);
    });
});
