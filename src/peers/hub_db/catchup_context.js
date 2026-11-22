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

const hubsByDb = new WeakMap();

function rememberCatchupHub(hub) {
    if (!hub || !hub.db || (typeof hub.db !== 'object' && typeof hub.db !== 'function')) return false;
    hubsByDb.set(hub.db, hub);
    return true;
}

function catchupHub(context) {
    if (context && context.hub) return context.hub;
    const db = context && context.db;
    if (!db || (typeof db !== 'object' && typeof db !== 'function')) return null;
    return hubsByDb.get(db) || null;
}

module.exports = { rememberCatchupHub, catchupHub };
