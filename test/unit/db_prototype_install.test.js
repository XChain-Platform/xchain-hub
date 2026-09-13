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
 **********************************************************************
 * The db mixin install, which is the whole contract of the db/ split.
 *
 * Every query method lives in a table-family mixin and reaches callers only
 * through Object.defineProperties on Database.prototype, so three properties
 * have to hold or a caller breaks in a way no other suite would catch: the
 * method is THERE, it is NON-ENUMERABLE like the class methods beside it (an
 * enumerable one would show up in for...in and Object.keys, which is behaviour
 * the split must not change), and it is still writable and configurable, which
 * is what lets a test stub it and put it back. Two mixins claiming one name is
 * the fourth failure, and it must be loud at load rather than last-one-wins.
 *
 * The mixin list is read off the directory, so a family added later is covered
 * the day it lands instead of the day someone remembers this file.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');

const Database = require('../../src/db');

const DB_DIR = path.join(__dirname, '..', '..', 'src', 'db');

// Every mixin file beside index.js, as { file: <name>.js, methods: [...] }.
function readMixins(){
    return fs.readdirSync(DB_DIR)
        .filter(f => f.endsWith('.js') && f !== 'index.js')
        .sort()
        .map(file => ({ file, methods: Object.keys(require(path.join(DB_DIR, file))) }));
}

describe('db mixin install', function(){

    const mixins = readMixins();

    it('finds the table-family mixins beside index.js', function(){
        expect(mixins.length).to.be.greaterThan(0);
        // A family file that exports something other than a plain method object
        // would install nothing and fail silently, so the shape is asserted here.
        for(const m of mixins)
            expect(require(path.join(DB_DIR, m.file)), m.file).to.be.an('object');
    });

    it('installs every mixin method on Database.prototype', function(){
        for(const m of mixins)
            for(const name of m.methods)
                expect(Database.prototype[name], m.file + ' -> ' + name).to.be.a('function');
    });

    it('installs every mixin file in the directory, so none is missing from the MIXINS list', function(){
        // index.js lists its mixins literally. A family file added beside it but never
        // listed would install nothing, so each file is checked by identity: every one
        // of its exports must be the very function the prototype carries, and a file
        // that fails is named here instead of surfacing later as one missing method.
        // A family that exports no methods yet installs nothing either way, so there is
        // nothing to compare; the day it gains a method this identity check covers it.
        const notInstalled = mixins
            .filter(m => m.methods.some(name => Database.prototype[name] !== require(path.join(DB_DIR, m.file))[name]))
            .map(m => m.file);
        expect(notInstalled, 'src/db mixin files not installed on Database.prototype').to.deep.equal([]);
    });

    it('installs them NON-enumerably, so the prototype enumerates what it always did', function(){
        const enumerableOwn = Object.keys(Database.prototype);
        expect(enumerableOwn).to.deep.equal([]);
        for(const m of mixins)
            for(const name of m.methods){
                const d = Object.getOwnPropertyDescriptor(Database.prototype, name);
                expect(d, m.file + ' -> ' + name).to.be.an('object');
                expect(d.enumerable, m.file + ' -> ' + name + ' enumerable').to.equal(false);
                expect(d.writable, m.file + ' -> ' + name + ' writable').to.equal(true);
                expect(d.configurable, m.file + ' -> ' + name + ' configurable').to.equal(true);
            }
    });

    it('keeps every mixin method out of a for...in over an instance', function(){
        const instance = Object.create(Database.prototype);
        const seen = [];
        for(const key in instance) seen.push(key);
        expect(seen).to.deep.equal([]);
    });

    it('serves the methods to an Object.create(Database.prototype) stand-in', function(){
        const db = Object.create(Database.prototype);
        const calls = [];
        db.doQuery = async function(sql, args){ calls.push({ sql, args }); return []; };
        // getLastSeq is a moved method with no arguments and a defined empty-row
        // answer, so calling it proves the installed function runs against a
        // hand-built stand-in exactly as it did when it was a class method.
        return db.getLastSeq().then(function(seq){
            expect(seq).to.equal(0);
            expect(calls.length).to.equal(1);
            expect(calls[0].sql).to.contain('consensus_state');
        });
    });

    it('lets sinon stub a moved method on the prototype and restore it', function(){
        const original = Database.prototype.getLastSeq;
        const stub = sinon.stub(Database.prototype, 'getLastSeq').resolves(41);
        return Database.prototype.getLastSeq().then(function(seq){
            expect(seq).to.equal(41);
            stub.restore();
            expect(Database.prototype.getLastSeq).to.equal(original);
            // The restore must put the property back the way the install made it,
            // or the next stub of the same method changes what the prototype
            // enumerates.
            const d = Object.getOwnPropertyDescriptor(Database.prototype, 'getLastSeq');
            expect(d.enumerable).to.equal(false);
        });
    });

    it('gives no method name to two mixins, and none to a mixin and the class', function(){
        const owner = new Map();
        for(const m of mixins)
            for(const name of m.methods){
                expect(owner.has(name), name + ' is defined by both ' + owner.get(name) + ' and ' + m.file)
                    .to.equal(false);
                owner.set(name, m.file);
            }
        // The class's own members are the other half of the collision space: a
        // mixin that redefined doQuery or getConnection would be installed over
        // the plumbing every one of these methods calls.
        const classMembers = Object.getOwnPropertyNames(Database.prototype)
            .filter(n => !owner.has(n));
        for(const name of ['constructor', 'doQuery', 'getConnection', 'runMigrations', 'close'])
            expect(classMembers, name + ' must still be the class\'s own').to.include(name);
    });
});
