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
const { CANONICAL_REORG_BUFFER } = require('../../consensus/snapshot_reorg_buffer.js');
const hubConfig = require('../../config');
const { getLogger } = require('../../observability');
const logger = getLogger();
const CONSENSUS_NETWORKS = new Set(['mainnet', 'testnet', 'regtest']);

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
    // A valid but non-canonical value resolves a different validator set than
    // indexer, SDK and hub checkpoint verifiers, which always use the shared
    // constant. Every declared consensus network therefore refuses a mismatch.
    // Standalone mode accepts one only for isolated hub tests.
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
        const network = (this.hub && this.hub.network) || '';
        return this.assertCanonicalReorgBuffer(n, network);
    },

    // Apply the same invariant at construction and when a standalone hub learns
    // its network from config. Changing the depth requires changing the shared
    // protocol constant used by every verifier, not a hub-local override.
    assertCanonicalReorgBuffer(n, network) {
        if (n === CANONICAL_REORG_BUFFER) return n;
        const detail = 'HUB_SNAPSHOT_REORG_BUFFER is ' + n + ' but the canonical federation value is ' +
            CANONICAL_REORG_BUFFER + '. Indexer, SDK and hub checkpoint verifiers use the shared ' +
            'constant, so a hub-only override resolves a different validator set even when every hub uses it.';
        if (CONSENSUS_NETWORKS.has(network)) {
            if (hubConfig.XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT === '1') {
                logger.error('XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT=1 is ignored on ' + network +
                    ' because no hub-only reorg-buffer override is safe.');
            }
            const err = new Error('CapabilitySnapshot: ' + detail);
            err.code = 'REORG_BUFFER_MISMATCH';
            throw err;
        }
        logger.warn('CapabilitySnapshot: reorg-buffer mismatch (non-strict on standalone): ' +
            detail + ' Use this only in an isolated hub test with no consensus verifier.');
        return n;
    }
};
