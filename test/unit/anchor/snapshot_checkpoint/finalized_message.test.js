'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const crypto = require('crypto');
const {
    snapshotCheckpointCanonical,
    snapshotCheckpointQuorum,
} = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const {
    snapshotFinalizedRefusal,
} = require('../../../../src/anchor/snapshot_checkpoint/finalize_policy.js');
const {
    createSnapshotSignTally,
} = require('../../../../src/anchor/snapshot_checkpoint/sign_tally.js');
const {
    snapshotCheckpointRow,
} = require('../../../../src/anchor/snapshot_checkpoint/finalized_row.js');
const {
    acceptSnapshotFinalized,
    buildSnapshotFinalized,
} = require('../../../../src/anchor/snapshot_checkpoint/finalized_message.js');

const hash = character => character.repeat(64);

function signer() {
    const pair = crypto.generateKeyPairSync('ed25519');
    return {
        privateKey: pair.privateKey,
        pubkey: pair.publicKey.export({ format: 'der', type: 'spki' })
            .subarray(12).toString('hex'),
    };
}

let keys;
let outsider;
let trustSet;
let checkpoint;

function sign(key, cp = checkpoint) {
    const payload = Buffer.from(snapshotCheckpointCanonical(cp), 'utf8');
    return crypto.sign(null, payload, key.privateKey).toString('hex');
}

function signature(key, overrides = {}) {
    return Object.assign({ pubkey: key.pubkey, sig: sign(key) }, overrides);
}

function mixedSignatures() {
    return keys.slice(0, 3).map(key => signature(key)).concat([
        signature(outsider),
        signature(keys[3], { sig: '0'.repeat(128) }),
        signature(keys[0], { sig: '1'.repeat(128) }),
        null,
    ]);
}

function message(signatures = keys.slice(0, 3).map(key => signature(key))) {
    return buildSnapshotFinalized(106, checkpoint, signatures);
}

function view(overrides = {}) {
    return Object.assign({
        network: 'testnet',
        gateActive: true,
        expectedBlock: 100,
        trustSet,
        verify: ValidatorIdentity.verify,
        stored: null,
    }, overrides);
}

beforeEach(function () {
    keys = [signer(), signer(), signer(), signer()];
    outsider = signer();
    trustSet = keys.map((key, index) => ({
        pubkey: key.pubkey,
        weight: '1',
        source: 'source-' + index,
    }));
    checkpoint = {
        chain: 'BTC',
        network: 'testnet',
        block_index: 100,
        block_hash: hash('a'),
        state_root: hash('b'),
        state_root_version: 2,
    };
});

describe('snapshot checkpoint finalized message builder', function () {
    it('builds the exact wire shape with fresh canonical fields', function () {
        const cp = Object.assign({ ignored: true }, checkpoint);
        const signatures = [signature(keys[0])];
        const result = buildSnapshotFinalized(106, cp, signatures);

        expect(Object.keys(result)).to.deep.equal(['snapshot_block', 'cp', 'signatures']);
        expect(result.snapshot_block).to.equal(106);
        expect(result.cp).to.deep.equal(checkpoint);
        expect(result.cp).not.to.equal(cp);
        expect(result.signatures).to.deep.equal(signatures);
        expect(result.signatures).not.to.equal(signatures);
    });

    it('rejects an invalid snapshot block', function () {
        for (const snapshotBlock of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '106']) {
            expect(() => buildSnapshotFinalized(snapshotBlock, checkpoint, []))
                .to.throw(TypeError);
        }
    });

    it('passes checkpoint canonical errors through', function () {
        expect(() => buildSnapshotFinalized(106, Object.assign({}, checkpoint, {
            chain: 'LTC',
        }), [])).to.throw('snapshot checkpoint chain must be BTC');
    });

    it('requires a signature array', function () {
        for (const signatures of [null, {}, 'signatures']) {
            expect(() => buildSnapshotFinalized(106, checkpoint, signatures))
                .to.throw(TypeError);
        }
    });
});

describe('snapshot checkpoint finalized message acceptance', function () {
    it('stores only trusted verified first signatures in sorted form', function () {
        const good = keys.slice(0, 3).map(key => signature(key));
        const signatures = mixedSignatures();
        const before = JSON.stringify(signatures);
        const expected = snapshotCheckpointRow(checkpoint, good);
        const result = acceptSnapshotFinalized(message(signatures), view());

        expect(Object.keys(result)).to.deep.equal(['refusal', 'row']);
        expect(result).to.deep.equal({ refusal: null, row: expected });
        expect(snapshotCheckpointQuorum(result.row, trustSet, ValidatorIdentity.verify))
            .to.equal(true);
        expect(JSON.stringify(signatures)).to.equal(before);
    });

    it('produces the leader tally bytes regardless of message order', function () {
        const rows = keys.slice(0, 3).map(key => signature(key));
        const tally = createSnapshotSignTally(
            106, checkpoint, trustSet, ValidatorIdentity.verify
        );
        for (const row of rows) {
            tally.add(Object.assign({}, row, {
                snapshot_block: 106,
                block_index: checkpoint.block_index,
            }));
        }
        const expected = snapshotCheckpointRow(checkpoint, tally.signatures());
        const reverse = acceptSnapshotFinalized(message(mixedSignatures().reverse()), view());

        expect(reverse.refusal).to.equal(null);
        expect(reverse.row.validator_signatures).to.equal(expected.validator_signatures);
    });

    it('returns the row when the same payload is already stored', function () {
        const msg = message();
        const stored = snapshotCheckpointRow(checkpoint, msg.signatures);
        const result = acceptSnapshotFinalized(msg, view({ stored }));
        expect(result.refusal).to.equal(null);
        expect(result.row).to.deep.equal(stored);
    });

    it('returns below_quorum for one trusted signature', function () {
        const msg = message([signature(keys[0])]);
        expect(snapshotFinalizedRefusal(msg, view())).to.equal('below_quorum');
        expect(acceptSnapshotFinalized(msg, view()))
            .to.deep.equal({ refusal: 'below_quorum', row: null });
    });

    it('returns below_quorum for signatures only from outside the trust set', function () {
        expect(acceptSnapshotFinalized(message([signature(outsider)]), view()))
            .to.deep.equal({ refusal: 'below_quorum', row: null });
    });

    it('returns gate_inactive before accepting a quorum', function () {
        expect(acceptSnapshotFinalized(message(), view({ gateActive: false })))
            .to.deep.equal({ refusal: 'gate_inactive', row: null });
    });

    it('returns wrong_block for another expected checkpoint height', function () {
        expect(acceptSnapshotFinalized(message(), view({ expectedBlock: 101 })))
            .to.deep.equal({ refusal: 'wrong_block', row: null });
    });

    it('returns conflicting_payload for a different stored row', function () {
        const stored = Object.assign({}, checkpoint, { block_hash: hash('c') });
        expect(acceptSnapshotFinalized(message(), view({ stored })))
            .to.deep.equal({ refusal: 'conflicting_payload', row: null });
    });

    it('returns malformed instead of throwing for invalid inputs', function () {
        const cases = [
            [null, view()],
            [message(), null],
            [message(), view({ network: 'regtest' })],
        ];
        for (const [msg, currentView] of cases) {
            expect(acceptSnapshotFinalized(msg, currentView))
                .to.deep.equal({ refusal: 'malformed', row: null });
        }
    });
});
