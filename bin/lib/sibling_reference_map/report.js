/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * What the CLI writes: the per-repo census, the pin with the commit inventory it
 * was taken against, and the human summary.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const { getRepoRoot } = require('./repo_root.js');
const { PLATFORM_TOOLING_ENV } = require('./walk.js');

/**
 * The src/ inventory of a commit, read without touching the working tree.
 *
 * WHY THE PIN CARRIES IT. `exists` in a pin is only ever true of the tree the
 * pin was taken from, so a pin taken after a move has begun cannot tell a
 * reference that was always stale from one the move just broke. The commit's own
 * file list can, and it is the same answer whenever it is read.
 */
function srcInventoryAt(sha) {
    if (!sha) return null;
    try {
        const out = require('child_process').execFileSync(
            'git', ['ls-tree', '-r', '--name-only', sha, 'src'],
            { cwd: getRepoRoot(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        );
        return out.split('\n').filter(Boolean).sort();
    } catch (e) {
        return null;
    }
}

/**
 * The per-repo census a restructure is actually scheduled from: how many sites
 * in each sibling would BREAK on a move (a require or a built path) against how
 * many would merely go stale (a comment or a runbook line).
 *
 * The two are kept apart because they cost different things. An executable site
 * gates a push: the sibling's CI goes red until it is repointed, so the hub half
 * and the sibling half of the move have to land as a pair. A mention costs a
 * misleading document, which can follow later in a repo of its own.
 *
 * @param {object} map a built reference map
 * @returns {object} totals, then one entry per referring repo
 */
function referenceCensus(map) {
    const repos = {};
    let executable = 0;
    let mentions = 0;
    for (const [rel, entry] of Object.entries(map.paths)) {
        for (const ref of entry.referrers) {
            if (!repos[ref.repo]) {
                repos[ref.repo] = { executableSites: 0, mentionSites: 0, files: new Set(), paths: new Set() };
            }
            const row = repos[ref.repo];
            // `kind` is the load-or-mention split the map already makes: a require,
            // an import or a built path is executable, plain prose is not.
            if (ref.kind === 'text') { row.mentionSites += 1; mentions += 1; } else { row.executableSites += 1; executable += 1; }
            row.files.add(ref.file);
            row.paths.add(rel);
        }
    }
    const byRepo = {};
    for (const name of Object.keys(repos).sort()) {
        const row = repos[name];
        byRepo[name] = {
            executableSites: row.executableSites,
            mentionSites: row.mentionSites,
            referringFiles: row.files.size,
            distinctHubPaths: row.paths.size,
            // What a move costs here, in one word, so the wave plan can be read
            // off this file rather than re-derived from the site list.
            gatesAPush: row.executableSites > 0,
        };
    }
    return {
        totals: {
            siblingReposSwept: map.siblingRepos.length,
            distinctHubPaths: map.distinctPathCount,
            pathsResolvingToAFile: map.existingPathCount,
            referenceSites: map.referenceCount,
            executableSites: executable,
            mentionSites: mentions,
            reposGatingAPush: Object.values(byRepo).filter((r) => r.gatesAPush).length,
            dynamicReferences: map.dynamicReferenceCount,
        },
        byRepo,
        dynamicReferences: map.dynamicReferences,
    };
}

/** --census: the per-repo census as JSON, with the tree it was taken against. */
function writeCensus(map, opts) {
    const census = Object.assign({
        censusMetadata: {
            tool: 'bin/sibling-reference-map.js --census',
            capturedAt: new Date().toISOString(),
            hubSha: opts.baseSha || null,
            siblingsRoot: path.relative(getRepoRoot(), opts.siblings) || '.',
            note: opts.note || null,
        },
    }, referenceCensus(map));
    fs.mkdirSync(path.dirname(opts.census), { recursive: true });
    fs.writeFileSync(opts.census, `${JSON.stringify(census, null, 2)}\n`);
    console.log(`census written: ${opts.census}`);
    console.log(`  ${census.totals.executableSites} executable sites and ${census.totals.mentionSites} mentions `
        + `across ${census.totals.siblingReposSwept} repos; ${census.totals.reposGatingAPush} gate a push`);
}

/** --pin: the whole map, plus the metadata that says which tree it describes. */
function writePin(map, opts) {
    const pinned = Object.assign({
        pinMetadata: {
            tool: 'bin/sibling-reference-map.js',
            capturedAt: new Date().toISOString(),
            hubSha: opts.baseSha || null,
            // Relative to this checkout, never as the operator spelled it: an
            // absolute path names somebody's machine and pins to no tree at all.
            siblingsRoot: path.relative(getRepoRoot(), opts.siblings) || '.',
            note: opts.note || null,
            hubSrcFilesAtBaseSha: srcInventoryAt(opts.baseSha),
        },
    }, map);
    fs.writeFileSync(opts.pin, `${JSON.stringify(pinned, null, 2)}\n`);
    console.log(`pin written: ${opts.pin}`);
    console.log(`  ${pinned.distinctPathCount} distinct paths, ${pinned.existingPathCount} resolving, `
        + `${pinned.referenceCount} reference sites`);
}

/** The default human summary. */
function printSummary(map) {
    console.log(`sibling repos swept: ${map.siblingRepos.length} (${map.siblingRepos.join(', ')})`);
    console.log(`platform tooling swept: ${map.platformToolingSwept.length
        ? map.platformToolingSwept.join(', ')
        : `none (opt in with --include-platform-tooling and ${PLATFORM_TOOLING_ENV})`}`);
    console.log(`distinct hub src/ paths referenced: ${map.distinctPathCount} `
        + `(${map.existingPathCount} resolve to a file in the tree)`);
    console.log(`total reference sites: ${map.referenceCount} `
        + `(require ${map.referenceCountByKind.require}, `
        + `join ${map.referenceCountByKind.join}, mention ${map.referenceCountByKind.text})`);
    console.log('reference sites by form: '
        + Object.keys(map.referenceCountByForm).map((f) => `${f} ${map.referenceCountByForm[f]}`).join(', '));
    console.log(`unresolvable path references: ${Object.values(map.paths).filter((p) => !p.exists).length}`);
    console.log(`dynamic references (a human checks these on a rename): ${map.dynamicReferenceCount} `
        + `(${Object.keys(map.dynamicReferenceCountByForm)
            .map((f) => `${f} ${map.dynamicReferenceCountByForm[f]}`).join(', ')})`);
    console.log('');
    const perRepo = {};
    for (const entry of Object.values(map.paths)) {
        for (const ref of entry.referrers) perRepo[ref.repo] = (perRepo[ref.repo] || 0) + 1;
    }
    console.log('reference sites per repo:');
    for (const repo of Object.keys(perRepo).sort()) console.log(`  ${repo.padEnd(24)} ${perRepo[repo]}`);
}

module.exports = { srcInventoryAt, referenceCensus, writeCensus, writePin, printSummary };
