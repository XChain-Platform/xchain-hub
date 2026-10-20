'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The reward drain applies the indexer's LEGACY_ANCHOR_REWARD_PIN rule, so the hub writes no
// attestation the indexer refuses once the gate is proven on, and still writes every one it mints.

const { expect }           = require('chai');
const fs                   = require('fs');
const path                 = require('path');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const registry             = require('../../../../../src/consensus/gate_registry.js');
const core                 = require('../../../../../src/consensus/gate_registry/core.js');
const { siblingCheckout, skipOrFail } = require('../../../../helpers/sibling_checkout.js');

const HUB_KEY          = 'anchor/publisher/legacy_reward_pin.LEGACY_ANCHOR_REWARD_PIN';
const INDEXER          = path.join(__dirname, '../../../../../../xchain-indexer');
const INDEXER_CHANGES  = path.join(INDEXER, 'src/protocol_changes/changes_5.js');
const INDEXER_PC       = path.join(INDEXER, 'src/protocol_changes.js');
const INDEXER_CLIENT   = path.join(INDEXER, 'src/consensus/doge_peer_clients/anchor_proof_client.js');
const INDEXER_MINT_ROW = path.join(INDEXER, 'src/consensus/anchor_reward_derive/mint_row.js');
const INDEXER_PINS     = path.join(INDEXER, 'src/consensus/anchor_reward_derive');
const HUB_PINS         = path.join(__dirname, '../../../../../src/anchor');

// The testnet instant of the gate, and the BTC indexer tip every scenario reads.
const INSTANT = 1792303200;
const TIP     = 160000;
// The bundle reward family's burial depth on both sides.
const MIN_CONF = 6;
// The fleet-agreed mirror maturity: a timely row derives at snapshot_block + 144.
const MATURITY = 144;

const PUB  = 'cd'.repeat(32);
const TXID = 'ab'.repeat(32);
// The one testnet tuple legacy_reward_pins.json pins.
const PINNED = {
    publisher: 'c1de91459e8bd93de9e3263c26d886058593d3fdae57ad0c1bd48ca3dd22f32a',
    txid: 'e8a8da752583ca314913a8411431d47c744d2e8444acb5b79559b7e22951b439',
    snapshot: 150208
};

// BTC block times ten minutes apart, with block `atHeight` timed exactly at the instant.
function timesAround(atHeight) {
    return (h) => INSTANT + (h - atHeight) * 600;
}

function bundleRow(over) {
    return Object.assign({ version: 7, status: 'valid', checkpoint_network: 'testnet', publisher: PUB,
        snapshot_block: TIP - 10, action_index: 0, confirmations: 10, checkpoint_chain: 'BTC' }, over);
}

function entry(over) {
    return Object.assign({ chain: 'BTC', network: 'testnet', blockIndex: 494, checkpointSeq: 7, txid: TXID,
        anchorVersion: 0, rewardType: 'anchor_bundle', roundReference: TIP - 10, snapshotBlock: TIP - 10,
        publisher: PUB, attestSigs: [], at: Date.now() }, over);
}

// A publisher whose DOGE indexer serves `anchors` and whose BTC indexer serves `times` (null: unreachable).
function makePub(anchors, times, network) {
    let pub = new StateAnchorPublisher({ db: {}, getIdentity: () => null, hubDbBroadcaster: null });
    pub.dogeConfirmations = MIN_CONF;
    pub.db = { getStateCheckpointByChain: async () => [{ chain: 'BTC' }] };
    pub.verifyAnchorOnChain = async () => 'verified';
    pub.btcCalls = 0;
    pub.indexerCall = async (coin, method, params) => {
        if (coin === 'DOGE' && method === 'getanchorconfirmations') return { exists: true, anchors: anchors, truncated: false };
        if (coin === 'BTC' && method === 'getblockhashes') {
            pub.btcCalls++;
            if (!times) throw new Error('no indexer url for BTC');
            let h = (params && params.block_index != null) ? Number(params.block_index) : TIP;
            return { network: network || 'testnet', block_index: h, block_time: times(h) };
        }
        throw new Error('unexpected indexer call ' + coin + ' ' + method);
    };
    pub.written = [];
    pub.recordRewardAttestation = async (...a) => { pub.written.push(a[7]); };
    return pub;
}

async function drain(anchors, times, over) {
    let e = entry(over);
    let pub = makePub(anchors, times, e.network);
    pub._deferredRewardAttest.set('k', e);
    await pub.runRewardAttestDrain();
    return pub;
}

