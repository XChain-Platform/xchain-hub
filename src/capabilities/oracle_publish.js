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
 * THE SIGNER MODULE MUST EXPORT `broadcast(payload)` WHEN IT IS CONFIGURED AT
 * ALL. Every chunked publish this capability leads (a PRICE round's signature
 * list, an ANCHOR, a ROLLCALL) is a two-phase P2SH encoding, and the hub's
 * built-in pipeline can only broadcast the FUNDING transaction of those two: it
 * fails closed at lib/two_phase_guard.js rather than publishing a payload no
 * indexer can decode. signer-loader treats `broadcast` as OPTIONAL, so a
 * hand-built module exporting only walletSign loads cleanly, signs everything it
 * is asked to, and publishes nothing, with no error anywhere. The CLI-generated
 * signer (xchain-node's `validator init`) already exports it; hand-built modules
 * are the gap, so it is checked here.
 *
 * The check is scoped to a CONFIGURED module. An unset HUB_SIGNER_MODULE is the
 * hub's documented "no operator signer, publishers stay idle" posture, which this
 * self-test has never spoken to and which the publishers already announce
 * themselves; failing it here would strip oracle_publish from every hub that has
 * never had a signer, which is not the silent failure being closed.
 *
 ********************************************************************/

const { loadSignerHooks } = require('../lib/signer-loader.js');

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

    // A configured-but-unloadable module is a hard failure of the operator's own
    // declaration (loadSignerHooks throws for it and for a module without
    // walletSign); report it rather than letting the throw become an opaque
    // 'selfTest threw' line in the capability registry.
    let hooks;
    try {
        hooks = loadSignerHooks();
    } catch (e) {
        return { ok: false, reason: 'HUB_SIGNER_MODULE is configured but unusable: ' +
                                    (e && e.message ? e.message : String(e)) };
    }
    if (hooks && typeof hooks.broadcastFn !== 'function') {
        return { ok: false, reason: 'HUB_SIGNER_MODULE (' + hooks.source + ') exports no broadcast(payload); ' +
                                    'every chunked publish this capability leads is a two-phase P2SH encoding ' +
                                    'the built-in pipeline cannot finish, so this hub would sign publishes it ' +
                                    'can never land. See examples/doge-signer.example.js' };
    }
    return { ok: true };
};
