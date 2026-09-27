/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - folded ANCHOR group placement tests
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fixture = require('../../../../fixtures/anchor_canonical_vectors.json').fixture.bundle_v3;
const { placeArchiveOnGroups } = require('../../../../../src/anchor/publisher/fold/fold_groups.js');

function archiveWithBytes(length){
    return {
        wrapper_section_index: fixture.wrapper_section_index,
        match_batch_seq: fixture.match_batch_seq,
        match_count: fixture.match_count,
        batch_crc32: fixture.batch_crc32,
        total_chunks: fixture.total_chunks,
        archive_b64: 'x'.repeat(length)
    };
}

describe('folded ANCHOR group placement', function () {
    const sections = fixture.sections;
    const publisher = fixture.publisher;
    const archive = archiveWithBytes(fixture.archive_b64.length);

    it('places a fitting archive on the only group', function () {
        const groups = [sections];
        const placed = placeArchiveOnGroups(groups, archive, publisher, 2);

        expect(placed).to.deep.equal([{ group: sections, archive }]);
        expect(placed[0].group).to.equal(groups[0]);
    });

    it('keeps both split groups and places the archive on the second when the first is full', function () {
        const groups = [sections, [sections[0]]];
        const largeArchive = archiveWithBytes(5600);
        const placed = placeArchiveOnGroups(groups, largeArchive, publisher, 2);

        expect(placed.map(entry => entry.group)).to.deep.equal(groups);
        expect(placed.map(entry => entry.archive)).to.deep.equal([null, largeArchive]);
        expect(placed[0].group).to.equal(groups[0]);
        expect(placed[1].group).to.equal(groups[1]);
    });

    it('keeps both groups checkpoint-only when neither has room', function () {
        const groups = [sections, [sections[0]]];
        const placed = placeArchiveOnGroups(groups, archiveWithBytes(8000), publisher, 2);

        expect(placed.map(entry => entry.group)).to.deep.equal(groups);
        expect(placed.map(entry => entry.archive)).to.deep.equal([null, null]);
    });

    it('keeps every group untouched when the archive is null', function () {
        const groups = [[sections[0]], [sections[1]]];
        const placed = placeArchiveOnGroups(groups, null, publisher, 2);

        expect(placed).to.deep.equal([
            { group: groups[0], archive: null },
            { group: groups[1], archive: null }
        ]);
        expect(placed[0].group).to.equal(groups[0]);
        expect(placed[1].group).to.equal(groups[1]);
    });
});
