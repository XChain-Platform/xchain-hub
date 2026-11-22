'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const fixture = require('../../../../fixtures/anchor_canonical_vectors.json');
const {
    foldArchiveSuffix,
    extendWrapperCanonicalBase
} = require('../../../../../src/anchor/publisher/fold/wrapper_canonical.js');
const checkpointForms = require('../../../../../src/anchor/checkpoint_engine/canonical_forms.js');
const { foldArchiveCanonical } = require('../../../../../src/anchor/publisher/canonical_forms.js');
const { archiveCanonical } = require('../../../../../src/anchor/publisher/archive/build.js');

describe('folded ANCHOR wrapper canonical', function () {
    const archive = fixture.fixture.bundle_v3;
    const base = 'XCHECKPOINT|BTC|regtest|900000';
    const suffix = '|42|17|8665563e|1';

    it('appends the vector archive fields in v1 canonical order', function () {
        expect(foldArchiveSuffix(archive)).to.equal(suffix);
    });

    it('extends the wrapper section for lower-case archive keys', function () {
        expect(extendWrapperCanonicalBase(base, 0, archive)).to.equal(base + suffix);
    });

    it('extends the wrapper section for upper-case archive keys', function () {
        const upperArchive = {
            WRAPPER_SECTION_INDEX: '2',
            MATCH_BATCH_SEQ: 43,
            MATCH_COUNT: 18,
            BATCH_CRC32: 'abcdef01',
            TOTAL_CHUNKS: 3
        };
        expect(extendWrapperCanonicalBase(base, 2, upperArchive))
            .to.equal(base + '|43|18|abcdef01|3');
    });

    it('embeds an upper-case batch CRC as lower-case', function () {
        const upperCrc = { WRAPPER_SECTION_INDEX: 2, MATCH_BATCH_SEQ: 43, MATCH_COUNT: 18,
            BATCH_CRC32: 'ABCDEF01', TOTAL_CHUNKS: 3 };
        expect(extendWrapperCanonicalBase(base, 2, upperCrc)).to.equal(base + '|43|18|abcdef01|3');
    });

    it('leaves a non-wrapper section unchanged', function () {
        expect(extendWrapperCanonicalBase(base, 1, archive)).to.equal(base);
    });

    it('leaves the canonical unchanged without an archive', function () {
        expect(extendWrapperCanonicalBase(base, 0, null)).to.equal(base);
    });

    it('shares the checkpoint round id and preserves a zero archive sequence', function () {
        const checkpoint = {
            chain: 'BTC', network: 'regtest', block_index: 500,
            block_hash: 'bh', ledger_hash: 'lh', actions_hash: 'ah', contract_hash: 'ch',
            checkpoint_seq: 7, snapshot_block: 480,
            state_root: null, state_root_version: null,
            block_merkle_root: null, block_merkle_version: null
        };
        expect(checkpointForms.checkpointRoundId(checkpoint)).to.equal('BTC|regtest|500|7');
        expect(checkpointForms.archiveRoundId(checkpoint, 0)).to.equal('BTC|regtest|500|7|0');
        expect(checkpointForms.canonicalCheckpoint(checkpoint))
            .to.match(/^EQUIV\|XCHECKPOINT\|BTC\|regtest\|500\|7\|0\|\|/);
        expect(archiveCanonical(checkpoint, 0, 1, '00000000', 1))
            .to.match(/^EQUIV\|XCHECKPOINT\|BTC\|regtest\|500\|7\|0\|0\|\|/);
        expect(foldArchiveCanonical(checkpoint, 0, 1, '00000000', 1))
            .to.match(/^EQUIV\|XCHECKPOINT\|BTC\|regtest\|500\|7\|0\|0\|\|/);
    });
});
