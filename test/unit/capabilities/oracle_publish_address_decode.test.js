'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const crypto     = require('crypto');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

// The oracle_publish self-test decodes doge_address as Base58Check, so it enforces
// the checksum, the exact registry version byte and the P2PKH-only rule, none of
// which a first-character test can express.

const BASE58_ALPHABET  = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DOGE_MAINNET_GAS = 'DGasfpttCnTijuuoAdiJ9sXJjG7vQ5pMkW';
const DOGE_REGTEST_N   = 'n1AvTJLLSA1NHamHd5KFj9mRn6BEcwnVbf';

// Base58Check of one version byte, 20 hash bytes all `fill`, and the real
// sha256d checksum: a well-formed address of any version byte.
function base58CheckOf(versionByte, fill) {
    let body = Buffer.concat([Buffer.from([versionByte]), Buffer.alloc(20, fill)]);
    let sum  = crypto.createHash('sha256').update(crypto.createHash('sha256').update(body).digest()).digest();
    let n = BigInt('0x' + Buffer.concat([body, sum.subarray(0, 4)]).toString('hex'));
    let out = '';
    while (n > 0n) { out = BASE58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    return out;
}

// Flip the last character to a different base58 character, which breaks the
// checksum while keeping the length and alphabet.
function corruptOneChar(address) {
    let i = address.length - 1;
    let swap = address[i] === 'a' ? 'b' : 'a';
    return address.slice(0, i) + swap;
}

describe('capabilities/oracle_publish selfTest() address decode', function () {
    let oraclePub;
    let coins;
    before(function () {
        oraclePub = proxyquire('../../../src/capabilities/oracle_publish', {
            '../lib/signer_loader.js': {
                loadSignerHooks: () => ({ source: '/test/signer.js', walletSignFn() {}, broadcastFn() {} })
            }
        });
        coins     = require('../../../src/coins');
    });

    it('rejects a mainnet address whose checksum does not match', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'mainnet',
            oracle_publish: { doge_address: corruptOneChar(DOGE_MAINNET_GAS), doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('not a valid DOGE mainnet address');
    });

    // The publisher signs with a single-key wallet, so a script-hash address is
    // refused even on the network whose scriptHash byte it carries.
    it('rejects a P2SH address on its own network', async function () {
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            const p2sh = base58CheckOf(coins.getCoinConfig('DOGE', network).net.scriptHash, 0x42);
            let r = await oraclePub.selfTest({
                HUB_NETWORK: network,
                oracle_publish: { doge_address: p2sh, doge_wallet: '/path' }
            });
            expect(r.ok, network + ' ' + p2sh).to.be.false;
            expect(r.reason).to.include('not a valid DOGE ' + network + ' address');
        }
    });

    it('rejects an address carrying a non-base58 character', async function () {
        for (const bad of ['0', 'O', 'I', 'l']) {
            let r = await oraclePub.selfTest({
                HUB_NETWORK: 'mainnet',
                oracle_publish: { doge_address: DOGE_MAINNET_GAS.slice(0, -1) + bad, doge_wallet: '/path' }
            });
            expect(r.ok, bad).to.be.false;
        }
    });

    // Pin that the regtest literal the e2e harness configures passes, and that a
    // DOGE-testnet 0x71 literal is refused on regtest.
    it('accepts the e2e harness regtest literal and rejects its former 0x71 literal', async function () {
        let ok = await oraclePub.selfTest({
            HUB_NETWORK: 'regtest',
            oracle_publish: { doge_address: DOGE_REGTEST_N, doge_wallet: '/path' }
        });
        expect(ok.ok, ok.reason).to.be.true;
        let bad = await oraclePub.selfTest({
            HUB_NETWORK: 'regtest',
            oracle_publish: { doge_address: 'nsTake195wjCuVwLHf26EsZnRjwpm2LJtb', doge_wallet: '/path' }
        });
        expect(bad.ok).to.be.false;
    });
});
