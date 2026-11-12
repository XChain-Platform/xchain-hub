'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Remembers peer rows catch-up refused for a lasting local reason, so a re-walk neither
// re-verifies nor re-logs them. The key covers the row's content, so a row the peer
// later changes in place (a round it finalizes) is verified again.
//
// With a store the memo outlives a restart, so a restarted hub does not re-verify the same
// tens of thousands of refused rows before it reads as caught up. A stored memo is used only
// when the same hub release and schema wrote it: an upgrade may accept rows the old verifier
// refused, so it starts from an empty memo and judges again. maxAgeMs counts from the last
// save, so it drops a memo a long-stopped hub left behind, not individual old entries.
// Without a path or store the memo does no IO, so constructing a catch-up in a test writes nothing.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { rewriteFileAtomically } = require('../../lib/fs/durable_file.js');
const { HUB_SCHEMA_VERSION } = require('../../hub_schema_version.js');
const HUB_VERSION = require('../../../package.json').version;

const DEFAULT_MAX_ENTRIES = 500000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STORE_FORMAT = 1;

function contentHash(row) {
    const columns = Object.keys(row || {}).filter(column => column !== 'id').sort();
    const body = JSON.stringify(columns.map(column => [column, row[column]]));
    return crypto.createHash('sha256').update(body).digest('hex');
}

// Beside the hub's other ./data queue files, which already survive a container restart.
const DEFAULT_REFUSAL_MEMO_PATH = path.join('./data', 'peer-catchup-refusals.json');

// A JSON file store; a missing file reads as no stored memo.
function createFileRefusalStore(filePath, fsImpl = fs) {
    return {
        read() {
            try { return JSON.parse(fsImpl.readFileSync(filePath, 'utf8')); }
            catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
        },
        write(record) {
            fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
            rewriteFileAtomically(fsImpl, filePath, JSON.stringify(record));
        }
    };
}

function storeStamp() {
    return { format: STORE_FORMAT, hubVersion: HUB_VERSION, schemaVersion: HUB_SCHEMA_VERSION };
}

// Keys from a record this release wrote within maxAgeMs, or none.
function usableStoredKeys(record, maxAgeMs, now) {
    if (!record || typeof record !== 'object' || !Array.isArray(record.keys)) return [];
    const stamp = storeStamp();
    if (Object.keys(stamp).some(field => record[field] !== stamp[field])) return [];
    const age = now - Number(record.savedAt);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return [];
    return record.keys.filter(key => typeof key === 'string');
}

function resolveStore({ store, filePath }) {
    if (store) return store;
    return filePath ? createFileRefusalStore(filePath) : null;
}

function createRefusalMemo(options = {}) {
    const limit = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : DEFAULT_MAX_ENTRIES;
    const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : DEFAULT_MAX_AGE_MS;
    const now = options.now || Date.now;
    const store = resolveStore(options);
    // A store failure must never fail a walk: the memo only saves verifier work.
    let warned = false;
    const warnStore = (verb, e) => {
        if (warned || typeof options.warn !== 'function') return;
        warned = true;
        options.warn('Hub DB peer catch-up: refusal memo ' + verb + ' failed: ' + (e && e.message ? e.message : e));
    };
    // A Set iterates in insertion order, so its first entry is always the oldest.
    const keys = new Set();
    let loaded = !store, dirty = false;

    function keyFor(peerIdentity, table, row) {
        const parts = [String(peerIdentity), String(table), Number(row && row.id), contentHash(row)];
        return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64');
    }

    function load() {
        if (loaded) return;
        loaded = true;
        let stored = [];
        try { stored = usableStoredKeys(store.read(), maxAgeMs, now()); }
        catch (e) { warnStore('load', e); }
        for (const key of stored.slice(-limit)) keys.add(key);
    }

    function has(key) {
        load();
        return keys.has(key);
    }

    function remember(key) {
        load();
        keys.delete(key);
        keys.add(key);
        dirty = true;
        while (keys.size > limit) keys.delete(keys.values().next().value);
    }

    // Called once per finished walk, never per row; writes only when something new was remembered.
    function flush() {
        if (!store || !dirty) return false;
        try {
            store.write(Object.assign(storeStamp(), { savedAt: now(), keys: [...keys] }));
            dirty = false;
            return true;
        } catch (e) {
            warnStore('save', e);
            return false;
        }
    }

    return { keyFor, has, remember, flush, size: () => { load(); return keys.size; } };
}

module.exports = {
    createRefusalMemo, createFileRefusalStore, DEFAULT_REFUSAL_MEMO_PATH, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_AGE_MS
};
