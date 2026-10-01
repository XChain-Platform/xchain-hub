/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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

const consensusRules = require('../../../../src/consensus_rules_digest.js');

const KEY = 'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION';

describe('list-share producer rules digest gate', function () {
    it('publishes and resolves the producer gate', function () {
        assert.ok(consensusRules.knownGateKeys().includes(KEY));
        const { gates } = consensusRules.computeConsensusRulesDigest();
        assert.ok(Object.prototype.hasOwnProperty.call(gates, KEY));
        assert.notStrictEqual(gates[KEY], consensusRules.ABSENT);
    });
});
