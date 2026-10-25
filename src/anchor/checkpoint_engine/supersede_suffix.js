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
 **********************************************************************
 *
 * State checkpoint engine - supersession suffix bytes
 *
 * Pure field detection and serialization for a checkpoint supersession.
 *
 ********************************************************************/

'use strict';

function hasSupersedeFields(cp) {
    return !!cp && (cp.supersedes_from != null || cp.rules_digest != null);
}

function supersedeSuffix(cp) {
    let hasFrom   = !!cp && cp.supersedes_from != null;
    let hasDigest = !!cp && cp.rules_digest != null;

    if(!hasFrom && !hasDigest) return '';
    if(!hasFrom || !hasDigest)
        throw new Error('checkpoint supersession requires supersedes_from and rules_digest');

    let from = Number(cp.supersedes_from);
    if(!Number.isSafeInteger(from) || from < 0)
        throw new Error('supersedes_from must be a non-negative safe integer');
    if(typeof cp.rules_digest !== 'string' || !/^[0-9a-f]{64}$/i.test(cp.rules_digest))
        throw new Error('rules_digest must be 64 hexadecimal characters');

    return '|SUPERSEDE|' + from + '|' + cp.rules_digest.toLowerCase();
}

module.exports = { hasSupersedeFields, supersedeSuffix };