// The indexer's own mint decision for the same row: proveRow with the real ProtocolChanges gate,
// judged at the live deriving block, with the real proof client's binding rule.
async function indexerMints(anchors, times, e) {
    const ProtocolChanges = require(INDEXER_PC);
    const AnchorProofClient = require(INDEXER_CLIENT);
    const { proveRow } = require(INDEXER_MINT_ROW);
    const client = new AnchorProofClient({ NETWORK: e.network }, { url: '' });
    const pc = new ProtocolChanges({ config: { NETWORK: e.network }, util: {},
        decoderDb: { getBlockTime: async (b) => times(Number(b)) } });
    const deriving = Math.max(Number(e.snapshotBlock) + MATURITY, TIP + 1);
    const row = { reward_type: e.rewardType, round_reference: e.roundReference, snapshot_block: e.snapshotBlock,
        publisher: e.publisher, doge_anchor_txid: e.txid, network: e.network };
    const verdict = await proveRow(row, { blockIndex: deriving, protocolChanges: pc, minConfirmations: MIN_CONF,
        proof: { proveMined: async (x) => client.judge(anchors, x) } });
    return verdict === 'verified';
}

function siblingsHere(test) {
    for (const [file, what] of [[INDEXER_PC, 'the indexer protocol changes'], [INDEXER_CLIENT, 'the indexer proof client'],
                                [INDEXER_MINT_ROW, 'the indexer mint row']]) {
        if (!skipOrFail(test, siblingCheckout(__dirname, file), what + ' for the legacy pin parity guard')) return false;
    }
    return true;
}

// Hold the hub's pins, its gate row and its mint decision equal to the indexer's.
function registerParityCases() {
    it('vendors the legacy reward pins as byte twins of the indexer copies', function () {
        let indexer = siblingCheckout(__dirname, '../../../../../../xchain-indexer/package.json');
        for (const name of ['legacy_reward_pins.js', 'legacy_reward_pins.json']) {
            let theirs = path.join(INDEXER_PINS, name);
            // Fail in every mode when the indexer is here but its copy is not: it was moved or renamed.
            if (indexer.usable && !fs.existsSync(theirs))
                throw new Error('xchain-indexer is present but ' + theirs + ' is missing; re-point this byte-twin guard');
            if (!skipOrFail(this, siblingCheckout(__dirname, theirs), 'the legacy reward pins byte-twin guard')) return;
            expect(fs.readFileSync(path.join(HUB_PINS, name)).equals(fs.readFileSync(theirs)), name).to.equal(true);
        }
    });

    it('holds the hub time row equal to the indexer protocol change row', function () {
        if (!skipOrFail(this, siblingCheckout(__dirname, INDEXER_CHANGES), 'the legacy pin row parity guard')) return;
        const row = require(INDEXER_CHANGES).find((c) => c[0] === 'LEGACY_ANCHOR_REWARD_PIN');
        expect(row, 'indexer row').to.be.an('array');
        expect(core.registry.unitOf(HUB_KEY)).to.equal('time');
        expect(registry.get(HUB_KEY)).to.deep.equal({ mainnet: row[2], testnet: row[3], regtest: row[4] });
        // The hub mirrors the time columns only, so the indexer's block columns must stay unset.
        expect(row.slice(5)).to.deep.equal([0, 0, 0]);
    });

    it('reaches the indexer mint decision for every proven-gate scenario', async function () {
        if (!siblingsHere(this)) return;
        const above = timesAround(TIP - 100);
        const below = timesAround(TIP + 1000);
        const pinnedOver = { publisher: PINNED.publisher, txid: PINNED.txid,
            roundReference: PINNED.snapshot, snapshotBlock: PINNED.snapshot };
        const pinnedRow = bundleRow({ version: 0, publisher: PINNED.publisher, snapshot_block: PINNED.snapshot });
        // An archive reward below both archive fold terms, so only the legacy byte 6 decides it.
        const archiveOver = { rewardType: 'anchor_archive', roundReference: 42, snapshotBlock: 156000, anchorVersion: 1 };
        const archiveRow = bundleRow({ version: 6, snapshot_block: 156000, match_batch_seq: 42,
            checkpoint_chain: null, block_index_doge: 67980000 });
        const cases = [
            ['v6 archive only, gate on', [archiveRow], above, archiveOver, false],
            ['v6 archive only, gate off', [archiveRow], below, archiveOver, true],
            ['v7 only, gate on', [bundleRow()], above, {}, false],
            ['v7 only, gate off', [bundleRow()], below, {}, true],
            ['v0, gate on', [bundleRow({ version: 0 })], above, {}, true],
            ['v7 beside v0, gate on', [bundleRow(), bundleRow({ version: 0, action_index: 1 })], above, {}, true],
            ['pinned tuple, gate on', [pinnedRow], above, pinnedOver, false],
            ['pinned tuple, gate off', [pinnedRow], below, pinnedOver, true],
            ['v7 only on mainnet', [bundleRow({ checkpoint_network: 'mainnet' })], above, { network: 'mainnet' }, true]
        ];
        // Each case also names the mint it must reach, so a harness that answered one way for all would fail.
        for (const [label, anchors, times, over, mints] of cases) {
            const pub = await drain(anchors, times, over);
            const hubWrites = pub.written.length === 1;
            expect(await indexerMints(anchors, times, entry(over)), label + ' (indexer)').to.equal(mints);
            expect(hubWrites, label).to.equal(mints);
        }
    });
}

