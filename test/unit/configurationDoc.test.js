// : CONFIGURATION.md drift guard.
//
// Every ANCHOR_/XDEX_/CHECKPOINT_/FULLNODE_ env var read anywhere in src/
// must be documented in CONFIGURATION.md. These families were the ~42-var
// undocumented blind spot from the 2026-06-24 maintainability review; this
// test keeps new knobs in those families from shipping undocumented.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const DOC = path.join(ROOT, 'CONFIGURATION.md');

const ENV_RE = /process\.env\.((?:ANCHOR|XDEX|CHECKPOINT|FULLNODE)_[A-Z_0-9]+)/g;
const COIN_SUFFIX_RE = /_(BTC|LTC|DOGE)$/;

function walkJs(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            walkJs(full, out);
        } else if (entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

describe('CONFIGURATION.md env-var coverage ', function () {

    it('documents every ANCHOR_/XDEX_/CHECKPOINT_/FULLNODE_ env var read in src/', function () {
        const doc = fs.readFileSync(DOC, 'utf8');

        const used = new Set();
        for (const file of walkJs(SRC, [])) {
            const text = fs.readFileSync(file, 'utf8');
            let m;
            while ((m = ENV_RE.exec(text)) !== null) used.add(m[1]);
        }
        assert.ok(used.size >= 20,
            `expected to find the known env-var families in src/, got ${used.size}`);

        const missing = [...used].filter(name => {
            if (doc.includes(name)) return false;
            // Per-coin families may be documented as FOO_<COIN>.
            if (COIN_SUFFIX_RE.test(name)) {
                return !doc.includes(name.replace(COIN_SUFFIX_RE, '_<COIN>'));
            }
            return true;
        }).sort();

        assert.deepStrictEqual(missing, [],
            'env vars read in src/ but undocumented in CONFIGURATION.md: ' + missing.join(', '));
    });
});
