'use strict';
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
 * Cross-chain address re-encoding for equivalent Base58Check and
 * SegWit destinations on another supported chain.
 *
 ********************************************************************/

const crypto = require('crypto');
const coins = require('../../coins');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function sha256d(value){
    return crypto.createHash('sha256').update(crypto.createHash('sha256').update(value).digest()).digest();
}

function base58CheckDecode(address){
    if(typeof address !== 'string' || address.length < 26 || address.length > 48) return null;
    let value = 0n;
    for(const char of address){
        const digit = BASE58_ALPHABET.indexOf(char);
        if(digit < 0) return null;
        value = value * 58n + BigInt(digit);
    }
    let hex = value === 0n ? '' : value.toString(16);
    if(hex.length % 2) hex = '0' + hex;
    const bytes = hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
    let leading = 0;
    while(leading < address.length && address[leading] === '1') leading++;
    const data = Buffer.concat([Buffer.alloc(leading), bytes]);
    if(data.length < 5) return null;
    const payload = data.subarray(0, data.length - 4);
    return sha256d(payload).subarray(0, 4).equals(data.subarray(data.length - 4)) ? payload : null;
}

function base58CheckEncode(payload){
    const data = Buffer.concat([payload, sha256d(payload).subarray(0, 4)]);
    let value = BigInt('0x' + data.toString('hex'));
    let out = '';
    while(value > 0n){
        out = BASE58_ALPHABET[Number(value % 58n)] + out;
        value /= 58n;
    }
    for(const byte of data){
        if(byte !== 0) break;
        out = '1' + out;
    }
    return out;
}

function polymod(hrp, data){
    const values = [];
    for(const char of hrp) values.push(char.charCodeAt(0) >> 5);
    values.push(0);
    for(const char of hrp) values.push(char.charCodeAt(0) & 31);
    values.push(...data);
    let checksum = 1;
    for(const value of values){
        const top = checksum >> 25;
        checksum = ((checksum & 0x1ffffff) << 5) ^ value;
        for(let i = 0; i < 5; i++) if((top >> i) & 1) checksum ^= BECH32_GENERATORS[i];
    }
    return checksum;
}

function bech32Decode(address){
    if(typeof address !== 'string' ||
       (address !== address.toLowerCase() && address !== address.toUpperCase())) return null;
    const text = address.toLowerCase();
    if(text.length < 8 || text.length > 90) return null;
    const separator = text.lastIndexOf('1');
    if(separator < 1 || separator + 7 > text.length) return null;
    const hrp = text.slice(0, separator);
    const data = [];
    for(const char of text.slice(separator + 1)){
        const value = BECH32_CHARSET.indexOf(char);
        if(value < 0) return null;
        data.push(value);
    }
    const version = data[0];
    if(version > 16 || polymod(hrp, data) !== (version === 0 ? 1 : 0x2bc830a3)) return null;
    let bits = 0, accumulator = 0;
    const program = [];
    for(const value of data.slice(1, -6)){
        accumulator = (accumulator << 5) | value;
        bits += 5;
        while(bits >= 8){
            bits -= 8;
            program.push((accumulator >> bits) & 0xff);
        }
    }
    if(bits >= 5 || ((accumulator << (8 - bits)) & 0xff) || program.length < 2 || program.length > 40)
        return null;
    if(version === 0 && program.length !== 20 && program.length !== 32) return null;
    return { hrp, version, program };
}

function bech32Encode(hrp, version, program){
    let bits = 0, accumulator = 0;
    const data = [version];
    for(const byte of program){
        accumulator = (accumulator << 8) | byte;
        bits += 8;
        while(bits >= 5){
            bits -= 5;
            data.push((accumulator >> bits) & 31);
        }
    }
    if(bits > 0) data.push((accumulator << (5 - bits)) & 31);
    const checksum = polymod(hrp, data.concat([0, 0, 0, 0, 0, 0])) ^
        (version === 0 ? 1 : 0x2bc830a3);
    for(let i = 0; i < 6; i++) data.push((checksum >> (5 * (5 - i))) & 31);
    return hrp + '1' + data.map(value => BECH32_CHARSET[value]).join('');
}

function addressParams(coin, network){
    try {
        const net = coins.consensusSubset(String(coin), String(network)).net;
        return { p2pkh: net.pubKeyHash, p2sh: net.scriptHash, hrp: net.bech32 || null };
    } catch(_e){
        return null;
    }
}

function reencodeAddress(address, fromCoin, toCoin, network){
    if(typeof address !== 'string' || address.length === 0) return null;
    const from = addressParams(fromCoin, network);
    const to = addressParams(toCoin, network);
    if(!from || !to) return null;
    if(from.hrp && address.toLowerCase().startsWith(from.hrp + '1')){
        const decoded = bech32Decode(address);
        if(!decoded || decoded.hrp !== from.hrp || !to.hrp) return null;
        return bech32Encode(to.hrp, decoded.version, decoded.program);
    }
    const payload = base58CheckDecode(address);
    if(!payload || payload.length !== 21) return null;
    let version;
    if(payload[0] === from.p2pkh) version = to.p2pkh;
    else if(payload[0] === from.p2sh) version = to.p2sh;
    else return null;
    if(!Number.isInteger(version)) return null;
    return base58CheckEncode(Buffer.concat([Buffer.from([version]), payload.subarray(1)]));
}

module.exports = { reencodeAddress };
