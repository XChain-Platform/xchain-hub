'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// An archived superseding checkpoint must carry supersedes_from and rules_digest, since
// its signatures cover them, while every plain checkpoint keeps the archive bytes (and so
// the BATCH_CRC32) it was anchored with. The indexer recovery reader is the other consumer
// of archived state_checkpoints rows, so the same archive bytes are run through it too.

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { CHECKPOINT_KEYS, CHECKPOINT_SUPERSEDE_KEYS } =
    require('../../../../../../src/anchor/publisher/constants.js');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');
const vectors = require('../../../../../fixtures/anchor_archive_vectors.json');
const { siblingCheckout, skipOrFail } = require('../../../../../helpers/sibling_checkout.js');

const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));
const DIGEST = 'e'.repeat(64);

// Recorded on origin/develop 0cc7c0a4, before the supersede keys existed: the archived
// bytes of a plain checkpoint row read back from the DB (both supersede columns NULL).
const PLAIN_ROW_JSON = '{"id":5,"chain":"BTC","network":"regtest","block_index":90,' +
    '"block_hash":"' + 'a'.repeat(64) + '","ledger_hash":"' + 'b'.repeat(64) + '",' +
    '"actions_hash":"' + 'c'.repeat(64) + '","contract_hash":"' + 'd'.repeat(64) + '",' +
    '"checkpoint_seq":100,"snapshot_block":100,"state_root":"' + 'f'.repeat(64) + '",' +
    '"state_root_version":1,"block_merkle_root":"' + '9'.repeat(64) + '",' +
    '"block_merkle_version":1,"validator_signatures":"[]"}';
const PLAIN_ROW_CRC32 = '2c90b220';

// A state_checkpoints row as the DB driver returns it: string integers, both supersede
// columns present, and created_at, which the archive leaves out.
function dbRow(extra){
    return Object.assign({
        id: '5', chain: 'BTC', network: 'regtest', block_index: '90',
        block_hash: 'a'.repeat(64), ledger_hash: 'b'.repeat(64),
        actions_hash: 'c'.repeat(64), contract_hash: 'd'.repeat(64),
        checkpoint_seq: '100', snapshot_block: '100',
        supersedes_from: null, rules_digest: null,
        state_root: 'f'.repeat(64), state_root_version: 1,
        block_merkle_root: '9'.repeat(64), block_merkle_version: 1,
        validator_signatures: '[]', created_at: '2026-10-25 00:00:00'
    }, extra || {});
}

function publisher(held){
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            getStateCheckpointByChainAndNetworkAndCheckpointSeq: async () => held ? [held] : []
        },
        network: 'regtest',
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (capability, block) =>
        capability === 'oracle_publish' && Number(block) === 100 ? SET : [];
    return pub;
}

function signed(row){
    const canonical = publisher().stateCheckpointCanonical(row);
    row.validator_signatures = JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    return row;
}

// The archive JSON exactly as a leader builds it, crc32 included.
async function buildArchive(row){
    const pub = publisher();
    const { json } = await pub.buildArchive('regtest', 4, [], 100, [], [],
        { checkpoints: [row], prices: [], tombstones: [] });
    return { json, crc32: pub.crc32Hex(json), archive: JSON.parse(json) };
}

const supersedingRow = () => signed(dbRow({ supersedes_from: '90', rules_digest: DIGEST.toUpperCase() }));

describe('archive checkpoint supersede keys: plain bytes', () => {
    it('keeps the fixed checkpoint key list and names the two supersede keys apart', () => {
        expect(CHECKPOINT_KEYS).to.not.include.members(CHECKPOINT_SUPERSEDE_KEYS);
        expect(CHECKPOINT_SUPERSEDE_KEYS).to.deep.equal(['supersedes_from', 'rules_digest']);
    });

    it('archives a plain checkpoint byte-identical to the recorded pre-change vector', () => {
        const pub = publisher();
        for(const row of [dbRow(), (({ supersedes_from, rules_digest, ...rest }) => rest)(dbRow())]){
            const json = JSON.stringify(pub.serializeStateCheckpoint(row));
            expect(json).to.equal(PLAIN_ROW_JSON);
            expect(pub.crc32Hex(json)).to.equal(PLAIN_ROW_CRC32);
        }
    });

    it('rebuilds the anchored checkpoint vector C to its recorded json and BATCH_CRC32', async () => {
        const { inputs, json, crc32 } = vectors.C;
        const pub = publisher();
        pub.resolveCapabilitySet = async (capability, block) =>
            inputs.capability_sets[capability + '@' + block] || [];
        const result = await pub.buildArchive(inputs.network, inputs.batch_seq, inputs.matches,
            inputs.wrapper_snapshot_block, inputs.calls, inputs.rewards,
            { checkpoints: inputs.checkpoints, prices: [], tombstones: [] });
        expect(result.json).to.equal(json);
        expect(pub.crc32Hex(result.json)).to.equal(crc32);
        // The same rows as the DB returns them, NULL supersede columns included, change nothing.
        const withNulls = inputs.checkpoints.map(row => Object.assign({}, row,
            { supersedes_from: null, rules_digest: null }));
        const again = await pub.buildArchive(inputs.network, inputs.batch_seq, inputs.matches,
            inputs.wrapper_snapshot_block, inputs.calls, inputs.rewards,
            { checkpoints: withNulls, prices: [], tombstones: [] });
        expect(again.json).to.equal(json);
    });
});

