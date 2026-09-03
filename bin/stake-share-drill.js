#!/usr/bin/env node
/*
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 * A commercial license is available - contact legal@dankest.llc.
 *
 * Stake-share drill.
 *
 * Reads a running hub's `getstakeshare` and prints, per chain and capability,
 * how much further third-party stake the federation can absorb before the
 * STAKE_WEIGHTED_QUORUM commit gate (3*tally > 2*S) stops being reachable, plus
 * what a competing stake of a given size would do to that margin.
 *
 * The full drill, on a regtest venue:
 *   1. node bin/stake-share-drill.js --hub http://127.0.0.1:4000    (before)
 *   2. broadcast a STAKE from an address that is NOT an operator source
 *   3. re-run once the stake activates                              (after)
 * The level must rise on step 3 while `meets_gate` is still true: the point of
 * the monitor is that the warning arrives while rounds are still finalizing.
 *
 * --add lets an operator ask the same question about the LIVE network without
 * putting stake on it, which is how you size a top-up.
 *
 * Read-only: it broadcasts nothing and writes nothing.
 *
 * Usage:
 *   node bin/stake-share-drill.js [--hub URL] [--add AMOUNT] [--json]
 *   HUB_RPC_URL=http://127.0.0.1:4000 node bin/stake-share-drill.js --add 25000
 */
'use strict';

const axios = require('axios');
const { projectCompetingStake } = require('../src/lib/stake_share_monitor.js');

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

const HUB  = arg('hub', process.env.HUB_RPC_URL || 'http://127.0.0.1:4000');
const ADD  = arg('add', null);
const JSON_OUT = process.argv.includes('--json');

// The /health body and this RPC report snake_case; the evaluator speaks
// camelCase. One place converts, so the projection is fed exactly the numbers
// the hub reported rather than a re-derivation of them.
function toEvaluation(row) {
    return {
        totalStake:    row.total_stake,
        operatorStake: row.operator_stake,
        unitStake:     row.unit_stake,
        unitStakeFrom: row.unit_stake_from,
        headroom:      row.headroom,
        stakesToHalt:  row.stakes_to_halt,
        meetsGate:     row.meets_gate,
        level:         row.level
    };
}

async function main() {
    let res;
    try {
        res = await axios.post(HUB, { jsonrpc: '2.0', id: 1, method: 'getstakeshare', params: {} },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    } catch (err) {
        console.error('Could not reach the hub at ' + HUB + ': ' + ((err && err.message) || err));
        process.exit(2);
    }
    const result = res && res.data && res.data.result;
    if (!result) { console.error('The hub returned no result for getstakeshare.'); process.exit(2); }
    if (result.active === false) {
        console.error('No stake-share watcher is running on this hub. Set HUB_OPERATOR_STAKE_SOURCES_<COIN> ' +
            '(or HUB_OPERATOR_STAKE_SOURCES) to the staking addresses this operator controls and restart it.');
        process.exit(3);
    }
    if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); return; }

    console.log('Gate: ' + result.gate);
    console.log('Alerting: ' + (result.alerting ? 'YES' : 'no') +
        (result.worst ? '  (worst: ' + result.worst.level + ' on ' + result.worst.chain + '/' +
            result.worst.capability + ')' : ''));
    console.log('');

    for (const chain of Object.keys(result.chains || {})) {
        for (const cap of Object.keys(result.chains[chain])) {
            const row = result.chains[chain][cap];
            console.log(chain + '/' + cap + '  [' + row.level.toUpperCase() + ']');
            console.log('  share      : ' + (row.operator_stake === null ? 'n/a'
                : row.operator_stake + ' of ' + row.total_stake +
                  (row.share === null ? '' : ' (' + (row.share * 100).toFixed(3) + '%)')));
            console.log('  meets gate : ' + row.meets_gate);
            console.log('  headroom   : ' + (row.headroom === null ? 'n/a'
                : row.headroom + '  (' + row.stakes_to_halt + ' more ' +
                  (Number(row.stakes_to_halt) === 1 ? 'stake' : 'stakes') + ' of ' + row.unit_stake + ')'));
            console.log('  reading age: ' + row.age_s + 's');
            if (ADD !== null) {
                const p = projectCompetingStake(toEvaluation(row), ADD);
                console.log('  if a competitor stakes ' + ADD + ': ' +
                    (p === null ? 'not projectable from this reading'
                        : '[' + p.level.toUpperCase() + '] headroom ' + p.headroom +
                          ', meets gate ' + p.meetsGate));
            }
            console.log('  ' + row.reason);
            console.log('');
        }
    }
    // Non-zero exit on an alerting federation so a cron drill fails loudly.
    if (result.alerting) process.exit(1);
}

main().catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(2); });
