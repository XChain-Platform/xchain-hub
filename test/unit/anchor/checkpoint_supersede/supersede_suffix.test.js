'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The ungated SUPERSEDE suffix is a pure canonical-byte fragment. Loading it
// must not alter checkpointRootSuffix or the existing checkpoint canonical.

const { expect } = require('chai');
const canonicalForms = require('../../../../src/anchor/checkpoint_engine/canonical_forms.js');

const plainCheckpoint = {
    chain: 'BTC',
    network: 'mainnet',
    block_index: 5,
    block_hash: 'block',
    ledger_hash: 'ledger',
    actions_hash: 'actions',
    contract_hash: 'contract',
    checkpoint_seq: 3,
    snapshot_block: 4,
};

describe('checkpoint supersede suffix bytes @regression', function () {
    it('leaves a plain checkpoint canonical unchanged when the module is loaded', function () {
        let before = canonicalForms.canonicalCheckpoint(plainCheckpoint);
        expect(canonicalForms.checkpointRootSuffix(plainCheckpoint)).to.equal('');

        require('../../../../src/anchor/checkpoint_engine/supersede_suffix.js');

        expect(canonicalForms.checkpointRootSuffix(plainCheckpoint)).to.equal('');
        expect(canonicalForms.canonicalCheckpoint(plainCheckpoint)).to.equal(before);
    });

    it('returns an empty suffix when both supersession fields are absent', function () {
        const { hasSupersedeFields, supersedeSuffix } = require('../../../../src/anchor/checkpoint_engine/supersede_suffix.js');

        expect(hasSupersedeFields(plainCheckpoint)).to.equal(false);
        expect(supersedeSuffix(plainCheckpoint)).to.equal('');
    });

    it('emits exact SUPERSEDE bytes from a string height and uppercase digest', function () {
        const { hasSupersedeFields, supersedeSuffix } = require('../../../../src/anchor/checkpoint_engine/supersede_suffix.js');
        let rulesDigest = 'CD'.repeat(32);
        let cp = { supersedes_from: '12', rules_digest: rulesDigest };

        expect(hasSupersedeFields(cp)).to.equal(true);
        expect(supersedeSuffix(cp)).to.equal('|SUPERSEDE|12|' + rulesDigest.toLowerCase());
    });

    it('throws when only supersedes_from is present', function () {
        const { supersedeSuffix } = require('../../../../src/anchor/checkpoint_engine/supersede_suffix.js');
        expect(() => supersedeSuffix({ supersedes_from: 12 })).to.throw();
    });

    it('throws when only rules_digest is present', function () {
        const { supersedeSuffix } = require('../../../../src/anchor/checkpoint_engine/supersede_suffix.js');
        expect(() => supersedeSuffix({ rules_digest: 'ab'.repeat(32) })).to.throw();
    });

    it('throws for a supersedes_from that is not a non-negative safe integer', function () {
        const { supersedeSuffix } = require('../../../../src/anchor/checkpoint_engine/supersede_suffix.js');
        let digest = 'ab'.repeat(32);

        for (let value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
            expect(() => supersedeSuffix({ supersedes_from: value, rules_digest: digest })).to.throw();
    });

    it('throws when rules_digest is not 64 hexadecimal characters', function () {
        const { supersedeSuffix } = require('../../../../src/anchor/checkpoint_engine/supersede_suffix.js');

        for (let digest of ['cd', 'gg'.repeat(32), 'ab'.repeat(32) + '00'])
            expect(() => supersedeSuffix({ supersedes_from: 1, rules_digest: digest })).to.throw();
    });

});
