// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Vote admission is keyed on the PROVEN SIGNING KEY, in a union of the
// chain-effective signer set and the local registry, mirroring what transport
// auth already does (PeerManager._verifySignature).
//
// Why: quorum N is CHAIN-derived, so a validator that stakes on chain raises the
// agreement threshold on every hub immediately. When admission keyed on
// envelope.sender (a P2P address the chain knows nothing about), every honest
// joiner landed in the DENOMINATOR without ever reaching the NUMERATOR, and the
// federation got harder to agree in the more adoption succeeded.
//
// Two properties this pins, both of which the fix had to preserve rather than
// trade away:
//   1. A sender is admissible because the CHAIN attributes it, never because the
//      registry happens to be empty. The empty-registry leniency still switches
//      off the moment a chain-effective set exists.
//   2. Counting keys instead of addresses CLOSES count-mode quorum forgery: N
//      envelopes signed by ONE authorized key, each naming a different sender,
//      collapse to a single vote.

const { expect } = require('chai');

const KEY_CHAIN    = 'aa'.repeat(32);   // staked on chain, absent from the registry
const KEY_REGISTRY = 'bb'.repeat(32);   // in the registry, absent from the chain set
const KEY_STRANGER = 'cc'.repeat(32);   // in neither

// The four engines whose quorum denominator comes from chain state and whose
// admission therefore had to follow it.
const CHAIN_KEYED = [
    { name: 'Consensus',        cls: require('../../src/Consensus'),        method: '_isKnownSender' },
    { name: 'OracleConsensus',  cls: require('../../src/OracleConsensus'),  method: '_isKnownSender' },
    { name: 'CrossChainEngine', cls: require('../../src/CrossChainEngine'), method: '_isKnownSender' },
    { name: 'OracleRound',      cls: require('../../src/OracleRound'),      method: '_isRegisteredSender' },
];

// Governance and ReorgHandler deliberately do NOT appear above. Both derive their
// quorum denominator from the LOCAL registry (Governance via _buildValidatorSnapshot
// off validatorSet, ReorgHandler via _getQuorum off validatorSet), so neither has the
// chain-denominator/registry-numerator mismatch this change fixes, and neither should
// start admitting on chain state alone. They keep the registry-keyed predicate.
const REGISTRY_KEYED = [
    { name: 'Governance',   cls: require('../../src/Governance'),   method: '_isKnownSender' },
    { name: 'ReorgHandler', cls: require('../../src/ReorgHandler'), method: '_isKnownSender' },
];

function call(cls, method, peerManager, arg) {
    return cls.prototype[method].call({ peerManager }, arg);
}

function env(pubkey, sender) {
    let e = { sender: sender || 'addr-whatever' };
    if (pubkey !== undefined) e.sig_pubkey = pubkey;
    return e;
}

