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
const messageTypes = require('../../../../src/consensus/pbft/message_types.js');

// Wire names: a rename changes what peers gossip, so each is spelled out here.
const EXPECTED_KEYS = [
    'PBFT_PRE_PREPARE',
    'PBFT_PREPARE',
    'PBFT_COMMIT',
    'PBFT_VIEW_CHANGE',
    'PBFT_NEW_VIEW'
];

describe('pbft message types', () => {
    it('exports exactly the five expected keys', () => {
        expect(Object.keys(messageTypes).sort()).to.deep.equal([...EXPECTED_KEYS].sort());
    });

    it('holds a string equal to its own key for every type', () => {
        for (const key of EXPECTED_KEYS) {
            expect(messageTypes[key], key).to.equal(key);
        }
    });

    it('has five distinct values', () => {
        expect(new Set(Object.values(messageTypes)).size).to.equal(5);
    });

    it('carries no key beyond the expected five', () => {
        const extra = Object.keys(messageTypes).filter((k) => !EXPECTED_KEYS.includes(k));
        expect(extra).to.deep.equal([]);
    });
});
