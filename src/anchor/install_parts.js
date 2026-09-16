/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Hub - prototype part installer (anchor classes)
 *
 * The three anchor classes keep their file as the class, and their method
 * groups live in part modules beside it. This puts a part's methods on the
 * prototype the way `class` syntax would.
 *
 * Non-enumerable, because class methods are: an assigned mixin would be the
 * only prototype member for...in and Object.keys(Class.prototype) can see, and
 * what a prototype enumerates is behaviour rather than layout. writable and
 * configurable stay true so a test can still stub a moved method and restore
 * it. A name already on the prototype throws rather than overwrite, so two
 * parts claiming one method is a load-time failure and not a silent last-one-wins.
 *
 ********************************************************************/

'use strict';

function installParts(target, parts){
    for(const part of parts){
        let descriptors = Object.getOwnPropertyDescriptors(part);
        for(const name of Object.keys(descriptors)){
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('installParts: ' + name + ' is already on the prototype');
            descriptors[name].enumerable = false;
        }
        Object.defineProperties(target, descriptors);
    }
}

module.exports = { installParts };