describe('vote admission follows the chain-effective signer set', function () {
    for (const { name, cls, method } of CHAIN_KEYED) {
        describe(name + '.' + method, function () {

            it('COUNTS a chain-attributed key that the local registry has never seen', function () {
                // The defect this whole change exists to fix: staking on chain is
                // sufficient to be counted, with no operator hand-registering the
                // joiner on every other hub first.
                const pm = {
                    validatorPubkeys: new Map([['addr-other', KEY_REGISTRY]]),
                    effectiveSignerSet: new Set([KEY_CHAIN]),
                };
                expect(call(cls, method, pm, env(KEY_CHAIN))).to.equal(true);
            });

            it('does NOT count a key in neither the chain set nor the registry', function () {
                const pm = {
                    validatorPubkeys: new Map([['addr-other', KEY_REGISTRY]]),
                    effectiveSignerSet: new Set([KEY_CHAIN]),
                };
                expect(call(cls, method, pm, env(KEY_STRANGER))).to.equal(false);
            });

            it('counts a registry-only key when no chain set exists yet (pre-bootstrap)', function () {
                const pm = {
                    validatorPubkeys: new Map([['addr-other', KEY_REGISTRY]]),
                    effectiveSignerSet: null,
                };
                expect(call(cls, method, pm, env(KEY_REGISTRY))).to.equal(true);
            });

            it('counts a registry key regardless of which addr the envelope names', function () {
                // The registry is consulted as an addr-independent pubkey SET, so a
                // key rotated under a new addr keeps voting.
                const pm = {
                    validatorPubkeys: new Map([['addr-other', KEY_REGISTRY]]),
                    effectiveSignerSet: new Set([KEY_CHAIN]),
                };
                expect(call(cls, method, pm, env(KEY_REGISTRY, 'some-unrelated-addr'))).to.equal(true);
            });

            it('fails closed on an envelope carrying no sig_pubkey', function () {
                // No proven key means nothing the chain can attribute, and the sender
                // field alone is forgeable. Unconditional: no activation gate, no
                // lenient legacy path.
                const pm = {
                    validatorPubkeys: new Map([['addr-other', KEY_REGISTRY]]),
                    effectiveSignerSet: new Set([KEY_CHAIN]),
                };
                expect(call(cls, method, pm, env(undefined))).to.equal(false);
                expect(call(cls, method, pm, env(null))).to.equal(false);
                expect(call(cls, method, pm, {})).to.equal(false);
                expect(call(cls, method, pm, null)).to.equal(false);
            });

            it('fails closed on a non-string sig_pubkey', function () {
                const pm = {
                    validatorPubkeys: new Map([['addr-other', KEY_REGISTRY]]),
                    effectiveSignerSet: new Set([KEY_CHAIN]),
                };
                expect(call(cls, method, pm, env({ toString: () => KEY_CHAIN }))).to.equal(false);
            });

            it('fails closed on a null registry even when the chain attributes the key', function () {
                // A hub that could not load its own authorization floor does not get to
                // lean on the chain arm instead.
                const pm = { validatorPubkeys: null, effectiveSignerSet: new Set([KEY_CHAIN]) };
                expect(call(cls, method, pm, env(KEY_CHAIN))).to.equal(false);
            });

            it('stays lenient pre-bootstrap (empty registry, no chain set)', function () {
                expect(call(cls, method,
                    { validatorPubkeys: new Map(), effectiveSignerSet: null },
                    env(KEY_STRANGER))).to.equal(true);
                expect(call(cls, method,
                    { validatorPubkeys: new Map(), effectiveSignerSet: new Set() },
                    env(KEY_STRANGER))).to.equal(true);
            });

            it('empty-registry leniency STILL switches off once a chain set exists', function () {
                // The property the registry exists for. An empty registry alongside a
                // live chain set is a misconfiguration or a wipe window, not bootstrap;
                // counting unattributable senders there would reopen quorum forgery.
                const pm = { validatorPubkeys: new Map(), effectiveSignerSet: new Set([KEY_CHAIN]) };
                expect(call(cls, method, pm, env(KEY_STRANGER))).to.equal(false);
                // ...and the chain-attributed key is still admitted in that same window,
                // which is what makes failing closed safe rather than a liveness hole.
                expect(call(cls, method, pm, env(KEY_CHAIN))).to.equal(true);
            });

            it('is case-insensitive on the proven key', function () {
                const pm = { validatorPubkeys: new Map(), effectiveSignerSet: new Set([KEY_CHAIN]) };
                expect(call(cls, method, pm, env(KEY_CHAIN.toUpperCase()))).to.equal(true);
            });
        });
    }

    for (const { name, cls, method } of REGISTRY_KEYED) {
        describe(name + '.' + method + ' (registry-keyed by design, unchanged)', function () {
            it('fails closed on a null registry', function () {
                expect(call(cls, method, { validatorPubkeys: null }, 'addr1')).to.equal(false);
            });

            it('stays lenient pre-bootstrap (empty registry, no signer set)', function () {
                expect(call(cls, method,
                    { validatorPubkeys: new Map(), effectiveSignerSet: null }, 'addr1')).to.equal(true);
            });

            it('fails closed on an empty registry once an effective signer set exists', function () {
                const pm = { validatorPubkeys: new Map(), effectiveSignerSet: new Set([KEY_CHAIN]) };
                expect(call(cls, method, pm, 'addr1')).to.equal(false);
            });

            it('keys strictly on registry membership when the registry is populated', function () {
                const pm = {
                    validatorPubkeys: new Map([['addr1', KEY_REGISTRY]]),
                    effectiveSignerSet: new Set([KEY_CHAIN]),
                };
                expect(call(cls, method, pm, 'addr1')).to.equal(true);
                expect(call(cls, method, pm, 'addr2')).to.equal(false);
            });
        });
    }
});

