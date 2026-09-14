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
 * XChain Hub - quorum-network resolver
 *
 * The STAKE_WEIGHTED_QUORUM gate (swq.isStakeWeightedQuorumActive) keys on a
 * NETWORK. The consensus/verification authority is the RECORD's network (the
 * checkpoint / match / call / anchor being processed): the indexer verifiers
 * (anchor.js, cross_settle, xexec) all gate on the record's NETWORK, so a hub
 * that gated on its own DEPLOYMENT network instead would, on an unscoped or
 * cross-network hub, declare quorum by count while the indexer applies the
 * stricter stake predicate and rejects, forking the reward ledger. This helper
 * returns the record's network so the hub matches the indexer, falling back to
 * the deployment network only when the record carries none.
 *
 * On a correctly-scoped hub the record's network equals the deployment network,
 * so routing a gate through this helper is a no-op; it only changes behavior on
 * a hub whose deployment network is empty or differs from the record.
 *
 ********************************************************************/

'use strict';

function resolveQuorumNetwork(record, deploymentNetwork){
    let n = (record && record.network != null) ? String(record.network) : '';
    return n !== '' ? n : String(deploymentNetwork != null ? deploymentNetwork : '');
}

module.exports = { resolveQuorumNetwork };
