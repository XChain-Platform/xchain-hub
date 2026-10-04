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

// installParts puts each part's methods on an engine prototype as non-enumerable,
// writable, configurable properties, and throws on a name claimed twice. A throw is
// not rolled back, so names from earlier parts stay installed.

const { expect } = require('chai');

const { installParts } = require('../../../../src/cross_chain/prototype_parts.js');

const DUPLICATE = 'Duplicate cross-chain method: a is already defined on Engine.prototype';

describe('cross-chain installParts', () => {
    it('installs part members as hidden, writable, configurable own properties', () => {
        class Engine {}
        installParts(Engine.prototype, [{ a() { return 1; } }, { b: 2 }]);

        for(const name of ['a', 'b']){
            const d = Object.getOwnPropertyDescriptor(Engine.prototype, name);
            expect(d.enumerable).to.equal(false);
            expect(d.writable).to.equal(true);
            expect(d.configurable).to.equal(true);
        }
        expect(Object.keys(Engine.prototype)).to.deep.equal([]);
        expect(new Engine().a()).to.equal(1);
        expect(Engine.prototype.b).to.equal(2);
    });

    it('changes nothing for an empty parts list', () => {
        class Engine { own() {} }
        installParts(Engine.prototype, []);
        expect(Object.getOwnPropertyNames(Engine.prototype)).to.deep.equal(['constructor', 'own']);
    });

    it('throws when the target already defines the name', () => {
        class Engine { a() {} }
        expect(() => installParts(Engine.prototype, [{ a() {} }])).to.throw(Error).with.property('message')
            .that.satisfies(m => m.startsWith(DUPLICATE));
    });

    it('throws when two parts claim one name', () => {
        class Engine {}
        expect(() => installParts(Engine.prototype, [{ a() {} }, { a() {} }])).to.throw(Error).with.property('message')
            .that.satisfies(m => m.startsWith(DUPLICATE));
    });

    it('leaves earlier parts installed after a failed install', () => {
        class Engine {}
        expect(() => installParts(Engine.prototype, [{ a: 1 }, { b: 2 }, { a: 3 }])).to.throw(DUPLICATE);
        expect(Engine.prototype.a).to.equal(1);
        expect(Engine.prototype.b).to.equal(2);
    });
});
