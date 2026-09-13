#!/usr/bin/env node
/*
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 * A commercial license is available - contact legal@dankest.llc.
 *
 * Oracle round-presence divergence check.
 *
 * Asks every named hub `getoracleroundpresence` over the SAME round range and
 * reports whether the federation agrees about which rounds happened. Testnet
 * rounds 25-27 (2026-08-28) finalized on nobody and left rows on exactly one of
 * five validators; nothing in the hub could state that, because the only round
 * surface returned the rows a hub HAS and a hub holding nothing looked the same
 * as a hub asked about a round that never existed.
 *
 * Usage:
 *   node bin/oracle-round-presence.js --hubs URL[,URL...] [--from N] [--to N]
 *                                     [--limit N] [--json]
 *   HUB_RPC_URLS=http://h1:4000,http://h2:4000 node bin/oracle-round-presence.js
 *
 * The range is resolved ONCE, from the first hub that reports a USABLE range, and
 * every hub is then asked about exactly that range: letting each hub pick its own
 * bounds is how the comparison silently stops comparing (a hub missing the newest
 * rounds would answer about an older window and agree with everyone by never
 * overlapping). "Usable" is not "reachable": an empty hub answers successfully with
 * a null range, and stopping there would abort the check the fleet needs.
 *
 * Read-only: it broadcasts nothing and writes nothing.
 *
 * Exit codes: 0 agreed, 1 divergent, 2 could not compare (an invalid invocation,
 * or fewer than two distinct hubs with a usable answer).
 */
'use strict';

const axios = require('axios');
const { comparePresence } = require('../src/lib/oracle_round_presence.js');

// The URL string is the only hub identity there is: presence answers carry no hub id,
// so two DNS aliases of one host stay indistinguishable and this does not pretend
// otherwise. Collapsing the exact repeats is what stops `--hubs A,A` from clearing the
// two-hub gate, comparing a hub to itself, and printing agreement.
function dedupeHubs(list) {
    const seen = new Set();
    const out = [];
    for (const hub of list) {
        const key = hub.replace(/\/+$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(hub);
    }
    return out;
}

// Explicit bounds are validated before any request, because Number('oops') is NaN and
// JSON.stringify writes NaN as null: every hub would then resolve its own upper bound
// and the run would still print an agreed/divergent verdict over ranges that never
// matched. Returns the normalized number, or an error string naming the flag.
function numericFlag(flag, raw, min) {
    if (raw === null || raw === undefined) return { value: null };
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min)
        return { error: flag + ' must be a whole number >= ' + min + '; got "' + raw + '"' };
    return { value: n };
}

// Argv and env are read here and nowhere else, so the orchestration below can be
// driven from a test. The range-pinning property this tool exists for lives only in
// this file, and a script that parses argv at import time cannot be required at all.
function parseArgs(argv, env) {
    const list = Array.isArray(argv) ? argv : [];
    const arg = (name, fallback) => {
        const i = list.indexOf('--' + name);
        return i === -1 || i === list.length - 1 ? fallback : list[i + 1];
    };
    return {
        hubs: dedupeHubs(String(arg('hubs', (env && env.HUB_RPC_URLS) || ''))
            .split(',').map(s => s.trim()).filter(Boolean)),
        from: arg('from', null),
        to: arg('to', null),
        limit: arg('limit', null),
        json: list.includes('--json')
    };
}

// A hub whose price_snapshots table is empty answers SUCCESSFULLY with a null range
// (XChainHub.getOracleRoundPresence: "an empty range, not a fabricated one"), so an
// answer is not automatically an anchor. Both bounds must be present: a half-null
// range would pin `to_round: null` on every other hub.
function usableRange(presence) {
    return !!presence && presence.from_round !== null && presence.from_round !== undefined
                      && presence.to_round   !== null && presence.to_round   !== undefined;
}

