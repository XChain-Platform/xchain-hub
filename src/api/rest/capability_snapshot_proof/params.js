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

const BAD_PARAMS = Object.freeze({ error: 'BAD_PARAMS' });
const DECIMAL_INTEGER = /^[0-9]+$/;
const PUBKEY = /^[0-9a-fA-F]{64}$/;

function hasCapability(configuredCapabilities, capability) {
    if (Array.isArray(configuredCapabilities)) return configuredCapabilities.includes(capability);
    if (configuredCapabilities instanceof Set) return configuredCapabilities.has(capability);
    return false;
}

function parseSnapshotBlock(value) {
    if (typeof value !== 'string' || !DECIMAL_INTEGER.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePubkeys(query) {
    if (!Object.prototype.hasOwnProperty.call(query, 'pubkeys')) return null;
    if (typeof query.pubkeys !== 'string' || query.pubkeys.length === 0) return false;
    const pubkeys = query.pubkeys.split(',');
    if (pubkeys.length > 256 || pubkeys.some(pubkey => !PUBKEY.test(pubkey))) return false;
    return pubkeys;
}

function parseCapabilityProofQuery(query, configuredCapabilities) {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return BAD_PARAMS;
    const snapshotBlock = parseSnapshotBlock(query.snapshot_block);
    const capability = query.capability;
    if (snapshotBlock === null || typeof capability !== 'string' ||
        capability.length === 0 || capability.length > 64 ||
        !hasCapability(configuredCapabilities, capability)) return BAD_PARAMS;
    const pubkeys = parsePubkeys(query);
    if (pubkeys === false) return BAD_PARAMS;
    return { snapshotBlock, capability, pubkeys };
}

module.exports = { parseCapabilityProofQuery };
