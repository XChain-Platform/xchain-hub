// the boundary suite lives in TWO directories and the `test:boundary`
// script has to glob both: globbing one makes `npm run test:boundary` report 14
// passing while 270 more boundary cases sit in test/unit/boundary, reached only
// incidentally by `npm test`. That mismatch is what makes a README
// coverage table read "~7 boundary tests" and puts the whole suite's existence in
// doubt. This guard fails the moment a boundary spec exists that no spec glob
// in the test:boundary script would pick up, so a third boundary directory
// cannot go silently unrun.
//
// A boundary spec is identified by its DIRECTORY, not a filename suffix: the
// naming rule makes every suite <unit>.test.js, so the marker is any directory
// named `boundary` anywhere under test/, and every suite inside it. That reaches
// every boundary directory, which a hardcoded list of the two known
// directories would not: a third one is still found wherever it lands.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const testRoot = path.join(repoRoot, 'test');

// Collect every suite under `dir`, as a repo-relative POSIX path so it can be
// compared against the globs exactly as they are written in package.json.
function findSpecs(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...findSpecs(full));
        } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
            found.push(path.relative(repoRoot, full).split(path.sep).join('/'));
        }
    }
    return found;
}

// Every directory named `boundary` under test/, which is what identifies a
// boundary suite now that the names no longer carry the kind in a suffix.
function findBoundaryDirs(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === 'boundary') found.push(full);
        else found.push(...findBoundaryDirs(full));
    }
    return found;
}

/** Every boundary spec on disk, from every boundary directory under test/. */
function findBoundarySpecs(root) {
    return findBoundaryDirs(root).flatMap(findSpecs);
}

// Minimal glob translation covering the shapes mocha specs actually use here:
// `**` spans directory separators, `*` stops at one, everything else is literal.
function globToRegExp(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                // `**/` may also match zero directories, so the separator is optional.
                if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
            } else {
                out += '[^/]*';
            }
        } else if ('\\^$.|?+()[]{}'.includes(ch)) {
            out += '\\' + ch;
        } else {
            out += ch;
        }
    }
    return new RegExp('^' + out + '$');
}

describe('boundary suite coverage', function () {
    const script = require(path.join(repoRoot, 'package.json')).scripts['test:boundary'];

    it('package.json defines a test:boundary script', function () {
        assert.ok(script, 'no test:boundary script in package.json');
    });

    it('every boundary spec on disk is matched by a test:boundary spec glob', function () {
        // Spec globs are the single-quoted arguments; the flags that follow are not.
        const globs = (script.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
        assert.ok(globs.length > 0, 'test:boundary script has no quoted spec globs');
        const matchers = globs.map(globToRegExp);

        const specs = findBoundarySpecs(testRoot);
        assert.ok(specs.length > 0, 'no boundary specs found under test/');

        const unmatched = specs.filter((f) => !matchers.some((re) => re.test(f)));
        assert.deepStrictEqual(
            unmatched, [],
            `these boundary specs are never run by \`npm run test:boundary\`: ${unmatched.join(', ')}. `
            + `Add their directory to the test:boundary globs in package.json.`,
        );
    });

    it('both known boundary directories are populated', function () {
        // The split is deliberate, not a leftover: test/unit/boundary holds the
        // per-module edge-case suites (they are unit-scoped, so `npm test` and
        // `npm run ci` run them too), while test/boundary holds the flag-day
        // consensus activation gates. Losing either directory is a regression.
        for (const dir of ['test/boundary', 'test/unit/boundary']) {
            const specs = findSpecs(path.join(repoRoot, dir));
            assert.ok(specs.length > 0, `${dir} has no boundary specs`);
        }
    });
});
