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
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const consensusRules = require('../../../src/consensus_rules_digest.js');

const KEY = 'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION';
const MODULE = 'list_share_producer_activation';
const INDEXER_COPY = path.resolve(__dirname, '../../../../xchain-indexer/src/consensus_rules_digest.js');

let stagedIndexerEntry = null;

before(function () {
    if (!fs.existsSync(INDEXER_COPY)) return;
    const indexerRules = require(INDEXER_COPY);
    if (indexerRules.SHARED_GATES.some(([moduleName]) => moduleName === MODULE)) return;
    const [, names] = consensusRules.SHARED_GATES.find(([moduleName]) => moduleName === MODULE);
    stagedIndexerEntry = [MODULE, [...names]];
    indexerRules.SHARED_GATES.push(stagedIndexerEntry);
});

after(function () {
    if (!stagedIndexerEntry) return;
    const sharedGates = require(INDEXER_COPY).SHARED_GATES;
    sharedGates.splice(sharedGates.indexOf(stagedIndexerEntry), 1);
});

describe('list-share producer rules digest gate', function () {
    it('publishes and resolves the producer gate', function () {
        assert.ok(consensusRules.knownGateKeys().includes(KEY));
        const { gates } = consensusRules.computeConsensusRulesDigest();
        assert.ok(Object.prototype.hasOwnProperty.call(gates, KEY));
        assert.notStrictEqual(gates[KEY], consensusRules.ABSENT);
    });
});
