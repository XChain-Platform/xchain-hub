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

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { expect } = require('chai');
const { rewriteFileAtomically, splitJsonLines } = require('../../../../src/lib/fs/durable_file');

// A real-filesystem fs whose named operation throws, every other call passing through.
function fsFailingAt(name, code) {
    return Object.assign({}, fs, {
        [name]: () => { throw Object.assign(new Error(code + ': injected'), { code }); }
    });
}

describe('rewriteFileAtomically', function () {
    let dir, file;

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-file-'));
        file = path.join(dir, 'queue.jsonl');
        fs.writeFileSync(file, 'old-1\nold-2\n');
    });

    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('replaces the contents and leaves no temp file behind', function () {
        rewriteFileAtomically(fs, file, 'new-1\n');
        expect(fs.readFileSync(file, 'utf8')).to.equal('new-1\n');
        expect(fs.readdirSync(dir)).to.deep.equal(['queue.jsonl']);
    });

    it('writes an empty file when given empty text', function () {
        rewriteFileAtomically(fs, file, '');
        expect(fs.readFileSync(file, 'utf8')).to.equal('');
    });

    // The failure the helper exists for: a write that dies after the open.
    it('keeps the old file whole when the write fails, and throws', function () {
        expect(() => rewriteFileAtomically(fsFailingAt('writeSync', 'ENOSPC'), file, 'new-1\n')).to.throw(/ENOSPC/);
        expect(fs.readFileSync(file, 'utf8')).to.equal('old-1\nold-2\n');
        expect(fs.readdirSync(dir)).to.deep.equal(['queue.jsonl']);
    });

    it('keeps the old file whole when the fsync fails, and throws', function () {
        expect(() => rewriteFileAtomically(fsFailingAt('fsyncSync', 'EIO'), file, 'new-1\n')).to.throw(/EIO/);
        expect(fs.readFileSync(file, 'utf8')).to.equal('old-1\nold-2\n');
        expect(fs.readdirSync(dir)).to.deep.equal(['queue.jsonl']);
    });

    it('keeps the old file whole when the rename fails, and throws', function () {
        expect(() => rewriteFileAtomically(fsFailingAt('renameSync', 'EIO'), file, 'new-1\n')).to.throw(/EIO/);
        expect(fs.readFileSync(file, 'utf8')).to.equal('old-1\nold-2\n');
        expect(fs.readdirSync(dir)).to.deep.equal(['queue.jsonl']);
    });

    // The pre-fix shape, kept as the control: opening the live file with 'w' and
    // failing the write leaves it empty, which is what the helper must never do.
    it('control: a truncating rewrite that fails the write empties the file', function () {
        const failing = fsFailingAt('writeSync', 'ENOSPC');
        const fd = failing.openSync(file, 'w');
        try { failing.writeSync(fd, 'new-1\n'); } catch (_) { /* expected */ }
        fs.closeSync(fd);
        expect(fs.readFileSync(file, 'utf8')).to.equal('');
    });
});

// A queue reader must hand back every line it cannot use, so a rewrite can keep it.
describe('splitJsonLines', function () {
    it('keeps accepted values and returns every other non-blank line raw', function () {
        const torn = '{"round":5,"pri{"round":6}';
        const text = '{"round":1}\n\n' + torn + '\nnull\n{"other":2}\n';
        const out = splitJsonLines(text, (v) => v.round !== undefined);
        expect(out.entries).to.deep.equal([{ round: 1 }]);
        expect(out.rejected).to.deep.equal([torn, 'null', '{"other":2}']);
    });

    it('returns empty lists for empty text', function () {
        expect(splitJsonLines('', () => true)).to.deep.equal({ entries: [], rejected: [] });
    });
});
