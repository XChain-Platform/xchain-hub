'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { chooseArchiveGroup } = require('../../../../../src/anchor/publisher/fold/archive_placement.js');
const { ANCHOR_BUNDLE_MAX_BYTES } = require('../../../../../src/anchor/publisher/constants.js');

describe('archive placement', function () {
    it('places an archive in a single group with room', function () {
        expect(chooseArchiveGroup([700], 200, 1000)).to.equal(0);
    });

    it('uses the second group when the first is too full', function () {
        expect(chooseArchiveGroup([900, 700], 200, 1000)).to.equal(1);
    });

    it('uses the first group when both groups have room', function () {
        expect(chooseArchiveGroup([700, 600], 200, 1000)).to.equal(0);
    });

    it('returns -1 when no group has room', function () {
        expect(chooseArchiveGroup([900, 850], 200, 1000)).to.equal(-1);
    });

    it('accepts an exact fit at the byte limit', function () {
        expect(chooseArchiveGroup([900, 800], 200, 1000)).to.equal(1);
    });

    it('returns -1 for an empty group list', function () {
        expect(chooseArchiveGroup([], 200, 1000)).to.equal(-1);
    });

    it('returns -1 when the archive has no bytes', function () {
        expect(chooseArchiveGroup([700], 0, 1000)).to.equal(-1);
    });

    it('defaults to the anchor bundle byte limit', function () {
        expect(chooseArchiveGroup([ANCHOR_BUNDLE_MAX_BYTES - 1], 1)).to.equal(0);
        expect(chooseArchiveGroup([ANCHOR_BUNDLE_MAX_BYTES], 1)).to.equal(-1);
    });
});
