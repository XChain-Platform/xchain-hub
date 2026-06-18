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
 * XChain Hub - Capability Self-Test: full_node
 *
 * Determines whether this hub can participate in the verified full-node tier:
 * it needs a reachable BTC coin full-node RPC to compute (and verify) the
 * derived possession-challenge answer. A light validator (hub + xchain-sync,
 * no coin node) has none. Its self-test fails, so it never claims the
 * full_node capability and never earns the full-node reward tranche. Live
 * connectivity beyond config presence is exercised by FullNodeChallengeRound.
 *
 * Config shape (any one resolves the BTC coin RPC):
 *   { FULLNODE: { BTC_RPC: '...' } }                  // dedicated override
 *   { cross_chain: { chains: { BTC: { rpc: '...' } } } } // shared coin RPC
 *
 ********************************************************************/

exports.selfTest = async (config) => {
    let cfg = config || {};
    let rpc = (cfg.FULLNODE && cfg.FULLNODE.BTC_RPC)
        || (cfg.cross_chain && cfg.cross_chain.chains && cfg.cross_chain.chains.BTC && cfg.cross_chain.chains.BTC.rpc)
        || process.env.FULLNODE_BTC_RPC
        || '';
    if (!rpc) {
        return { ok: false, reason: 'no BTC coin full-node RPC configured (FULLNODE.BTC_RPC or cross_chain.chains.BTC.rpc); light validators cannot claim full_node' };
    }
    return { ok: true };
};
