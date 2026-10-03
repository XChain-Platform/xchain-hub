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

function read(members, meta = {}) {
    return {
        type: 2,
        members,
        hash: listMembersHash(members),
        ...meta
    };
}

function held(members, metaHash = null) {
    return {
        lastSeq: 1,
        latest: {
            list_type: 2,
            members_hash: listMembersHash(members),
            origin_block: 90,
            meta_hash: metaHash
        },
        fold: () => members
    };
}

function plan(current, currentHeld, metaActive = true) {
    return planListVersion({
        read: current,
        originBlock: 100,
        held: currentHeld,
        metaActive
    });
}

function firstPlan(current, metaActive = true) {
    return plan(current, {
        lastSeq: 0,
        latest: null,
        fold: () => null
    }, metaActive);
}

function metadataRead(name, description, metaHash) {
    return read(['a'], {
        name,
        description,
        meta_hash: metaHash
    });
}

function firstVersion(current, metadata = {}) {
    return {
        list_type: 2,
        seq: 1,
        kind: 'full',
        added: ['a'],
        removed: [],
        members_hash: current.hash,
        origin_block: 100,
        ...metadata
    };
}

describe('shared-list version plan metadata compatibility', function () {
    it('keeps the legacy result shape when metadata is inactive', function () {
        const current = read(['a'], {
            name: 'Named list',
            description: 'A description',
            meta_hash: listMetaHash('Named list', 'A description')
        });

        assert.deepStrictEqual(plan(current, {
            lastSeq: 0,
            latest: null,
            fold: () => null
        }, false), {
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
    });

    it('treats an unnamed list and a held null metadata hash as unchanged', function () {
        const current = read(['a'], { meta_hash: '' });

        assert.deepStrictEqual(plan(current, held(['a'])), { unchanged: true });
    });

    it('plans exactly one delta when a pre-gate list first gains metadata', function () {
        const current = read(['a'], {
            name: 'Named list',
            description: null,
            meta_hash: listMetaHash('Named list', null)
        });
        const result = plan(current, held(['a']));

        assert.deepStrictEqual(result.version, {
            list_type: 2,
            seq: 2,
            kind: 'delta',
            added: [],
            removed: [],
            members_hash: current.hash,
            origin_block: 100,
            name: 'Named list',
            description: null,
            meta_hash: listMetaHash('Named list', null)
        });
        assert.deepStrictEqual(plan(current, {
            ...held(['a'], listMetaHash('Named list', null)),
            lastSeq: 2
        }), { unchanged: true });
    });
});

describe('shared-list version plan metadata versions', function () {
    it('plans a rename-only delta carrying the new metadata', function () {
        const current = read(['a', 'b'], {
            name: 'New name',
            description: 'New description',
            meta_hash: listMetaHash('New name', 'New description')
        });

        assert.deepStrictEqual(plan(current, held(
            ['a', 'b'],
            listMetaHash('Old name', 'Old description')
        )).version, {
            list_type: 2,
            seq: 2,
            kind: 'delta',
            added: [],
            removed: [],
            members_hash: current.hash,
            origin_block: 100,
            name: 'New name',
            description: 'New description',
            meta_hash: listMetaHash('New name', 'New description')
        });
    });

    it('carries metadata on a first full version', function () {
        const current = read(['a'], {
            name: 'Named list',
            meta_hash: listMetaHash('Named list', null)
        });

        assert.deepStrictEqual(plan(current, {
            lastSeq: 0,
            latest: null,
            fold: () => null
        }).version, {
            list_type: 2,
            seq: 1,
            kind: 'full',
            added: ['a'],
            removed: [],
            members_hash: current.hash,
            origin_block: 100,
            name: 'Named list',
            description: null,
            meta_hash: listMetaHash('Named list', null)
        });
    });
});

describe('shared-list version plan metadata validation', function () {
    it('refuses invalid metadata', function () {
        const longName = 'n'.repeat(65);
        const bidiDescription = `bad\u202Edescription`;
        const cases = [
            { name: longName, meta_hash: listMetaHash(longName, null) },
            { name: '-', meta_hash: listMetaHash('-', null) },
            { name: 'bad;name', meta_hash: listMetaHash('bad;name', null) },
            {
                description: bidiDescription,
                meta_hash: listMetaHash(null, bidiDescription)
            },
            { name: 'Named list', meta_hash: 123 }
        ];

        for (const meta of cases) {
            assert.deepStrictEqual(plan(read(['a'], meta), held(['a'])), {
                refuse: 'meta'
            });
        }
    });
});

function plansCanonicalMetadataHash() {
    const name = 'Named list';
    const description = 'A description';
    const current = metadataRead(name, description, listMetaHash(name, description));

    assert.deepStrictEqual(firstPlan(current), {
        version: firstVersion(current, {
            name,
            description,
            meta_hash: listMetaHash(name, description)
        })
    });
}

function refusesNoncanonicalMetadataHashes() {
    const name = 'Named list';
    const description = 'A description';
    const canonical = listMetaHash(name, description);
    const cases = [
        listMetaHash(description, name),
        canonical.toUpperCase(),
        listMetaHash('Another name', description),
        ''
    ];

    for (const metaHash of cases) {
        assert.deepStrictEqual(firstPlan(metadataRead(name, description, metaHash)), {
            refuse: 'meta'
        });
    }
}

function plansAbsentMetadataHash() {
    const current = read(['a'], { meta_hash: '' });
    assert.deepStrictEqual(firstPlan(current), {
        version: firstVersion(current, {
            name: null,
            description: null,
            meta_hash: ''
        })
    });
}

function ignoresMetadataHashBeforeActivation() {
    const name = 'Named list';
    const description = 'A description';
    const canonical = listMetaHash(name, description);
    const cases = [
        listMetaHash(description, name),
        canonical.toUpperCase(),
        listMetaHash('Another name', description),
        ''
    ];

    for (const metaHash of cases) {
        const current = metadataRead(name, description, metaHash);
        assert.deepStrictEqual(firstPlan(current, false), {
            version: firstVersion(current)
        });
    }
}

describe('shared-list version plan metadata hash', function () {
    it('plans metadata carrying its canonical hash', plansCanonicalMetadataHash);
    it('refuses metadata hashes that do not match their fields', refusesNoncanonicalMetadataHashes);
    it('plans absent metadata with an empty hash', plansAbsentMetadataHash);
    it('keeps mismatched hashes inert before activation', ignoresMetadataHashBeforeActivation);
});