describe('archive checkpoint supersede keys: co-signer verify', () => {
    it('archives a superseding checkpoint with both fields after the fixed keys, normalized', async () => {
        const { archive } = await buildArchive(supersedingRow());
        const row = archive.state_checkpoints[0];
        expect(Object.keys(row)).to.deep.equal(CHECKPOINT_KEYS.concat(CHECKPOINT_SUPERSEDE_KEYS));
        expect(row.supersedes_from).to.equal(90);
        expect(row.rules_digest).to.equal(DIGEST);
    });

    it('verifies the superseding archive on a co-signer that holds the row and on one that does not', async () => {
        const held = supersedingRow();
        const { archive } = await buildArchive(held);
        expect(await publisher(held).verifyArchiveAgainstLocal(archive, 100)).to.equal(true);
        expect(await publisher().verifyArchiveAgainstLocal(archive, 100)).to.equal(true);
    });

    it('fails quorum when the supersede fields are dropped, the shape this row fixes', async () => {
        const held = supersedingRow();
        const { archive } = await buildArchive(held);
        for(const key of CHECKPOINT_SUPERSEDE_KEYS) delete archive.state_checkpoints[0][key];
        expect(await publisher().verifyArchiveAgainstLocal(archive, 100)).to.equal(false);
        expect(await publisher(held).verifyArchiveAgainstLocal(archive, 100)).to.equal(false);
    });

    it('still verifies a plain archive on a co-signer that holds the row', async () => {
        const held = signed(dbRow());
        const { archive } = await buildArchive(held);
        expect(archive.state_checkpoints[0]).to.not.have.any.keys(...CHECKPOINT_SUPERSEDE_KEYS);
        expect(await publisher(held).verifyArchiveAgainstLocal(archive, 100)).to.equal(true);
    });
});

describe('archive checkpoint supersede keys: indexer recovery reader', () => {
    const SIBLINGS = ['../../../../../../../xchain-indexer/bin/recovery.js',
        '../../../../../../../xchain-indexer/bin/recovery/checkpoint_price.js'].map(target => {
        const verdict = siblingCheckout(__dirname, target);
        try { return { verdict, mod: verdict.usable ? require(target) : null }; }
        catch (err) { return { verdict, mod: null, err }; }
    });
    const [AnchorRecovery, checkpointPrice] = SIBLINGS.map(sibling => sibling.mod);

    before(function(){
        const refused = SIBLINGS.find(sibling => !sibling.verdict.usable);
        if(refused && !skipOrFail(this, refused.verdict, 'the indexer archive checkpoint reader check')) return;
        const broken = SIBLINGS.find(sibling => !sibling.mod);
        if(broken){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + broken.verdict.path +
                                ' failed to load: ' + (broken.err && broken.err.message));
            this.skip();
        }
    });

    // The set comes from the archive's own capability_snapshots, mapped as bin/recovery.js maps it.
    function readerContext(archive){
        const proto = AnchorRecovery.prototype;
        return {
            network: 'regtest',
            setFor: (capability, block) => archive.capability_snapshots
                .filter(snap => snap.capability === capability && Number(snap.snapshot_block) === Number(block))
                .map(snap => ({ pubkey: String(snap.signing_pubkey).toLowerCase(),
                                source: String(snap.source), weight: String(snap.amount) })),
            parseSigs: raw => proto.parseSigs(raw),
            checkpointCanonical: row => AnchorRecovery.checkpointCanonicalForTest(row),
            quorumVerified: (canonical, sigs, set, weighted) => proto.quorumVerified(canonical, sigs, set, weighted)
        };
    }

    it('recomputes the hub BATCH_CRC32 over the archive bytes for plain and superseding rows', async () => {
        for(const row of [signed(dbRow()), supersedingRow()]){
            const { json, crc32 } = await buildArchive(row);
            expect(AnchorRecovery.prototype.crc32Hex(json)).to.equal(crc32);
        }
    });

    it('accepts the plain archive and the superseding archive through verifyArchive', async () => {
        for(const row of [signed(dbRow()), supersedingRow()]){
            const { archive } = await buildArchive(row);
            expect(() => checkpointPrice.verifyArchive(archive, readerContext(archive))).to.not.throw();
        }
    });

    it('refuses the superseding archive once the supersede fields are dropped', async () => {
        const { archive } = await buildArchive(supersedingRow());
        for(const key of CHECKPOINT_SUPERSEDE_KEYS) delete archive.state_checkpoints[0][key];
        expect(() => checkpointPrice.verifyArchive(archive, readerContext(archive))).to.throw(/fails quorum/);
    });
});
