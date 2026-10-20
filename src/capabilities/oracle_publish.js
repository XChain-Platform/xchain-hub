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
 * fails closed at lib/guards/two_phase_guard.js rather than publishing a payload no
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

const crypto = require('crypto');
const coins = require('../coins');
const { loadSignerHooks } = require('../lib/signer_loader.js');

// Dogecoin addresses are Base58Check: a version byte, a 20-byte key hash and a
// 4-byte checksum. The version byte comes ONLY from net.pubKeyHash in the coin
// registry, never a hand copy (testnet 0x71 and regtest 0x6f both render as 'n').
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const P2PKH_PAYLOAD_BYTES = 25;

// Return the version byte of a valid 25-byte Base58Check address, else null.
// Rejects a bad character, a wrong length and a checksum mismatch alike.
function base58CheckVersion(address) {
    let s = String(address);
    let n = 0n;
    for (let ch of s) {
        let digit = BASE58_ALPHABET.indexOf(ch);
        if (digit < 0) return null;
        n = n * 58n + BigInt(digit);
    }
    // Each leading '1' encodes one leading zero byte that the number drops.
    let zeros = 0;
    while (zeros < s.length && s[zeros] === '1') zeros++;
    let hex = n === 0n ? '' : n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    let bytes = Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
    if (bytes.length !== P2PKH_PAYLOAD_BYTES) return null;
    // The checksum is the first 4 bytes of sha256(sha256(version + hash)).
    let body = bytes.subarray(0, 21);
    let digest = crypto.createHash('sha256').update(crypto.createHash('sha256').update(body).digest()).digest();
    if (!digest.subarray(0, 4).equals(bytes.subarray(21))) return null;
    return bytes[0];
}

// Base58 of the lowest (fill 0x00) or highest (fill 0xff) payload one version
// byte can produce, so the operator hint names that byte's leading characters.
function base58Bound(versionByte, fill) {
    let n = BigInt(versionByte);
    for (let i = 0; i < P2PKH_PAYLOAD_BYTES - 1; i++) n = (n << 8n) | BigInt(fill);
    let out = '';
    while (n > 0n) { out = BASE58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    return out;
}

// Operator-facing prefix hint built from the registry byte: "'D'" on mainnet,
// "'n'" on testnet, "'m' or 'n'" on regtest.
function prefixHint(versionByte) {
    let lo = base58Bound(versionByte, 0x00)[0];
    let hi = base58Bound(versionByte, 0xff)[0];
    return lo === hi ? "'" + lo + "'" : "'" + lo + "' or '" + hi + "'";
}

// The registry's P2PKH version byte for this network, or null for a network the
// registry does not know. P2SH is not accepted: the publisher signs with a
// single-key wallet.
function dogePubKeyHash(network) {
    try {
        return coins.getCoinConfig('DOGE', network).net.pubKeyHash;
    } catch (e) {
        // Only an unknown network reads as "unknown"; any other registry fault surfaces.
        if (e && /^Unknown network/.test(String(e.message))) return null;
        throw e;
    }
}

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
    let version = network ? dogePubKeyHash(network) : null;
    if (version === null) {
        return { ok: false, reason: 'oracle_publish cannot validate doge_address: HUB_NETWORK is ' +
                                    (network ? '"' + network + '" (unknown)' : 'not set') };
    }
    // Decode the address and require this network's exact version byte plus a valid
    // checksum: a first-character test cannot tell testnet 0x71 from regtest 0x6f.
    if (base58CheckVersion(entry.doge_address) !== version) {
        return { ok: false, reason: 'oracle_publish.doge_address is not a valid DOGE ' + network +
                                    ' address (expected a P2PKH address with version byte 0x' +
                                    version.toString(16) + ', ' + prefixHint(version) +
                                    ' prefix, and a valid checksum)' };
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
                                    'can never land. See docs/examples/doge-signer.example.js' };
    }
    return { ok: true };
};
