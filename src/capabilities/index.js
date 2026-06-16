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
 **********************************************************************
 *
 * XChain Hub - Capability Self-Test Modules
 *
 * Each module exports `selfTest(config) -> { ok: boolean, reason?: string }`.
 *
 ********************************************************************/

module.exports = {
    price:          require('./price.js'),
    cross_chain:    require('./cross_chain.js'),
    oracle_publish: require('./oracle_publish.js'),
    attestation:    require('./attestation.js'),
    full_node:      require('./full_node.js')
};
