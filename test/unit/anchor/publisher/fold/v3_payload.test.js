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
    buildAnchorV3Payload,
    archiveSectionBytes
} = require('../../../../../src/anchor/publisher/fold/v3_payload.js');

function resolveBundle(name){
    const source = fixture.fixture[name];
    const resolved = {};
    for(const [key, value] of Object.entries(source)){
        const match = typeof value === 'string' && value.match(/^same as bundle_v3\.(.+)$/);
        resolved[key] = match ? fixture.fixture.bundle_v3[match[1]] : value;
    }
    return resolved;
}

describe('folded ANCHOR v3 payload', function () {
    const withArchive = resolveBundle('bundle_v3');
    const withoutArchive = resolveBundle('bundle_v3_no_archive');

    it('matches the canonical archive-bearing vector byte for byte', function () {
        expect(buildAnchorV3Payload(withArchive)).to.equal(fixture.vectors.v3);
    });

    it('matches the canonical checkpoint-only vector byte for byte', function () {
        expect(buildAnchorV3Payload(withoutArchive)).to.equal(fixture.vectors.v3_no_archive);
    });

    it('accepts stored JSON validator signatures', function () {
        const sections = withArchive.sections.map(section => ({
            ...section,
            chain: section.chain.toLowerCase(),
            validator_signatures: JSON.stringify(section.validator_signatures.map((signature, index) => ({
                pubkey: index === 0 ? signature.pubkey.toUpperCase() : signature.pubkey,
                sig: signature.sig.toUpperCase()
            })))
        }));
        expect(buildAnchorV3Payload({ ...withArchive, sections })).to.equal(fixture.vectors.v3);
    });

    it('measures only the archive fields and their separators', function () {
        const vectorDelta = Buffer.byteLength(fixture.vectors.v3, 'utf8') -
            Buffer.byteLength(fixture.vectors.v3_no_archive, 'utf8');
        expect(archiveSectionBytes(withArchive)).to.equal(vectorDelta);
        expect(vectorDelta).to.equal(2003);
        expect(archiveSectionBytes(withoutArchive)).to.equal(0);
    });

    it('refuses an archive count outside zero or one', function () {
        expect(() => buildAnchorV3Payload({ ...withArchive, archive_count: 2 }))
            .to.throw(/ARCHIVE_COUNT/);
    });

    it('refuses an archive wrapper outside the chain section range', function () {
        expect(() => buildAnchorV3Payload({
            ...withArchive,
            wrapper_section_index: withArchive.sections.length
        })).to.throw(/WRAPPER_SECTION_INDEX/);
    });
});
