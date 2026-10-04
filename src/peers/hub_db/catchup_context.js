'use strict';

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
