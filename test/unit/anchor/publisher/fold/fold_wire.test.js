'use strict';

const { expect } = require('chai');
const fixture = require('../../../../fixtures/anchor_canonical_vectors.json');
const { ANCHOR_BUNDLE_MAX_BYTES } = require('../../../../../src/anchor/publisher/constants.js');
const { buildFoldBundleWire } = require('../../../../../src/anchor/publisher/fold/fold_wire.js');

const bundle = fixture.fixture.bundle_v3;
const archive = {
    wrapper_section_index: bundle.wrapper_section_index,
    match_batch_seq: bundle.match_batch_seq,
    match_count: bundle.match_count,
    batch_crc32: bundle.batch_crc32,
    total_chunks: bundle.total_chunks,
    archive_b64: bundle.archive_b64
};

function build(group, archiveValue){
    return buildFoldBundleWire(group, bundle.publisher, bundle.attest_sigs,
        archiveValue, bundle.network, bundle.snapshot_block);
}

describe('folded ANCHOR bundle wire', function () {
    it('reproduces the archive-bearing vector byte for byte', function () {
        expect(build(bundle.sections, archive)).to.equal(fixture.vectors.v3);
    });

    it('reproduces the checkpoint-only vector byte for byte', function () {
        expect(build(bundle.sections, null)).to.equal(fixture.vectors.v3_no_archive);
    });

    it('returns null when the payload exceeds the byte budget', function () {
        const group = [{
            ...bundle.sections[0],
            block_hash: 'a'.repeat(ANCHOR_BUNDLE_MAX_BYTES)
        }];
        expect(build(group, null)).to.equal(null);
    });
});
