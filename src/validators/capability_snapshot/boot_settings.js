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
 * XChain Hub - CapabilitySnapshot boot settings
 *
 * The two operator settings the constructor resolves once: the reorg-depth
 * buffer every snapshot resolves under, and the consensus-input alert threshold.
 * src/validators/capability_snapshot.js installs every method below on
 * CapabilitySnapshot.prototype, so callers keep writing snapshot.<method>().
 *
 ********************************************************************/

// The canonical reorg-depth buffer every hub in a federation must resolve
// snapshots at. 6 = the BTC confirmation depth the platform already treats as
// buried (XCHAIN_CONFIRMATIONS_BTC). Named once so the default and the
// divergence assertion below can never drift apart.
//
// The literal now comes from the shared, byte-vendored
// snapshot_reorg_buffer.js rather than living here, because the three verifier
// families outside this repo (indexer attest/index.js, indexer recovery.js, sdk
// light.js) must bury by the SAME depth the signer buried by. A hub-local 6 and
// a verifier-local 6 that drift apart resolve different validator sets for the
// same declared height with nothing logged.
const { CANONICAL_REORG_BUFFER } = require('../../snapshot_reorg_buffer.js');
const hubConfig = require('../../config');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Consecutive consensus-input failures before the monitor raises the alert
    // and /health flips to degraded. Operator-tunable for a venue with a flaky
    // link; a non-positive or non-integer value falls back to the default rather
    // than disabling the alarm (a typo must not silently restore the old
    // silent-fail-closed behaviour).
    resolveAlertAfterFailures() {
        let raw = hubConfig.HUB_CONSENSUS_INPUT_ALERT_AFTER;
        if (raw === undefined || raw === '') return undefined;
        let n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
            logger.error('CapabilitySnapshot: HUB_CONSENSUS_INPUT_ALERT_AFTER "' + raw + '" is not a positive ' +
                'integer; using the default consensus-input alert threshold.');
            return undefined;
        }
        return n;
    },

    // Resolve the reorg-depth buffer from HUB_SNAPSHOT_REORG_BUFFER (default 6).
    // Only a non-negative integer is accepted; anything else warns loudly and
    // falls back to the default rather than silently forking the federation on
    // a typo'd env value.
    //
    // A VALID but non-canonical value is the sharper hazard and is why this is
    // more than a parse (#4167): the buffer is subtracted before the cache key
    // and the indexer RPC are formed, so two hubs handed the same requested
    // height resolve DIFFERENT blocks, and their validator sets and quorum N
    // diverge with nothing logged. Mainnet/testnet therefore refuse the value
    // outright (throws out of the constructor, halting boot fail-closed);
    // regtest/standalone warn and accept so test venues can run deliberate
    // depths. XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT=1 is the loud one-off bypass
    // for a coordinated fleet-wide change. Same shape and same reasoning as
    // XChainHub.assertCanonicalMinStakes, which guards the identical fork
    // class for MIN_STAKE.
    resolveReorgBuffer() {
        let raw = hubConfig.HUB_SNAPSHOT_REORG_BUFFER;
        if (raw === undefined || raw === '') return CANONICAL_REORG_BUFFER;
        let n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
            logger.error('CapabilitySnapshot: HUB_SNAPSHOT_REORG_BUFFER "' + raw + '" is not a ' +
                'non-negative integer; using the default (' + CANONICAL_REORG_BUFFER + '). This value ' +
                'is CONSENSUS-CRITICAL and must match across the federation.');
            return CANONICAL_REORG_BUFFER;
        }
        if (n === CANONICAL_REORG_BUFFER) return n;
        let detail = 'HUB_SNAPSHOT_REORG_BUFFER is ' + n + ' but the canonical federation value is ' +
            CANONICAL_REORG_BUFFER + '. Every hub subtracts this buffer before resolving a snapshot, ' +
            'so a hub running a different value locks a different block for the same round: divergent ' +
            'validator sets and quorum N across the federation. Change it fleet-wide or not at all ' +
            '(XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT=1 to bypass on a venue where every hub runs the SAME override).';
        if (hubConfig.XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT === '1') {
            logger.warn('XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT=1: skipping the canonical reorg-buffer ' +
                'assertion. ' + detail);
            return n;
        }
        // Strict only on a declared consensus network: standalone ('' - no
        // consensus runs) and regtest venues warn instead of refusing.
        let network = (this.hub && this.hub.network) || '';
        if (network === 'mainnet' || network === 'testnet') {
            let err = new Error('CapabilitySnapshot: ' + detail);
            err.code = 'REORG_BUFFER_MISMATCH';
            throw err;
        }
        logger.warn('CapabilitySnapshot: reorg-buffer mismatch (non-strict on ' +
            (network || 'standalone') + '): ' + detail);
        return n;
    }
};