async function ask(hub, params) {
    const res = await axios.post(hub,
        { jsonrpc: '2.0', id: 1, method: 'getoracleroundpresence', params: params },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    const result = res && res.data && res.data.result;
    if (!result || result.error) throw new Error((result && result.error) || 'no result');
    return result;
}

// Returns the exit code rather than exiting, so a test can drive the whole run and
// assert the outcome. Exit codes: 0 agreed, 1 divergent, 2 could not compare.
async function main(opts) {
    const { hubs: HUBS, from: FROM, to: TO, limit: LIMIT, json: JSON_OUT } = opts;
    if (HUBS.length < 2) {
        console.error('Name at least two DISTINCT hubs: --hubs http://h1:4000,http://h2:4000 ' +
            '(or set HUB_RPC_URLS). Comparing one hub to itself proves nothing.');
        return 2;
    }

    const bounds = {};
    for (const [flag, key, raw, min] of [['--from', 'from', FROM, 0],
                                        ['--to', 'to', TO, 0],
                                        ['--limit', 'limit', LIMIT, 1]]) {
        const parsed = numericFlag(flag, raw, min);
        if (parsed.error) { console.error(parsed.error); return 2; }
        bounds[key] = parsed.value;
    }
    if (bounds.from !== null && bounds.to !== null && bounds.from > bounds.to) {
        console.error('--from must not be greater than --to; got ' + bounds.from + ' and ' + bounds.to);
        return 2;
    }

    // Resolve the range from the first hub that reports a usable one, then pin it for
    // everyone. Advancing past an empty answer is the point: a freshly resynced or
    // wiped hub listed first would otherwise abort every run of the check.
    let range = { from_round: bounds.from, to_round: bounds.to, limit: bounds.limit };
    if (range.from_round === null || range.to_round === null) {
        let anchor = null;
        let empty = 0;
        let unreached = 0;
        for (const hub of HUBS) {
            let presence = null;
            try { presence = await ask(hub, { from_round: bounds.from, to_round: bounds.to, limit: bounds.limit }); }
            catch (err) {
                unreached++;
                console.error('warn: ' + hub + ' did not answer: ' + ((err && err.message) || err));
                continue;
            }
            if (usableRange(presence)) { anchor = presence; break; }
            empty++;
            console.error('warn: ' + hub + ' answered with no recorded rounds; trying the next hub.');
        }
        if (!anchor) {
            console.error('No hub returned a usable round range (' + empty +
                ' answered empty, ' + unreached + ' unreachable).');
            return 2;
        }
        range = { from_round: anchor.from_round, to_round: anchor.to_round };
    } else {
        range = { from_round: bounds.from, to_round: bounds.to };
    }

    const answers = [];
    const unreachable = [];
    for (const hub of HUBS) {
        let presence = null;
        try { presence = await ask(hub, range); }
        catch (err) { unreachable.push({ hub, error: (err && err.message) || String(err) }); continue; }
        // Usable means exactly what comparePresence counts as usable. Counting raw
        // replies here while the comparison re-filters for a rounds array lets two
        // hubs, one of them malformed (version skew, a mangling proxy), leave ONE
        // view to be reported as federation agreement.
        if (!presence || !Array.isArray(presence.rounds)) {
            unreachable.push({ hub, error: 'answered without a rounds array' });
            continue;
        }
        answers.push({ hub, presence });
    }
    if (answers.length < 2) {
        console.error('Reached ' + answers.length + ' hub(s) with a usable answer; ' +
            'need at least two to compare.');
        return 2;
    }

    const comparison = comparePresence(answers);
    if (JSON_OUT) {
        console.log(JSON.stringify({ range, unreachable, comparison,
            digests: answers.map(a => ({ hub: a.hub, digest: a.presence.digest,
                                         missing: a.presence.missing })) }, null, 2));
        return comparison.agreed ? 0 : 1;
    }

    console.log('Rounds ' + range.from_round + '-' + range.to_round +
        ' across ' + answers.length + ' hub(s)');
    for (const { hub, presence } of answers) {
        console.log('  ' + hub + '  digest ' + String(presence.digest).slice(0, 16) +
            '  missing ' + (presence.missing.length ? presence.missing.join(',') : 'none'));
    }
    for (const { hub, error } of unreachable) console.log('  ' + hub + '  UNREACHABLE (' + error + ')');

    if (comparison.agreed) {
        console.log('\nAgreed: every hub reports the same outcome for every round in range.');
        return 0;
    }
    console.log('\nDIVERGENT on ' + comparison.divergent.length + ' round(s):');
    for (const d of comparison.divergent) {
        const parts = Object.keys(d.statuses).map(h => h + '=' + d.statuses[h]);
        console.log('  round ' + d.round + ': ' + parts.join('  '));
    }
    return 1;
}

module.exports = { parseArgs, usableRange, ask, main };

if (require.main === module) {
    main(parseArgs(process.argv, process.env))
        .then(code => process.exit(code))
        .catch(err => {
            console.error('oracle-round-presence failed: ' + ((err && err.message) || err));
            process.exit(2);
        });
}
