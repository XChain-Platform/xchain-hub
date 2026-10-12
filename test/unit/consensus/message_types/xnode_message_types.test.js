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
const xnode = require('../../../../src/consensus/full_node_challenge_round/message_types.js');
const pbft = require('../../../../src/consensus/pbft/message_types.js');

const KEYS = ['XNODE_ANSWER', 'XNODE_SIGN_REQ', 'XNODE_SIGN', 'XNODE_DONE'];

describe('full-node challenge round message types', () => {
    it('exports exactly the four round types', () => {
        expect(Object.keys(xnode).sort()).to.deep.equal([...KEYS].sort());
    });

    it('spells each wire name as its own key', () => {
        for (const key of KEYS) {
            expect(xnode[key]).to.be.a('string');
            expect(xnode[key]).to.equal(key);
        }
    });

    it('keeps the four values distinct', () => {
        expect(new Set(Object.values(xnode)).size).to.equal(KEYS.length);
    });

    it('does not collide with any pbft message type', () => {
        const pbftValues = new Set(Object.values(pbft));
        expect(pbftValues.size).to.be.greaterThan(0);
        for (const value of Object.values(xnode)) {
            expect(pbftValues.has(value), value).to.equal(false);
        }
    });
});
