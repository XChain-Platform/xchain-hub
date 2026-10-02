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

const {
    listMembersHash,
    listMetaHash
} = require('../../../../src/cross_chain/list/canonical.js');
const { planListVersion } = require('../../../../src/cross_chain/list/version_plan.js');

function read(name, description, metaHash) {
    return {
        type: 2,
        members: ['a'],
        hash: listMembersHash(['a']),
        name,
        description,
        meta_hash: metaHash
    };
}

function plan(current, metaActive = true) {
    return planListVersion({
        read: current,
        originBlock: 100,
        held: { lastSeq: 0, latest: null, fold: () => null },
        metaActive
    });
}

describe('shared-list version plan metadata hash', function () {
    it('plans metadata carrying its canonical hash', function () {
        const current = read(
            'Named list',
            'A description',
            listMetaHash('Named list', 'A description')
        );

        assert.deepStrictEqual(plan(current).version, {
            list_type: 2,
            seq: 1,
            kind: 'full',
            added: ['a'],
            removed: [],
            members_hash: current.hash,
            origin_block: 100,
            name: 'Named list',
            description: 'A description',
            meta_hash: listMetaHash('Named list', 'A description')
        });
    });

    it('refuses metadata hashes that do not match their fields', function () {
        const canonical = listMetaHash('Named list', 'A description');
        const cases = [
            listMetaHash('A description', 'Named list'),
            canonical.toUpperCase(),
            listMetaHash('Another name', 'A description'),
            ''
        ];

        for (const metaHash of cases) {
            assert.deepStrictEqual(
                plan(read('Named list', 'A description', metaHash)),
                { refuse: 'meta' }
            );
        }
    });

    it('plans absent metadata with an empty hash', function () {
        const current = read(undefined, undefined, '');

        assert.deepStrictEqual(plan(current).version, {
            list_type: 2,
            seq: 1,
            kind: 'full',
            added: ['a'],
            removed: [],
            members_hash: current.hash,
            origin_block: 100,
            name: null,
            description: null,
            meta_hash: ''
        });
    });

    it('keeps mismatched metadata hashes inert before activation', function () {
        const canonical = listMetaHash('Named list', 'A description');
        const cases = [
            listMetaHash('A description', 'Named list'),
            canonical.toUpperCase(),
            listMetaHash('Another name', 'A description'),
            ''
        ];

        for (const metaHash of cases) {
            const current = read('Named list', 'A description', metaHash);
            assert.deepStrictEqual(plan(current, false), {
                version: {
                    list_type: 2,
                    seq: 1,
                    kind: 'full',
                    added: ['a'],
                    removed: [],
                    members_hash: current.hash,
                    origin_block: 100
                }
            });
        }
    });
});
