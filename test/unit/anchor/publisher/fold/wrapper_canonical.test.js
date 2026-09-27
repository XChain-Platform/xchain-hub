'use strict';

const { expect } = require('chai');
const fixture = require('../../../../fixtures/anchor_canonical_vectors.json');
const {
    foldArchiveSuffix,
    extendWrapperCanonicalBase
} = require('../../../../../src/anchor/publisher/fold/wrapper_canonical.js');

describe('folded ANCHOR wrapper canonical', function () {
    const archive = fixture.fixture.bundle_v3;
    const base = 'XCHECKPOINT|BTC|regtest|900000';
    const suffix = '|42|17|9c4e1b22|1';

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

    it('leaves a non-wrapper section unchanged', function () {
        expect(extendWrapperCanonicalBase(base, 1, archive)).to.equal(base);
    });

    it('leaves the canonical unchanged without an archive', function () {
        expect(extendWrapperCanonicalBase(base, 0, null)).to.equal(base);
    });
});