describe('one key is one vote (count-mode forgery bound)', function () {
    const OracleConsensus  = require('../../src/OracleConsensus');
    const CrossChainEngine = require('../../src/CrossChainEngine');

    // A tally that keyed on envelope.sender could be inflated to a full quorum by
    // one authorized key naming N different senders. Keyed on the proven key, those
    // same N envelopes are one vote.
    for (const { name, cls } of [
        { name: 'OracleConsensus', cls: OracleConsensus },
        { name: 'CrossChainEngine', cls: CrossChainEngine },
    ]) {
        it(name + ': N envelopes from ONE key naming N senders collapse to one vote', function () {
            const votes = new Set();
            const self = { };
            for (let i = 0; i < 7; i++) {
                cls.prototype._addVote.call(self, votes, env(KEY_CHAIN, 'forged-addr-' + i));
            }
            expect(votes.size, 'one signing key, one vote').to.equal(1);
            expect([...votes]).to.deep.equal([KEY_CHAIN]);
        });

        it(name + ': distinct keys each count once', function () {
            const votes = new Set();
            const self = { };
            cls.prototype._addVote.call(self, votes, env(KEY_CHAIN, 'a'));
            cls.prototype._addVote.call(self, votes, env(KEY_REGISTRY, 'b'));
            expect(votes.size).to.equal(2);
        });

        it(name + ': an envelope with no proven key adds nothing', function () {
            const votes = new Set();
            const self = { };
            cls.prototype._addVote.call(self, votes, env(undefined, 'a'));
            expect(votes.size).to.equal(0);
        });
    }

    it('OracleConsensus tallies distinct member keys against the locked snapshot', function () {
        const self = Object.create(OracleConsensus.prototype);
        const pending = { memberPubkeys: new Set([KEY_CHAIN, KEY_REGISTRY]) };
        // KEY_STRANGER voted but is not in the round's qualified snapshot set.
        const votes = new Set([KEY_CHAIN, KEY_REGISTRY, KEY_STRANGER]);
        expect(self._countDistinctMembers(pending, votes)).to.equal(2);
    });

    it('CrossChainEngine tallies distinct member keys against the locked snapshot', function () {
        const self = Object.create(CrossChainEngine.prototype);
        const pending = { memberPubkeys: new Set([KEY_CHAIN]) };
        const votes = new Set([KEY_CHAIN, KEY_STRANGER]);
        expect(self._countedVotes(pending, votes)).to.equal(1);
    });
});

describe('Consensus._quorumMet counts signing keys', function () {
    const Consensus = require('../../src/Consensus');

    it('counts the KEY set, not the addr set, when keys are present', function () {
        const self = Object.create(Consensus.prototype);
        const ctx = { weighted: false, quorum: 3 };
        // One key that forged three sender addrs: three addrs, one key. Must NOT pass.
        const addrs = new Set(['a', 'b', 'c']);
        const keys  = new Set([KEY_CHAIN]);
        expect(self._quorumMet(ctx, addrs, keys)).to.equal(false);
    });

    it('passes once enough DISTINCT keys have voted', function () {
        const self = Object.create(Consensus.prototype);
        const ctx = { weighted: false, quorum: 3 };
        const addrs = new Set(['a']);
        const keys  = new Set([KEY_CHAIN, KEY_REGISTRY, KEY_STRANGER]);
        expect(self._quorumMet(ctx, addrs, keys)).to.equal(true);
    });

    it('falls back to the addr set only when no key voted (pre-bootstrap)', function () {
        const self = Object.create(Consensus.prototype);
        const ctx = { weighted: false, quorum: 2 };
        expect(self._quorumMet(ctx, new Set(['a', 'b']), new Set())).to.equal(true);
        expect(self._quorumMet(ctx, new Set(['a', 'b']), null)).to.equal(true);
    });
});
