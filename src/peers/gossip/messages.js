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
 * XChain Hub - P2P Message Authoring
 *
 * What this hub puts on the wire and what it accepts off it: the observer
 * hold that keeps a non-member silent, envelope construction and signing,
 * the broadcast and unicast paths, and signature verification.
 *
 ********************************************************************/

const crypto = require('crypto');
const WebSocket = require('ws');
const ValidatorIdentity = require('../../validators/identity.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Option A verification: the envelope carries its own signing pubkey, so the
// key is checked for MEMBERSHIP first and only then for the signature, with the
// sender<->key binding enforced last.
function verifyCarriedKey(pm, envelope, outcome) {
    let pk = envelope.sig_pubkey.toLowerCase();
    // Denylist: reject outright, BEFORE any expensive Ed25519 verify.
    if (pm.denyPubkeys.has(pk)) return false;
    // Membership check BEFORE verify (DoS guard: never burn a verify on
    // a key we'd reject anyway). Admit iff the key is in the chain
    // effective set OR the registry's pubkey set (addr-independent).
    let inSet = (pm.effectiveSignerSet && pm.effectiveSignerSet.has(pk))
             || pm.registryHasPubkey(pk);
    // Not a member: reject when sigs are required (fail closed); preserve
    // the permissive mode otherwise, matching the unknown-sender path.
    // The reason is reported separately from a crypto failure: a joining
    // validator whose STAKE has not activated yet signs perfectly well, and
    // telling it its SIGNATURE is bad sends its operator hunting keys.
    if (!inSet) {
        if (outcome) outcome.reason = 'not_in_signer_set';
        return !pm.requireSigs;
    }
    if (!ValidatorIdentity.verify(
        ValidatorIdentity.getSignablePayload(envelope), envelope.sig, pk))
        return false;
    // Sender<->key binding (fail closed, CONSENSUS-CRITICAL). A valid
    // signature proves the KEY signed, but the message is attributed to
    // envelope.sender, and every count-mode PBFT tally (Consensus /
    // OracleConsensus / AttestationConsensus / DEX / XCALL) plus the oracle
    // submission map key their integrity-critical sets on sender. Option A
    // membership alone is addr-BLIND: without this check one authorized key
    // could sign envelopes naming every OTHER validator's addr and forge a
    // full quorum (or stuff the oracle median that all hubs then co-sign).
    // If the registry knows this sender, the signing key MUST be the pubkey
    // registered to it (the same addr<->pubkey binding handleCapabilityMessage
    // enforces). A sender the registry doesn't know still passes here (an
    // on-chain-active key not yet in the manual registry, or a relayed gossip
    // origin), but its votes are dropped downstream by _isKnownSender, so
    // consensus attribution stays bound to a registered key either way.
    if (pm.validatorPubkeys) {
        let registeredPk = pm.validatorPubkeys.get(envelope.sender);
        if (registeredPk && String(registeredPk).toLowerCase() !== pk) return false;
    }
    return true;
}

class PeerMessages {

    // Should a message this hub AUTHORS be held back?
    //
    // The mirror image of the membership test verifySignature applies to an
    // arriving envelope: a hub whose signing key is outside the chain-effective
    // signer set is an observer, so every peer drops what it authors before the
    // handler runs. Proposing, preparing, committing, voting or asking for a
    // co-signature from there is pure noise (a re-admitted testnet service hub
    // cost each of five validators one PEER_REJECT every 4 s). Relay, inbound
    // handling and the mirror feed are deliberately not routed through here.
    //
    // Fails OPEN in every state that is not a definite absence, so a real
    // validator can never go silent on a transient set read: no identity, no set
    // yet, an empty set (boot, or an upstream that answered with nothing), a key
    // that will not render, or a mesh that does not require signatures at all
    // (there a peer admits an unknown sender anyway, so the send would land).
    authoringHeld() {
        if (!this.requireSigs || !this.identity) return false;
        let set = this.effectiveSignerSet;
        if (!set || typeof set.has !== 'function' || set.size === 0) return false;
        if (this._holdVerdictSet === set && this._holdVerdictId === this.identity) return this._holdVerdict;

        this._holdVerdictSet = set;
        this._holdVerdictId  = this.identity;
        let me = null;
        try { me = String(this.identity.getPubkeyHex()).toLowerCase(); }
        catch (e) { me = null; }
        this._holdVerdict = me ? !set.has(me) : false;
        this.announceAuthoringHold(set, me);
        return this._holdVerdict;
    }

    // One info line per signer-set CHANGE, never per round. Keyed on the set's
    // members rather than the Set object, because the refresh installs a new
    // object every poll and announcing per object would print every 30s.
    announceAuthoringHold(set, me) {
        let held = this._holdVerdict;
        let fp   = [...set].sort().join(',');
        let prev = this._holdAnnounced;
        if (prev && prev.held === held && (!held || prev.fp === fp)) return;
        this._holdAnnounced = { held: held, fp: fp };
        if (held) {
            logger.info('PeerManager: this hub is not in the ' + set.size + '-member chain-effective ' +
                'signer set, so it will not author consensus messages or checkpoint rounds ' +
                '(peers would drop them); receiving, relay and the mirror feed are unaffected' +
                (me ? ' (pubkey ' + me + ')' : ''));
            return;
        }
        // A member hub says nothing at boot; only the return from a hold is news.
        if (prev) {
            logger.info('PeerManager: this hub is in the ' + set.size + '-member chain-effective ' +
                'signer set; it is authoring consensus messages again');
        }
    }

    broadcast(type, data) {
        // Observer hold (authoringHeld): no envelope is built, so nothing reaches
        // the wire and no dedup slot is spent. Null rather than an envelope; no
        // caller in src/ reads the return.
        if (this.authoringHeld()) return null;

        let envelope = this.buildEnvelope(type, data);

        // Mark own message as seen (with cache bound)
        this.addToDedup(envelope.id);

        let serialized = JSON.stringify(envelope);

        for (let [addr, peer] of this.peers) {
            if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
                this._send(peer.ws, serialized);
            }
        }

        return envelope;
    }

    sendToPeer(addr, type, data) {
        // Same observer hold as broadcast: false is the existing "did not send".
        if (this.authoringHeld()) return false;

        let peer = this.peers.get(addr);
        if (!peer || !peer.ws || peer.ws.readyState !== WebSocket.OPEN) return false;

        let envelope = this.buildEnvelope(type, data);

        this.addToDedup(envelope.id);
        this._send(peer.ws, JSON.stringify(envelope));
        return true;
    }

    getPeerStatus() {
        let status = [];
        for (let [addr, peer] of this.peers) {
            status.push({
                addr:     addr,
                state:    peer.state,
                lastSeen: peer.lastSeen,
                inbound:  peer.inbound || false
            });
        }
        return status;
    }

    makeId() {
        return 'v1:' + this.validatorAddr + ':' + Date.now() + ':' + crypto.randomUUID();
    }

    buildEnvelope(type, data) {
        let envelope = {
            type:      type,
            id:        this.makeId(),
            sender:    this.validatorAddr,
            timestamp: Date.now(),
            data:      data || {}
        };
        // Sign if identity is available. Option A: carry the signing pubkey so
        // verifiers can authenticate by chain-effective-set membership (not by a
        // static addr->pubkey map). Set BEFORE signing so it is in the canonical.
        if (this.identity) {
            envelope.sig_pubkey = this.identity.getPubkeyHex();
            envelope.sig        = this.identity.signEnvelope(envelope);
        }
        return envelope;
    }

    // Verify an envelope's signature.
    //
    // Option A (sig_pubkey present): authenticate by MEMBERSHIP in the union of
    // the chain-effective signer set and the validator registry's pubkey set,
    // then verify the Ed25519 signature against the carried key. This makes
    // transport auth follow on-chain key rotation without manual registry edits.
    //
    // Backward-compat (no sig_pubkey): fall back to the static addr->pubkey
    // registry so pre-A and A hubs interoperate during a rolling deploy.
    //
    // `outcome` is an optional caller-owned object that classifies a rejection.
    // A membership miss sets outcome.reason = 'not_in_signer_set'; every other
    // rejection leaves it unset, so the caller's default (a real signature
    // failure) still applies. It is an out-param rather than a richer return
    // because every caller and test treats this method as a predicate, and the
    // boolean is the security-critical value.
    verifySignature(envelope, outcome) {
        // If signatures not required, accept unsigned messages
        if (!this.requireSigs && !envelope.sig) return true;
        // If signatures required but missing, reject
        if (this.requireSigs && !envelope.sig) return false;

        if (envelope.sig_pubkey && typeof envelope.sig_pubkey === 'string') {
            return verifyCarriedKey(this, envelope, outcome);
        }


        // --- Backward-compat path (pre-A envelope, no sig_pubkey) ---
        // No validator registry loaded: fail closed. A null registry means we
        // cannot authenticate any sender, so a self-signed envelope from an
        // unknown peer must be rejected rather than trusted. (Defense in depth:
        // the hub also refuses to open the P2P listener with a null registry;
        // see XChainHub.startP2P.) When signatures are not required the hub is
        // not authenticating peers at all, so preserve that mode's permissive
        // behavior, matching the unknown-sender handling below.
        if (!this.validatorPubkeys) return !this.requireSigs;
        // Look up sender's pubkey
        let pubkeyHex = this.validatorPubkeys.get(envelope.sender);
        if (!pubkeyHex) {
            // Unknown sender: accept if sigs not required, reject if required.
            // A membership miss on this path too (the registry is the only signer
            // set a pre-A envelope is checked against), so it reports the same
            // reason rather than blaming the peer's signature.
            if (outcome) outcome.reason = 'not_in_signer_set';
            return !this.requireSigs;
        }
        // Verify the signature
        return ValidatorIdentity.verifyEnvelope(envelope, pubkeyHex);
    }

    // True iff the validator registry maps some addr to this pubkey hex. The
    // registry is Map<addr, pubkeyHex>; Option A uses it as an addr-independent
    // pubkey SET so a rotated key is admitted as soon as the registry carries it
    // under any addr.
    registryHasPubkey(pubkeyHexLower) {
        if (!this.validatorPubkeys) return false;
        for (let v of this.validatorPubkeys.values()) {
            if (v && v.toLowerCase() === pubkeyHexLower) return true;
        }
        return false;
    }

    _send(ws, serialized) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(serialized, (err) => {
                if (err) logger.error(nodeUtil.format('WS send error:', err.message));
            });
        }
    }
}

module.exports = PeerMessages;
