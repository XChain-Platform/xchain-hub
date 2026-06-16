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
 * XChain Hub - Validator Identity
 *
 * Ed25519 key management, message signing, and signature verification.
 * Uses Node.js built-in crypto (no external dependencies).
 *
 ********************************************************************/

const crypto = require('crypto');

// ASN.1 DER prefix for Ed25519 SPKI (SubjectPublicKeyInfo) encoding
// This is the standard 12-byte header for wrapping a raw 32-byte Ed25519 pubkey
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ASN.1 DER prefix for Ed25519 PKCS8 (private key) encoding
// This is the standard 16-byte header for wrapping a raw 32-byte Ed25519 private key seed
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

class ValidatorIdentity {

    // Create identity from a 64-hex-char (32-byte) Ed25519 private key seed
    constructor(privkeyHex) {
        if (!privkeyHex || !/^[0-9a-fA-F]{64}$/.test(privkeyHex))
            throw new Error('SIGNING_PRIVKEY_HEX must be 64 hex characters (32-byte Ed25519 seed)');

        let seed = Buffer.from(privkeyHex, 'hex');
        let pkcs8Der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);

        this.privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
        this.publicKey  = crypto.createPublicKey(this.privateKey);

        // Extract raw 32-byte pubkey for hex representation
        let spkiDer = this.publicKey.export({ format: 'der', type: 'spki' });
        this.pubkeyHex = spkiDer.subarray(SPKI_ED25519_PREFIX.length).toString('hex');
    }

    // Get the public key as 64 hex chars
    getPubkeyHex() {
        return this.pubkeyHex;
    }

    // Sign a string payload, return 128-hex-char signature
    sign(payload) {
        let sig = crypto.sign(null, Buffer.from(payload, 'utf8'), this.privateKey);
        return sig.toString('hex');
    }

    // Get the canonical signable payload from a message envelope
    // Deterministic: sorted keys in a specific order
    static getSignablePayload(envelope) {
        return JSON.stringify({
            id:         envelope.id,
            type:       envelope.type,
            sender:     envelope.sender,
            timestamp:  envelope.timestamp,
            data:       envelope.data,
            // Option A: bind the signing key into the signature. Appended last
            // and via JSON.stringify (which omits undefined keys), so a pre-A
            // envelope without sig_pubkey produces the identical canonical it
            // was signed with — backward compatible across a rolling deploy.
            sig_pubkey: envelope.sig_pubkey
        });
    }

    // Sign an envelope, returning the signature hex
    signEnvelope(envelope) {
        let payload = ValidatorIdentity.getSignablePayload(envelope);
        return this.sign(payload);
    }

    // Verify a signature against a raw 64-hex-char pubkey
    static verify(payload, sigHex, pubkeyHex) {
        if (!sigHex || !pubkeyHex) return false;
        try {
            let pubkeyObj = ValidatorIdentity.pubkeyFromHex(pubkeyHex);
            let sig = Buffer.from(sigHex, 'hex');
            return crypto.verify(null, Buffer.from(payload, 'utf8'), pubkeyObj, sig);
        } catch (e) {
            return false;
        }
    }

    // Verify an envelope's signature against a pubkey hex
    static verifyEnvelope(envelope, pubkeyHex) {
        let payload = ValidatorIdentity.getSignablePayload(envelope);
        return ValidatorIdentity.verify(payload, envelope.sig, pubkeyHex);
    }

    // Reconstruct a crypto.KeyObject from a raw 64-hex-char Ed25519 pubkey
    static pubkeyFromHex(hex) {
        if (!hex || hex.length !== 64) throw new Error('Invalid pubkey hex length');
        let raw = Buffer.from(hex, 'hex');
        let spkiDer = Buffer.concat([SPKI_ED25519_PREFIX, raw]);
        return crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    }

    // Generate a new Ed25519 keypair (utility for key generation)
    static generate() {
        let { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        let spkiDer  = publicKey.export({ format: 'der', type: 'spki' });
        let pkcs8Der = privateKey.export({ format: 'der', type: 'pkcs8' });
        return {
            pubkeyHex:  spkiDer.subarray(SPKI_ED25519_PREFIX.length).toString('hex'),
            privkeyHex: pkcs8Der.subarray(PKCS8_ED25519_PREFIX.length).toString('hex')
        };
    }
}

module.exports = ValidatorIdentity;
