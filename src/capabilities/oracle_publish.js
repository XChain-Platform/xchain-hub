/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Capability Self-Test: oracle_publish
 *
 * Determines whether this hub is operationally ready to publish finalized
 * PRICE rounds to the DOGE chain. Verifies a valid DOGE broadcast address
 * and wallet path are configured. Live wallet balance and DOGE node
 * reachability are checked by OraclePublisher during normal operation.
 *
 * Config shape:
 *   { oracle_publish: { doge_address: 'D...', doge_wallet: '~/.dogecoin/wallet' } }
 *
 ********************************************************************/

exports.selfTest = async (config) => {
    let entry = (config && config.oracle_publish) || null;
    if (!entry) {
        return { ok: false, reason: 'oracle_publish config missing' };
    }
    if (!entry.doge_address) {
        return { ok: false, reason: 'oracle_publish.doge_address not configured' };
    }
    // DOGE address: D-prefix, 33 base58 chars after = 34 total
    if (!/^D[a-km-zA-HJ-NP-Z1-9]{33}$/.test(String(entry.doge_address))) {
        return { ok: false, reason: 'oracle_publish.doge_address has invalid format' };
    }
    if (!entry.doge_wallet) {
        return { ok: false, reason: 'oracle_publish.doge_wallet not configured' };
    }
    return { ok: true };
};
