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
 * XChain Hub - Cross-Chain Attestation Constants
 *
 * The attestation engine's message types, chain list, per-chain confirmation defaults and
 * the timeout and store-retry bounds, in one place because the round handlers and the
 * source-action verification each read some of them.
 *
 ********************************************************************/

const coins        = require('../../coins');

const XCHAIN_ATTEST_PROPOSE = 'XCHAIN_ATTEST_PROPOSE';

const XCHAIN_ATTEST_PREPARE = 'XCHAIN_ATTEST_PREPARE';

const XCHAIN_ATTEST_COMMIT  = 'XCHAIN_ATTEST_COMMIT';

// Default per-chain confirmation thresholds (Tier B, 2026-06-02): the depth a
// cross-chain source action must reach before its swap settles. Higher on the
// lower-hashpower chains to approach BTC-comparable settlement assurance.
// Enforced in handlePropose(): a follower verifies the proposed source action
// against its OWN indexer for that chain and refuses to co-sign below the
// threshold (see verifySourceAction).
const DEFAULT_CONFIRMATIONS = { ...coins.DEFAULT_CONFIRMATIONS };

// Allowed chain names
const ALLOWED_CHAINS = [...coins.ALLOWED_COINS];

const DEFAULT_ATTESTATION_TIMEOUT = 60000; // 60 seconds

// Bounded retry for persisting a quorum-finalized attestation.
// Sized to ride out a DB blip well inside DEFAULT_ATTESTATION_TIMEOUT, which
// remains the terminal backstop for a store that never lands.
const DEFAULT_STORE_RETRY_ATTEMPTS = 4;

const DEFAULT_STORE_RETRY_BASE_MS  = 100;

const STORE_RETRY_MAX_DELAY_MS     = 2000;

module.exports = { XCHAIN_ATTEST_PROPOSE, XCHAIN_ATTEST_PREPARE, XCHAIN_ATTEST_COMMIT, DEFAULT_CONFIRMATIONS, ALLOWED_CHAINS, DEFAULT_ATTESTATION_TIMEOUT, DEFAULT_STORE_RETRY_ATTEMPTS, DEFAULT_STORE_RETRY_BASE_MS, STORE_RETRY_MAX_DELAY_MS };
