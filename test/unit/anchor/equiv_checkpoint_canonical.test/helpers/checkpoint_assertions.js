'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const { expect } = require('chai');
const CHECKPOINT_VECTORS = require('../../../../fixtures/checkpoint_canonical_vectors.json');

// key = the slice between the literal "EQUIV|" and the "||" boundary.
function keyOf(canon) {
    expect(canon.startsWith('EQUIV|')).to.equal(true);
    return canon.slice('EQUIV|'.length, canon.indexOf('||'));
}

function assertCheckpointVectors(canonicalCheckpoint) {
    for (const vector of CHECKPOINT_VECTORS.cases) {
        if (vector.throws)
            expect(() => canonicalCheckpoint(vector.checkpoint), vector.name).to.throw();
        else
            expect(canonicalCheckpoint(vector.checkpoint), vector.name).to.equal(vector.expected);
    }
}

module.exports = { assertCheckpointVectors, keyOf };
