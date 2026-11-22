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

// The governance voting period. Every hub stamps a proposal's voting_end, its
// early-result guard, its late-vote guard and its activation-block floor from this one
// value and assumes the rest of the federation derived the same one, so the env override
// is honoured on regtest only and is set-but-IGNORED, with a warning, on every other
// network. A negative or unparseable value falls back to the canonical period.

const { positiveIntConfig } = require('../../lib/config_int.js');
const { getLogger } = require('../../observability');

const logger = getLogger();

const DEFAULT_GOV_VOTING_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

function resolveGovVotingPeriod(hubConfig, warn = (msg) => logger.warn(msg)) {
    const raw = hubConfig.GOV_VOTING_PERIOD;
    const network = String(hubConfig.HUB_NETWORK || '').toLowerCase();
    const set = raw !== undefined && raw !== null && raw !== '';
    if (network === 'regtest' && set) {
        return positiveIntConfig(raw, DEFAULT_GOV_VOTING_PERIOD_MS, 'GOV_VOTING_PERIOD');
    }
    if (network !== 'regtest' && set && parseInt(raw, 10) !== DEFAULT_GOV_VOTING_PERIOD_MS) {
        warn('WARNING: GOV_VOTING_PERIOD=' + raw + ' is set but IGNORED on ' + (network || '<unset>') +
            '; using ' + DEFAULT_GOV_VOTING_PERIOD_MS + '. The governance voting period is fleet-uniform ' +
            'and moves only by a coordinated change, never by a local override.');
    }
    return DEFAULT_GOV_VOTING_PERIOD_MS;
}

module.exports = { resolveGovVotingPeriod, DEFAULT_GOV_VOTING_PERIOD_MS };
