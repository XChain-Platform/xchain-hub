// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

function normalizePublicApiUrl(value){
    if(typeof value !== 'string') return null;

    const candidate = value.trim();
    const shape = candidate.match(/^https?:\/\/([^/?#]*)(.*)$/i);
    if(!shape || shape[1].includes('@') || (shape[2] !== '' && shape[2] !== '/')) return null;

    try {
        const parsed = new URL(candidate);
        if((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
           !parsed.host || parsed.username || parsed.password ||
           parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
        return parsed.origin;
    } catch (err) {
        return null;
    }
}

function normalizeSigningPubkey(value){
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
        ? value.toLowerCase()
        : null;
}

function buildHubList({ self, peers, isSigner }){
    const hubs = [];
    const seen = new Set();

    function add(entry, requireSigner){
        if(entry === null || typeof entry !== 'object') return;

        const apiUrl = normalizePublicApiUrl(entry.apiUrl);
        const signingPubkey = normalizeSigningPubkey(entry.signingPubkey);
        if(!apiUrl || !signingPubkey || seen.has(apiUrl) || (requireSigner && !isSigner(signingPubkey))) return;

        seen.add(apiUrl);
        hubs.push({ api_url: apiUrl, signing_pubkey: signingPubkey });
    }

    add(self, false);
    if(Array.isArray(peers)){
        for(const peer of peers) add(peer, true);
    }

    return { hubs };
}

module.exports = { normalizePublicApiUrl, buildHubList };
