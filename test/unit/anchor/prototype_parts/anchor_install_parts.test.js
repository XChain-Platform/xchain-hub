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

// Verify installed part members stay hidden from enumeration while remaining
// replaceable and removable by later prototype assembly.

const { expect }        = require('chai');
const { installParts }  = require('../../../../src/anchor/install_parts');

describe('anchor installParts', function () {
    it('installs every part member as an own, non-enumerable, writable, configurable property', function () {
        const proto = {};
        installParts(proto, [{ a() { return 1; } }, { b: 2 }]);
        expect(Object.prototype.hasOwnProperty.call(proto, 'a')).to.equal(true);
        expect(Object.prototype.hasOwnProperty.call(proto, 'b')).to.equal(true);
        expect(Object.keys(proto)).to.deep.equal([]);
        for (const name of ['a', 'b']) {
            const d = Object.getOwnPropertyDescriptor(proto, name);
            expect(d.enumerable).to.equal(false);
            expect(d.writable).to.equal(true);
            expect(d.configurable).to.equal(true);
        }
        expect(proto.a()).to.equal(1);
        expect(proto.b).to.equal(2);
    });

    it('keeps a getter as a getter', function () {
        const proto = {};
        const part = { get g() { return 7; } };
        const getter = Object.getOwnPropertyDescriptor(part, 'g').get;
        installParts(proto, [part]);
        const d = Object.getOwnPropertyDescriptor(proto, 'g');
        expect(d.get).to.equal(getter);
        expect(d.enumerable).to.equal(false);
        expect(proto.g).to.equal(7);
    });

    it('changes nothing for an empty parts list', function () {
        const proto = { existing: 1 };
        installParts(proto, []);
        expect(Object.getOwnPropertyNames(proto)).to.deep.equal(['existing']);
    });

    it('throws when the name is already an own property of the target', function () {
        const proto = { a: 1 };
        expect(() => installParts(proto, [{ a: 2 }]))
            .to.throw('installParts: a is already on the prototype');
        expect(proto.a).to.equal(1);
    });

    it('throws naming the name when two parts claim it', function () {
        const proto = {};
        expect(() => installParts(proto, [{ a: 1 }, { a: 2 }]))
            .to.throw('installParts: a is already on the prototype');
    });

    it('installs a name that exists only on the prototype chain', function () {
        const parent = { a: 'inherited' };
        const proto = Object.create(parent);
        installParts(proto, [{ a: 'own' }]);
        expect(Object.prototype.hasOwnProperty.call(proto, 'a')).to.equal(true);
        expect(proto.a).to.equal('own');
        expect(parent.a).to.equal('inherited');
    });
});
