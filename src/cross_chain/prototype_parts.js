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
 *
 * XChain Hub - Cross-Chain Prototype Parts
 *
 * Each cross-chain engine keeps its entry points and its consensus-carrying code in
 * one file and holds the rest in part files beside it, one per behaviour, each
 * exporting an object of methods. installParts() puts those methods on the engine's
 * prototype at load time, so every call site keeps writing engine.method() and no
 * caller, test or sibling repo knows which file a method lives in.
 *
 * The install uses Object.defineProperties with enumerable false, the shape
 * src/db/index.js uses for its table mixins rather than the Object.assign the style
 * guide names: class methods are non-enumerable, so an assigned part would be the only
 * prototype member for...in and Object.keys(Engine.prototype) can see, and that is
 * behaviour rather than layout. writable and configurable stay true so a test can still
 * stub a moved method and restore it.
 *
 * A name claimed twice throws at load. Two parts, or a part and the class itself,
 * silently overwriting one another is the failure a split makes possible, and a
 * half-installed engine would only show up as a consensus divergence much later.
 *
 ********************************************************************/

function installParts(target, parts){
    for(const part of parts){
        const descriptors = {};
        for(const name of Object.keys(part)){
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate cross-chain method: ' + name + ' is already defined on ' +
                    target.constructor.name + '.prototype. Two parts, or a part and the class, claim the same name.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

module.exports = { installParts };
