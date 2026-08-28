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
 * XChain Hub - Capability Self-Test: oracle_publish
 *
 * Determines whether this hub is operationally ready to publish finalized
 * PRICE rounds to the DOGE chain. Verifies a valid DOGE broadcast address
 * and wallet path are configured. Live wallet balance and DOGE node
 * reachability are checked by OraclePublisher during normal operation.
 *
 * Config shape:
 *   { oracle_publish: { doge_address: 'D...', doge_wallet: '~/.dogecoin/wallet' } }
 *
 * THE ADDRESS FORMAT IS PER-NETWORK. Which DOGE chain this hub publishes to is
 * not derived from HUB_NETWORK: OraclePublisher broadcasts through whatever
 * DOGE_ENCODER_URL points at, so a testnet federation publishes on DOGE testnet
 * with faucet coin and a mainnet one spends real DOGE. A hardcoded mainnet 'D'
 * prefix here rejects the CORRECT address for every testnet and regtest
 * validator and leaves oracle_publish unreachable on any non-mainnet deployment
 * (project-run or community), so the check validates against the hub's declared
 * network instead.
 *
 * Gated per-network rather than accepting either format, deliberately: a mainnet
 * hub configured with a testnet address would pass a permissive check and then
 * publish nowhere, which is the silent failure this self-test exists to catch.
 *
 ********************************************************************/

// Dogecoin base58 pay-to-pubkey-hash prefixes by network. Mainnet version byte
// 0x1e renders as 'D'; testnet/regtest version byte 0x71 renders as 'n'. P2SH is
// not accepted: the publisher signs with a single-key wallet.
const DOGE_ADDRESS_RE = {
    mainnet: /^D[a-km-zA-HJ-NP-Z1-9]{33}$/,
    testnet: /^n[a-km-zA-HJ-NP-Z1-9]{33}$/,
    regtest: /^n[a-km-zA-HJ-NP-Z1-9]{33}$/,
};

exports.selfTest = async (config) => {
    let entry = (config && config.oracle_publish) || null;
    if (!entry) {
        return { ok: false, reason: 'oracle_publish config missing' };
    }
    if (!entry.doge_address) {
        return { ok: false, reason: 'oracle_publish.doge_address not configured' };
    }

    // Fail closed on an unknown/absent network rather than falling back to
    // mainnet: guessing here is what would let a testnet hub silently validate a
    // mainnet address and spend real DOGE.
    let network = String((config && config.HUB_NETWORK) || '').toLowerCase();
    let re = DOGE_ADDRESS_RE[network];
    if (!re) {
        return { ok: false, reason: 'oracle_publish cannot validate doge_address: HUB_NETWORK is ' +
                                    (network ? '"' + network + '" (unknown)' : 'not set') };
    }
    if (!re.test(String(entry.doge_address))) {
        return { ok: false, reason: 'oracle_publish.doge_address is not a valid DOGE ' + network +
                                    ' address (expected ' + (network === 'mainnet' ? "'D'" : "'n'") +
                                    ' prefix, 34 chars)' };
    }
    if (!entry.doge_wallet) {
        return { ok: false, reason: 'oracle_publish.doge_wallet not configured' };
    }
    return { ok: true };
};
