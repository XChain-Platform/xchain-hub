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
 * XChain Hub - positive-integer operator config
 *
 * `parseInt(cfg) || DEFAULT` accepts any NEGATIVE integer, because a negative
 * is truthy. Every duplicate-suppression ring in the hub sizes itself that
 * way, and a negative cap makes the `length > max` eviction fire on the entry
 * just inserted, so the suppression set stays permanently empty and an
 * already-finalized round can be re-proposed and re-published (a wasted BTC
 * fee per cycle; the indexer rejects the row as already-fulfilled).
 *
 * Fall back to the site's own default rather than clamping to the operator's
 * value: a ring capped at 1 is as broken as one capped at -1. Log-only on a
 * bad value, never throwing, matching AttestationConsensus.checkNonOkSizingFloor.
 *
 ********************************************************************/

/**
 * Operator-supplied integer config, honoured only when strictly positive.
 *
 * @param {*} raw       the raw config/env value
 * @param {number} dflt the site's default, used for any non-positive or unparseable value
 * @param {string} [name] config key name, named in the warning when the fallback fires
 * @returns {number}
 */
function positiveIntConfig(raw, dflt, name) {
    if (raw === undefined || raw === null || raw === '') return dflt;
    let n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0) return n;
    console.warn('config: ' + (name || 'value') + '="' + raw + '" is not a positive integer; ' +
        'using the default (' + dflt + '). A non-positive cap disables the ring it sizes.');
    return dflt;
}

module.exports = { positiveIntConfig };
