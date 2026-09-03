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
 * The range is resolved ONCE, from the first reachable hub, and every hub is then
 * asked about exactly that range: letting each hub pick its own bounds is how the
 * comparison silently stops comparing (a hub missing the newest rounds would
 * answer about an older window and agree with everyone by never overlapping).
 *
 * Read-only: it broadcasts nothing and writes nothing.
 *
 * Exit codes: 0 agreed, 1 divergent, 2 could not reach enough hubs.
 */
'use strict';

const axios = require('axios');
const { comparePresence } = require('../src/lib/oracle_round_presence.js');

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

const HUBS = String(arg('hubs', process.env.HUB_RPC_URLS || ''))
    .split(',').map(s => s.trim()).filter(Boolean);
const FROM  = arg('from', null);
const TO    = arg('to', null);
const LIMIT = arg('limit', null);
const JSON_OUT = process.argv.includes('--json');

async function ask(hub, params) {
    const res = await axios.post(hub,
        { jsonrpc: '2.0', id: 1, method: 'getoracleroundpresence', params: params },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    const result = res && res.data && res.data.result;
    if (!result || result.error) throw new Error((result && result.error) || 'no result');
    return result;
}

async function main() {
    if (HUBS.length < 2) {
        console.error('Name at least two hubs: --hubs http://h1:4000,http://h2:4000 ' +
            '(or set HUB_RPC_URLS). Comparing one hub to itself proves nothing.');
        process.exit(2);
    }

    // Resolve the range from the first hub that answers, then pin it for everyone.
    let range = { from_round: FROM, to_round: TO, limit: LIMIT };
    if (range.from_round === null || range.to_round === null) {
        let anchor = null;
        for (const hub of HUBS) {
            try { anchor = await ask(hub, { from_round: FROM, to_round: TO, limit: LIMIT }); break; }
            catch (err) { console.error('warn: ' + hub + ' did not answer: ' + ((err && err.message) || err)); }
        }
        if (!anchor || anchor.from_round === null) {
            console.error('No hub answered with a usable round range.');
            process.exit(2);
        }
        range = { from_round: anchor.from_round, to_round: anchor.to_round };
    } else {
        range = { from_round: Number(FROM), to_round: Number(TO) };
    }

    const answers = [];
    const unreachable = [];
    for (const hub of HUBS) {
        try { answers.push({ hub, presence: await ask(hub, range) }); }
        catch (err) { unreachable.push({ hub, error: (err && err.message) || String(err) }); }
    }
    if (answers.length < 2) {
        console.error('Reached ' + answers.length + ' hub(s); need at least two to compare.');
        process.exit(2);
    }

    const comparison = comparePresence(answers);
    if (JSON_OUT) {
        console.log(JSON.stringify({ range, unreachable, comparison,
            digests: answers.map(a => ({ hub: a.hub, digest: a.presence.digest,
                                         missing: a.presence.missing })) }, null, 2));
        process.exit(comparison.agreed ? 0 : 1);
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
        process.exit(0);
    }
    console.log('\nDIVERGENT on ' + comparison.divergent.length + ' round(s):');
    for (const d of comparison.divergent) {
        const parts = Object.keys(d.statuses).map(h => h + '=' + d.statuses[h]);
        console.log('  round ' + d.round + ': ' + parts.join('  '));
    }
    process.exit(1);
}

main().catch(err => {
    console.error('oracle-round-presence failed: ' + ((err && err.message) || err));
    process.exit(2);
});
