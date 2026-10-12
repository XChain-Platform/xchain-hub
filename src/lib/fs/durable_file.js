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
 * XChain Hub - atomic rewrite of a durable file
 *
 * The publisher queues and the oracle round buffer are durable JSONL files whose
 * readers treat an empty or unreadable file as "nothing pending". Opening the live
 * file with 'w' empties it before the new text is on disk, so a crash, a power
 * loss or a failed write (ENOSPC, EIO) in that window silently drops every entry.
 * This writes the new text to a sibling temp file, fsyncs it and renames it over
 * the target, the same discipline the relay WAL compaction uses: at every instant
 * the path holds either the complete old file or the complete new one.
 *
 * The caller passes its own `fs`, so a unit test that swaps a module's `fs` for a
 * stub keeps every file operation inside that stub.
 *
 ********************************************************************/

'use strict';

const path = require('path');

// Replace filePath's contents with text so a failure at any step leaves the old
// file whole. Throws to the caller on failure, after removing the temp file.
function rewriteFileAtomically(fsImpl, filePath, text) {
    // Same directory as the target, so the rename stays on one filesystem and is atomic.
    let tmp = filePath + '.tmp';
    let fd = null;
    try {
        fd = fsImpl.openSync(tmp, 'w');
        fsImpl.writeSync(fd, text);
        fsImpl.fsyncSync(fd);
        fsImpl.closeSync(fd);
        fd = null;
        fsImpl.renameSync(tmp, filePath);
    } catch (e) {
        if (fd !== null) { try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ } }
        try { fsImpl.unlinkSync(tmp); } catch (_) { /* best effort */ }
        throw e;
    }
    syncDirectory(fsImpl, path.dirname(filePath));
}

// Make the rename itself durable where the platform supports a directory fsync;
// best effort, because the new file is already complete and in place.
function syncDirectory(fsImpl, dir) {
    let fd = null;
    try {
        fd = fsImpl.openSync(dir, 'r');
        fsImpl.fsyncSync(fd);
    } catch (_) {
        /* best effort: unsupported on some platforms */
    } finally {
        if (fd !== null) { try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ } }
    }
}

// Split JSONL text into the values `accept` keeps and the raw lines it does not
// (unparseable, null, or refused), so a rewrite can keep or quarantine every line.
function splitJsonLines(text, accept) {
    let entries = [];
    let rejected = [];
    for (let line of String(text).split('\n')) {
        if (line.trim().length === 0) continue;
        let value = null;
        try { value = JSON.parse(line); } catch (_) { /* a torn or foreign line, kept raw below */ }
        if (value !== null && accept(value)) entries.push(value);
        else rejected.push(line);
    }
    return { entries: entries, rejected: rejected };
}

module.exports = { rewriteFileAtomically, splitJsonLines };
