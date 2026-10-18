'use strict';

const { expect } = require('chai');
const {
    SNAPSHOT_SIGNED_MEMORY,
    createSnapshotSignedRecord,
} = require('../../../../src/anchor/snapshot_checkpoint/signed_record.js');
const {
    snapshotCosignRefusal,
} = require('../../../../src/anchor/snapshot_checkpoint/cosign_policy.js');

const hash = character => character.repeat(64);

function checkpoint(blockIndex = 100, changes = {}) {
    return Object.assign({
        chain: 'BTC',
        network: 'testnet',
        block_index: blockIndex,
        block_hash: hash('a'),
        state_root: hash('b'),
        state_root_version: 2,
    }, changes);
}

describe('snapshot signed record', function () {
    it('exports its default memory', function () {
        expect(SNAPSHOT_SIGNED_MEMORY).to.equal(512);
    });

    it('records the first payload and accepts its normalized re-delivery', function () {
        const record = createSnapshotSignedRecord();
        expect(record.size()).to.equal(0);
        expect(record.held('testnet', 100)).to.equal(null);
        expect(record.claim(checkpoint())).to.equal(true);
        expect(record.claim(checkpoint(100, {
            block_hash: hash('A'),
            state_root: hash('B'),
            state_root_version: '2',
        }))).to.equal(true);
        expect(record.held('testnet', 100)).to.deep.equal({
            block_hash: hash('a'),
            state_root: hash('b'),
            state_root_version: 2,
        });
    });

    it('refuses a second payload at the same block and keeps the first', function () {
        const record = createSnapshotSignedRecord();
        const first = checkpoint();
        expect(record.claim(first)).to.equal(true);
        expect(record.claim(checkpoint(100, { state_root: hash('c') }))).to.equal(false);
        expect(record.held('testnet', 100)).to.deep.equal({
            block_hash: first.block_hash,
            state_root: first.state_root,
            state_root_version: first.state_root_version,
        });
    });

    it('holds blocks and networks independently', function () {
        const record = createSnapshotSignedRecord();
        expect(record.claim(checkpoint(100))).to.equal(true);
        expect(record.claim(checkpoint(101, { state_root: hash('c') }))).to.equal(true);
        expect(record.claim(checkpoint(100, {
            network: 'mainnet',
            state_root: hash('d'),
        }))).to.equal(true);
        expect(record.size()).to.equal(3);
        expect(record.held('testnet', 101).state_root).to.equal(hash('c'));
        expect(record.held('mainnet', 100).state_root).to.equal(hash('d'));
    });

    it('returns a fresh copy of a held payload', function () {
        const record = createSnapshotSignedRecord();
        record.claim(checkpoint());
        const copy = record.held('testnet', 100);
        copy.state_root = hash('c');
        expect(record.held('testnet', 100).state_root).to.equal(hash('b'));
    });

    it('refuses malformed checkpoints without throwing or recording', function () {
        const malformed = [
            null,
            'checkpoint',
            checkpoint(100, { chain: 'LTC' }),
            checkpoint(100, { network: '' }),
            checkpoint(1.5),
            checkpoint(-1),
            checkpoint(100, { block_hash: 'ab' }),
            checkpoint(100, { state_root: hash('z') }),
            Object.defineProperty({}, 'chain', {
                get: () => { throw new Error('unreadable checkpoint'); },
            }),
        ];
        const record = createSnapshotSignedRecord();
        for(const cp of malformed) expect(() => record.claim(cp)).not.to.throw();
        for(const cp of malformed) expect(record.claim(cp)).to.equal(false);
        expect(record.size()).to.equal(0);
        expect(record.held('testnet', '100')).to.equal(null);
    });

    it('evicts the oldest-recorded key past its memory', function () {
        const record = createSnapshotSignedRecord(2);
        record.claim(checkpoint(1));
        record.claim(checkpoint(2));
        record.claim(checkpoint(1));
        record.claim(checkpoint(3));
        expect(record.held('testnet', 1)).to.equal(null);
        expect(record.held('testnet', 2)).not.to.equal(null);
        expect(record.held('testnet', 3)).not.to.equal(null);
        expect(record.size()).to.equal(2);
    });

    it('throws for a non-positive or non-integer memory', function () {
        expect(() => createSnapshotSignedRecord(0)).to.throw(TypeError);
        expect(() => createSnapshotSignedRecord(-1)).to.throw(TypeError);
        expect(() => createSnapshotSignedRecord(1.5)).to.throw(TypeError);
        expect(() => createSnapshotSignedRecord('2')).to.throw(TypeError);
        expect(() => createSnapshotSignedRecord(Number.MAX_SAFE_INTEGER + 1)).to.throw(TypeError);
    });

    it('provides the signed view used by snapshotCosignRefusal', function () {
        const record = createSnapshotSignedRecord();
        record.claim(checkpoint());
        const view = {
            network: 'testnet',
            gateActive: true,
            expectedBlock: 100,
            btcTip: 106,
            confirmations: 6,
            local: checkpoint(100, { state_root: hash('c') }),
            signed: record.held('testnet', 100),
            stored: null,
        };
        expect(snapshotCosignRefusal({
            snapshot_block: 106,
            cp: checkpoint(100, { state_root: hash('c') }),
        }, view)).to.equal('conflicting_payload');
        expect(snapshotCosignRefusal({
            snapshot_block: 106,
            cp: checkpoint(),
        }, Object.assign({}, view, {
            local: checkpoint(),
        }))).to.equal(null);
    });
});
