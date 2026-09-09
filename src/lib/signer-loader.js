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
 * XChain Hub - Operator Signer Loader
 *
 * The on-chain publishers (OraclePublisher → PRICE v0, StateAnchorPublisher →
 * ANCHOR) build and broadcast DOGE
 * transactions through the encoder, but SIGNING is the operator's
 * responsibility. The hub holds no coin keys, only its Ed25519 validator
 * identity. Each publisher exposes setWalletSignHook / setBroadcastHook /
 * setBalanceHook; this loader is the production boot path that wires them
 * (previously only test drivers ever called the setters, so on-chain
 * publishing was unreachable in a managed deployment).
 *
 * HUB_SIGNER_MODULE names an operator-supplied CommonJS module (mounted into
 * the container together with its own node_modules) exporting:
 *
 *   walletSign(psbtHex) → Promise<txHex>     REQUIRED: sign a PSBT with the
 *                                            DOGE_ADDRESS private key
 *   broadcast(payload)  → Promise<{txid}>    optional: replaces the default
 *                                            encoder build/sign/broadcast pipeline
 *   getBalance()        → Promise<number>    optional: publisher low-balance checks
 *   chains: ['DOGE']                         optional: the coins this module can
 *                                            sign for; absent means DOGE only
 *
 * Why `chains` exists: the hub has exactly ONE operator signer, holding
 * the DOGE_ADDRESS key, and wiring it blindly into every publisher
 * regardless of the rail that publisher settles on is the trap. FullNodeChallengeRound signs
 * NODEPROOF verdicts against BTC_ADDRESS on BTC, so it received a DOGE signer:
 * measured 2026-09-04, BTC-intended payloads were signed and broadcast on
 * Dogecoin, burning DOGE fees while the BTC side showed an invalid REQUEST_ID and
 * zero responses. The declaration lets the loader refuse that wiring instead, and
 * an uncovered publisher stays idle with a stated reason rather than spending.
 *
 * A thin wrapper over xchain-sdk's wallet.signPsbt(psbtHex, wif) satisfies
 * the contract. See examples/doge-signer.example.js.
 *
 * Failure policy: HUB_SIGNER_MODULE unset returns null and the publishers
 * stay idle (their own "no broadcast pipeline configured" warnings fire).
 * Set-but-unloadable/invalid THROWS: a signer the operator explicitly
 * configured but that cannot sign must fail the boot loudly, not silently
 * defer anchors for a day.
 *
 ********************************************************************/

// The rail the signer contract has always meant, and the only one every module
// written before `chains` existed signs for. It is both the default declaration
// and the default a wiring site gets when it names no chain.
const DEFAULT_CHAIN  = 'DOGE';
const DEFAULT_CHAINS = [DEFAULT_CHAIN];

function normalizeChain(coin){
    return String(coin === undefined || coin === null ? '' : coin).trim().toUpperCase();
}

// An absent declaration is DOGE-only rather than "every chain": the failure this
// guards against is a signer being trusted with a rail nobody checked, so silence
// has to mean the narrow answer.
function readDeclaredChains(mod, modulePath){
    if(mod.chains === undefined) return DEFAULT_CHAINS.slice();
    if(!Array.isArray(mod.chains) || mod.chains.length === 0)
        throw new Error('HUB_SIGNER_MODULE (' + modulePath + ') export "chains" must be a non-empty array of ' +
                        'coin tickers when present (for example ["DOGE"])');
    let out = [];
    for(let coin of mod.chains){
        if(typeof coin !== 'string' || !normalizeChain(coin))
            throw new Error('HUB_SIGNER_MODULE (' + modulePath + ') export "chains" must contain only non-empty ' +
                            'coin ticker strings; got ' + JSON.stringify(coin));
        let ticker = normalizeChain(coin);
        if(out.indexOf(ticker) === -1) out.push(ticker);
    }
    return out;
}

// Validate an already-required signer module and build the hooks object.
// Split out of loadSignerHooks so a test can drive the real reference template
// (examples/doge-signer.example.js, which cannot be require()d without operator
// credentials) through the same contract check the production path applies.
function buildSignerHooks(mod, modulePath){
    if(!mod || typeof mod.walletSign !== 'function')
        throw new Error('HUB_SIGNER_MODULE (' + modulePath + ') must export a walletSign(psbtHex) function');
    for(let opt of ['broadcast', 'getBalance']){
        if(mod[opt] !== undefined && typeof mod[opt] !== 'function')
            throw new Error('HUB_SIGNER_MODULE (' + modulePath + ') export "' + opt + '" must be a function when present');
    }
    let chains = readDeclaredChains(mod, modulePath);

    return {
        source:       modulePath,
        chains:       chains,
        walletSignFn: (psbtHex) => mod.walletSign(psbtHex),
        broadcastFn:  (typeof mod.broadcast  === 'function') ? ((payload) => mod.broadcast(payload)) : null,
        getBalanceFn: (typeof mod.getBalance === 'function') ? (() => mod.getBalance()) : null
    };
}

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
    return buildSignerHooks(mod, modulePath);
}

// Apply loaded hooks to a publisher (anything exposing the standard setters).
// Wiring OraclePublisher alone covers StateAnchorPublisher too, because it
// borrows the hooks via _resolveSigner().
//
// `chain` is the rail the publisher settles on. Every wiring site in
// XChainHub.js passes it explicitly; publisher.signingChain (declared by the
// publisher itself) and then DOGE are the fallbacks, so a direct caller that
// names nothing gets the historical behaviour.
//
// A publisher whose chain the module does not declare is left ENTIRELY unwired:
// sign, broadcast and balance alike. The balance hook goes too because a DOGE
// balance says nothing about whether the BTC wallet can fund a send, and a
// publisher that believes it is funded is a publisher that tries to spend.
function applySignerHooks(publisher, hooks, chain){
    if(!publisher || !hooks) return false;

    let need     = normalizeChain(chain || publisher.signingChain || DEFAULT_CHAIN);
    let declared = (Array.isArray(hooks.chains) && hooks.chains.length) ? hooks.chains : DEFAULT_CHAINS;
    if(declared.indexOf(need) === -1){
        let name = (publisher.constructor && publisher.constructor.name) || 'publisher';
        console.warn('signer-loader: ' + name + ' settles on ' + need + ' but HUB_SIGNER_MODULE (' +
                     (hooks.source || 'unknown') + ') declares chains [' + declared.join(', ') + ']; ' +
                     'leaving its sign, broadcast and balance hooks UNWIRED. ' + name + ' stays idle until an ' +
                     'operator signer declaring ' + need + ' is configured, rather than paying a ' +
                     declared[0] + ' fee to publish a ' + need + ' payload.');
        return false;
    }

    // The chain travels with the hook so a publisher can re-check it at send time
    // (FullNodeChallengeRound does). Publishers that ignore the second argument
    // are unaffected.
    if(typeof publisher.setWalletSignHook === 'function')
        publisher.setWalletSignHook(hooks.walletSignFn, need);
    if(hooks.broadcastFn && typeof publisher.setBroadcastHook === 'function')
        publisher.setBroadcastHook(hooks.broadcastFn, need);
    if(hooks.getBalanceFn && typeof publisher.setBalanceHook === 'function')
        publisher.setBalanceHook(hooks.getBalanceFn, need);
    return true;
}

module.exports = { loadSignerHooks, applySignerHooks, buildSignerHooks, DEFAULT_CHAIN };
