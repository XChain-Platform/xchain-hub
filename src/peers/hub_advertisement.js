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
 **********************************************************************/

'use strict';

function normalizeApiUrl(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value !== value.trim()) return null;

    let parsed;
    try { parsed = new URL(value); }
    catch (e) { return null; }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.pathname === '/' ? parsed.origin : parsed.origin + parsed.pathname;
}

function resolvePublicApiUrl(config) {
    const cfg = config || {};
    if (cfg.HUB_PUBLIC_API_URL === undefined || cfg.HUB_PUBLIC_API_URL === null || cfg.HUB_PUBLIC_API_URL === '') return null;
    const explicit = normalizeApiUrl(cfg.HUB_PUBLIC_API_URL);
    if (!explicit) throw new Error('HUB_PUBLIC_API_URL must be an http(s) URL without credentials, query, or fragment');
    return explicit;
}

module.exports = { normalizeApiUrl, resolvePublicApiUrl };
