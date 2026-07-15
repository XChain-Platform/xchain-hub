// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

//  (deep-review G-1/D2) regression: every count-mode quorum tally keys on
// envelope.sender via a per-engine _isKnownSender twin. An EMPTY (non-null)
// validatorPubkeys registry used to be unconditionally lenient, so any sender
// reaching a tally during an empty-registry window counted toward quorum. The
// leniency is for the genuine pre-bootstrap state only: once the on-chain
// snapshot has produced a non-empty effective signer set, an empty registry
// must fail closed.

const { expect } = require('chai');

const TWINS = [
    { name: 'Consensus', cls: require('../../src/Consensus'), method: '_isKnownSender' },
    { name: 'ReorgHandler', cls: require('../../src/ReorgHandler'), method: '_isKnownSender' },
    { name: 'OracleConsensus', cls: require('../../src/OracleConsensus'), method: '_isKnownSender' },
    { name: 'Governance', cls: require('../../src/Governance'), method: '_isKnownSender' },
    { name: 'CrossChainEngine', cls: require('../../src/CrossChainEngine'), method: '_isKnownSender' },
    { name: 'OracleRound', cls: require('../../src/OracleRound'), method: '_isRegisteredSender' },
];

function call(cls, method, peerManager, sender) {
    return cls.prototype[method].call({ peerManager }, sender);
}

describe('_isKnownSender empty-registry fail-closed ', function () {
    for (const { name, cls, method } of TWINS) {
        describe(name + '.' + method, function () {
            it('fails closed on a null registry', function () {
                expect(call(cls, method, { validatorPubkeys: null }, 'addr1')).to.equal(false);
            });

            it('stays lenient pre-bootstrap (empty registry, no signer set)', function () {
                expect(call(cls, method,
                    { validatorPubkeys: new Map(), effectiveSignerSet: null }, 'addr1')).to.equal(true);
                expect(call(cls, method,
                    { validatorPubkeys: new Map(), effectiveSignerSet: new Set() }, 'addr1')).to.equal(true);
            });

            it('fails closed on an empty registry once an effective signer set exists', function () {
                const pm = { validatorPubkeys: new Map(), effectiveSignerSet: new Set(['aa'.repeat(32)]) };
                expect(call(cls, method, pm, 'addr1')).to.equal(false);
            });

            it('keys strictly on registry membership when the registry is populated', function () {
                const pm = {
                    validatorPubkeys: new Map([['addr1', 'ab'.repeat(32)]]),
                    effectiveSignerSet: new Set(['aa'.repeat(32)]),
                };
                expect(call(cls, method, pm, 'addr1')).to.equal(true);
                expect(call(cls, method, pm, 'addr2')).to.equal(false);
            });
        });
    }
});
