/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Operator Signer Loader
 *
 * The on-chain publishers (OraclePublisher → PRICE v0, StateAnchorPublisher →
 * ANCHOR) build and broadcast DOGE
 * transactions through the encoder, but SIGNING is the operator's
 * responsibility — the hub holds no coin keys, only its Ed25519 validator
 * identity. Each publisher exposes setWalletSignHook / setBroadcastHook /
 * setBalanceHook; this loader is the production boot path that wires them
 * (previously only test drivers ever called the setters, so on-chain
 * publishing was unreachable in a managed deployment).
 *
 * HUB_SIGNER_MODULE names an operator-supplied CommonJS module (mounted into
 * the container together with its own node_modules) exporting:
 *
 *   walletSign(psbtHex) → Promise<txHex>     REQUIRED — sign a PSBT with the
 *                                            DOGE_ADDRESS private key
 *   broadcast(payload)  → Promise<{txid}>    optional — replaces the default
 *                                            encoder build/sign/broadcast pipeline
 *   getBalance()        → Promise<number>    optional — publisher low-balance checks
 *
 * A thin wrapper over xchain-sdk's wallet.signPsbt(psbtHex, wif) satisfies
 * the contract — see examples/doge-signer.example.js.
 *
 * Failure policy: HUB_SIGNER_MODULE unset returns null and the publishers
 * stay idle (their own "no broadcast pipeline configured" warnings fire).
 * Set-but-unloadable/invalid THROWS: a signer the operator explicitly
 * configured but that cannot sign must fail the boot loudly, not silently
 * defer anchors for a day.
 *
 ********************************************************************/

function loadSignerHooks(env){
    env = env || process.env;
    let modulePath = env.HUB_SIGNER_MODULE || '';
    if(!modulePath) return null;

    let mod;
    try {
        mod = require(modulePath);
    } catch(e){
        throw new Error('HUB_SIGNER_MODULE failed to load (' + modulePath + '): ' + (e && e.message));
    }
    if(!mod || typeof mod.walletSign !== 'function')
        throw new Error('HUB_SIGNER_MODULE (' + modulePath + ') must export a walletSign(psbtHex) function');
    for(let opt of ['broadcast', 'getBalance']){
        if(mod[opt] !== undefined && typeof mod[opt] !== 'function')
            throw new Error('HUB_SIGNER_MODULE (' + modulePath + ') export "' + opt + '" must be a function when present');
    }

    return {
        source:       modulePath,
        walletSignFn: (psbtHex) => mod.walletSign(psbtHex),
        broadcastFn:  (typeof mod.broadcast  === 'function') ? ((payload) => mod.broadcast(payload)) : null,
        getBalanceFn: (typeof mod.getBalance === 'function') ? (() => mod.getBalance()) : null
    };
}

// Apply loaded hooks to a publisher (anything exposing the standard setters).
// Wiring OraclePublisher alone covers StateAnchorPublisher too — it borrows
// the hooks via _resolveSigner().
function applySignerHooks(publisher, hooks){
    if(!publisher || !hooks) return false;
    if(typeof publisher.setWalletSignHook === 'function')
        publisher.setWalletSignHook(hooks.walletSignFn);
    if(hooks.broadcastFn && typeof publisher.setBroadcastHook === 'function')
        publisher.setBroadcastHook(hooks.broadcastFn);
    if(hooks.getBalanceFn && typeof publisher.setBalanceHook === 'function')
        publisher.setBalanceHook(hooks.getBalanceFn);
    return true;
}

module.exports = { loadSignerHooks, applySignerHooks };
