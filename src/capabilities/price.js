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
 * XChain Hub - Capability Self-Test: price
 *
 * Determines whether this hub is operationally ready to sign PRICE v0
 * snapshots. Pragmatic configuration check — live source probing happens
 * in PriceFetcher during normal operation.
 *
 * Config shape:
 *   { price: { sources: ['coingecko', 'coinmarketcap'], fiats: ['USD', ...] } }
 *
 ********************************************************************/

exports.selfTest = async (config) => {
    let entry = (config && config.price) || null;
    if (!entry) {
        return { ok: false, reason: 'price config missing' };
    }
    let sources = entry.sources || [];
    if (!Array.isArray(sources) || sources.length === 0) {
        return { ok: false, reason: 'price.sources empty (no price feed configured)' };
    }
    let fiats = entry.fiats || [];
    if (!Array.isArray(fiats) || fiats.length === 0) {
        return { ok: false, reason: 'price.fiats empty (no fiat currencies configured)' };
    }
    return { ok: true };
};