// Drop a legacy-screened entry once the gate is proven on, and prove it from the right block.
function registerGateVerdictCases() {
    it('writes no attestation for a v7-only bundle once the gate is proven on', async function () {
        let pub = await drain([bundleRow()], timesAround(TIP - 100));
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('skips a pinned legacy tuple once the gate is proven on, whatever its anchor version', async function () {
        let pub = await drain([bundleRow({ version: 0, publisher: PINNED.publisher, snapshot_block: PINNED.snapshot })],
            timesAround(TIP - 100), { publisher: PINNED.publisher, txid: PINNED.txid,
                roundReference: PINNED.snapshot, snapshotBlock: PINNED.snapshot });
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('proves the gate from the median time past six blocks below the tip, not from the tip block', async function () {
        // Only the last eleven blocks are past the instant, so the tip and its own median are,
        // but the median six blocks down is not: the gate is unproven and the v7 row still binds.
        let pub = await drain([bundleRow()], timesAround(TIP - 6));
        expect(pub.written).to.deep.equal([TXID]);
        let proven = await drain([bundleRow()], timesAround(TIP - 11));
        expect(proven.written).to.deep.equal([]);
    });
}

// Keep the verdict when the gate cannot be proven, and read the BTC indexer only when needed.
function registerProofReadCases() {
    it('keeps today\'s verdict, writing the row, when the BTC indexer cannot prove the gate', async function () {
        let pub = await drain([bundleRow()], null);
        expect(pub.btcCalls).to.equal(1);
        expect(pub.written).to.deep.equal([TXID]);
    });

    it('keeps today\'s verdict when the BTC indexer answers for another network', async function () {
        let e = entry();
        let pub = makePub([bundleRow()], timesAround(TIP - 100), 'mainnet');
        pub._deferredRewardAttest.set('k', e);
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([TXID]);
    });

    it('reads no BTC block for an anchor set without a legacy byte, or on an unarmed network', async function () {
        let v0 = await drain([bundleRow({ version: 0 })], timesAround(TIP - 100));
        expect(v0.btcCalls).to.equal(0);
        expect(v0.written).to.deep.equal([TXID]);
        let mainnet = await drain([bundleRow({ checkpoint_network: 'mainnet' })], timesAround(TIP - 100), { network: 'mainnet' });
        expect(mainnet.btcCalls).to.equal(0);
        expect(mainnet.written).to.deep.equal([TXID]);
    });

    it('reuses a proven height instead of reading the eleven blocks again', async function () {
        let pub = makePub([bundleRow()], timesAround(TIP - 100));
        pub._deferredRewardAttest.set('a', entry());
        pub._deferredRewardAttest.set('b', entry({ txid: 'ef'.repeat(32) }));
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([]);
        // One tip read plus eleven block reads for the first entry, one tip read for the second.
        expect(pub.btcCalls).to.equal(13);
    });

    it('leaves the adopted-bundle ownership check unscreened', async function () {
        let pub = makePub([bundleRow()], timesAround(TIP - 100));
        expect(await pub.adoptedBundleOwnership(TXID, 'testnet', TIP - 10, PUB)).to.equal('ours');
        expect(pub.btcCalls).to.equal(0);
    });
}

describe('reward drain: LEGACY_ANCHOR_REWARD_PIN', function () {
    registerParityCases();
    registerGateVerdictCases();
    registerProofReadCases();
});
