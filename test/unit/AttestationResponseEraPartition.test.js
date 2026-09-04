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
 * XChain Hub - cross-engine partition guard for the ATTEST response mirror
 * design.
 *
 * AttestationPublisher and AttestationResponseMirror both listen to the same
 * AttestationConsensus 'request:finalized' event and each carries its own copy
 * of the era predicate (isResponseMirrorActive): the publisher declines a
 * mirror-era request with an early return, the mirror declines a legacy-era
 * one in buildRow's era gate. Nothing asserts the two copies actually agree,
 * so a drift between them would either double-deliver a response or drop it
 * silently. This drives the REAL publisher and REAL mirror off one shared
 * consensus emitter with only their I/O stubbed (a tmp WAL file for the
 * publisher, an in-memory table for the mirror) and asserts exactly one of
 * the two acts on every finalized event, at, below and across the activation
 * boundary.
 *
 ********************************************************************/

'use strict';

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const crypto  = require('crypto');
const sinon   = require('sinon');
const { expect } = require('chai');
const EventEmitter = require('events');

const AttestationPublisher      = require('../../src/AttestationPublisher');
const AttestationResponseMirror = require('../../src/AttestationResponseMirror');
const activationMod = require('../../src/attest_response_mirror_activation.js');

const PUB = 'aa'.repeat(32);

