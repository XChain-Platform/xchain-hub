'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const assert = require('assert');
const crypto = require('crypto');

const { listMetaHash } = require('../../../../src/cross_chain/list/canonical.js');

function expectedMetaHash(name, description) {
    const text = ['LISTMETA', name == null ? '' : name, description == null ? '' : description]
        .join('|');
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('list meta hash', function () {
    it('returns an empty string when both fields are absent', function () {
        assert.strictEqual(listMetaHash(), '');
        assert.strictEqual(listMetaHash(null, null), '');
    });

    [
        { label: 'name only', name: 'Treasury list', description: null },
        { label: 'description only', name: null, description: 'Updated weekly' },
        { label: 'both fields', name: 'Treasury list', description: 'Updated weekly' },
        { label: 'multi-byte name', name: '名簿 🔐', description: null }
    ].forEach(function (entry) {
        it('hashes ' + entry.label + ' as UTF-8', function () {
            assert.strictEqual(
                listMetaHash(entry.name, entry.description),
                expectedMetaHash(entry.name, entry.description)
            );
        });
    });
});