// A minimal in-memory stand-in for the hub's mariadb wrapper, just enough of
// INSERT IGNORE + the keyed select-back for insertAndBroadcast to complete
// without throwing. Modeled on AttestationResponseMirror.test.js's makeDb().
function makeDb() {
    let table  = [];
    let nextId = 1;
    return {
        async doQuery(sql, args) {
            if (/^INSERT IGNORE INTO attestation_responses/i.test(sql)) {
                let cols = sql.substring(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                let row = {};
                cols.forEach((c, i) => { row[c] = args[i]; });
                let clash = table.find(r => r.network === row.network && r.request_id === row.request_id);
                if (clash) return { affectedRows: 0, insertId: 0 };
                row.id = nextId++;
                table.push(row);
                return { affectedRows: 1, insertId: row.id };
            }
            if (/^SELECT id, .*FROM attestation_responses/i.test(sql)) {
                let found = table.find(r => r.network === args[0] && r.request_id === args[1]);
                return found ? [Object.assign({}, found)] : [];
            }
            throw new Error('unexpected statement: ' + sql);
        }
    };
}

// Shaped like AttestationConsensus._checkCommitQuorum's payload: a terminal
// 'ok' round with one signature and a signed effective_time, the one field the
// mirror-era canonical adds. below-height events carry it too (harmlessly:
// the publisher never reads it and the mirror's era gate returns before it
// would matter), so one helper covers every height in the sweep.
function finalizedEvent(rid, blockIndex) {
    return {
        requestId:     rid,
        providerId:    'http_get',
        responseBody:  Buffer.from('ok', 'utf8'),
        status:        'ok',
        meta:          '',
        signatures:    [{ pubkey: PUB, sig: 'ee'.repeat(64) }],
        leaderPubkey:  PUB,
        effectiveTime: 1770000000 + blockIndex,
        widen:         0,
        request:       { block_index: blockIndex, action_index: 1, redundancy: 1 }
    };
}

function buildEngines() {
    let consensus = new EventEmitter();
    let pubHub = {
        network:              'regtest',
        getIdentity:          () => ({ getPubkeyHex: () => PUB }),
        p2pConfig:            {},
        attestationConsensus: consensus
    };
    let mirrorHub = {
        network:              'regtest',
        attestationConsensus: consensus,
        db:                   makeDb(),
        hubDbBroadcaster:     { broadcastRow: sinon.stub() }
    };
    let pub = new AttestationPublisher(pubHub);
    pub.queuePath = path.join(os.tmpdir(),
        'attest-pub-partition-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    fs.writeFileSync(pub.queuePath, '');
    let mirror = new AttestationResponseMirror(mirrorHub);
    return { consensus, pub, mirror };
}

// Emits one finalized event and classifies which of the two eras acted.
// _enqueue is the publisher's durable WAL append (unconditional for a
// terminal 'ok' response, ahead of the leader/follower branch), and
// insertAndBroadcast is the mirror's one write path (shared by the
// request:finalized listener and the gossip receiver); spying on both, rather
// than re-deriving either predicate here, is what makes this a guard on the
// real engines instead of a restatement of the code under test.
async function fireAndClassify(consensus, pub, mirror, rid, blockIndex) {
    let enqueueSpy   = sinon.spy(pub, '_enqueue');
    let mirrorSpy    = sinon.spy(mirror, 'insertAndBroadcast');
    let finalizedSpy = sinon.spy(pub, 'onRequestFinalized');

    consensus.emit('request:finalized', finalizedEvent(rid, blockIndex));
    // The mirror's listener is synchronous through the insertAndBroadcast call
    // itself, so mirrorSpy.called is already settled here. The publisher's
    // listener awaits _computeResponsible before it reaches _enqueue, so wait
    // on the exact promise the internal handler is chaining on.
    await finalizedSpy.returnValues[0];

    let result = { queued: enqueueSpy.called, mirrored: mirrorSpy.called };
    enqueueSpy.restore();
    mirrorSpy.restore();
    finalizedSpy.restore();
    return result;
}

describe('ATTEST response era partition: publisher XOR mirror, never both, never neither', function () {

    let originalRegtestHeight;

    // Regtest ships armed at genesis (height 0), which leaves no room to drive
    // a genuine below-the-height case. The activation map is a plain object,
    // not frozen, so a local, restored-after height gives the sweep a real
    // boundary to cross without touching the frozen protocol constant itself.
    before(function () {
        originalRegtestHeight = activationMod.ATTEST_RESPONSE_MIRROR_ACTIVATION.regtest;
        activationMod.ATTEST_RESPONSE_MIRROR_ACTIVATION.regtest = 100;
    });

    after(function () {
        activationMod.ATTEST_RESPONSE_MIRROR_ACTIVATION.regtest = originalRegtestHeight;
    });

    afterEach(function () {
        sinon.restore();
    });

    it('below the activation height: the publisher queues, the mirror stays silent', async function () {
        let { consensus, pub, mirror } = buildEngines();
        await pub.start(); await mirror.start();
        let { queued, mirrored } = await fireAndClassify(consensus, pub, mirror, '11'.repeat(32), 50);
        expect(queued).to.equal(true);
        expect(mirrored).to.equal(false);
        fs.unlinkSync(pub.queuePath);
    });

    it('at the activation height: the mirror writes, the publisher stays silent', async function () {
        let { consensus, pub, mirror } = buildEngines();
        await pub.start(); await mirror.start();
        let { queued, mirrored } = await fireAndClassify(consensus, pub, mirror, '22'.repeat(32), 100);
        expect(queued).to.equal(false);
        expect(mirrored).to.equal(true);
        fs.unlinkSync(pub.queuePath);
    });

    it('above the activation height: the mirror writes, the publisher stays silent', async function () {
        let { consensus, pub, mirror } = buildEngines();
        await pub.start(); await mirror.start();
        let { queued, mirrored } = await fireAndClassify(consensus, pub, mirror, '33'.repeat(32), 250);
        expect(queued).to.equal(false);
        expect(mirrored).to.equal(true);
        fs.unlinkSync(pub.queuePath);
    });

    it('every height across the boundary hits exactly one era, never both, never neither', async function () {
        let { consensus, pub, mirror } = buildEngines();
        await pub.start(); await mirror.start();
        for (let h = 95; h <= 105; h++) {
            let rid = crypto.createHash('sha256').update('era-sweep-' + h).digest('hex');
            let { queued, mirrored } = await fireAndClassify(consensus, pub, mirror, rid, h);
            let exactlyOne = queued !== mirrored;
            expect(exactlyOne,
                'height ' + h + ' must hit exactly one era (queued=' + queued + ', mirrored=' + mirrored + ')'
            ).to.equal(true);
        }
        fs.unlinkSync(pub.queuePath);
    });
});
