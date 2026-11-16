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
 * XChain Hub - AttestationRelay: a WAL that cannot be read at boot.
 *
 * Only a missing WAL is an empty one. A read that fails with anything else leaves
 * the at-most-once sets empty, so no leg may be broadcast until a later read
 * succeeds, or a restart pays the BTC fee again for a leg the WAL already holds.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

const AttestationRelay = require('../../../../src/attestation/relay.js');
const SpendGuard       = require('../../../../src/lib/spend_guard.js');

const RID = 'd'.repeat(64);
const ctx = { dir: null, wal: null };

function makeRelay() {
    const relay = new AttestationRelay({
        db:        { doQuery: sinon.stub().resolves([]) },
        network:   'regtest',
        p2pConfig: { ATTEST_RELAY_QUEUE_PATH: ctx.wal },
        hubDbBroadcaster:   null,
        capabilitySnapshot: null,
        getPeerManager:     () => ({}),
        getIdentity:        () => ({ getPubkeyHex: () => 'a'.repeat(64), sign: () => '1'.repeat(128) })
    });
    relay.broadcastFn = sinon.stub().resolves({ txid: 'tx-1' });
    relay.legState('request').wire.set(RID, { coin: null, wire: 'ATTEST|3|' + RID });
    return relay;
}

function failWalReads(code) {
    const real = fs.readFileSync;
    return sinon.stub(fs, 'readFileSync').callsFake(function (p, ...rest) {
        if (p === ctx.wal) throw Object.assign(new Error(code + ' on read'), { code });
        return real.call(fs, p, ...rest);
    });
}

describe('AttestationRelay unreadable WAL', function () {
    beforeEach(function () {
        ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-relay-unread-'));
        ctx.wal = path.join(ctx.dir, 'queue.jsonl');
    });
    afterEach(function () {
        sinon.restore();
        SpendGuard.unregister('AttestationRelay');
        fs.rmSync(ctx.dir, { recursive: true, force: true });
    });

    it('a missing WAL is an empty log and the leg goes out', async function () {
        const relay = makeRelay();
        relay.loadWal();
        expect(relay._walUnread).to.equal(false);
        await relay.broadcast('request', RID);
        expect(relay.broadcastFn.callCount).to.equal(1);
    });

    it('a read fault other than ENOENT holds every leg and leaves the WAL file untouched', async function () {
        const record = JSON.stringify({ rid: RID, leg: 'request', phase: 'sent', txid: 'tx-0' }) + '\n';
        fs.writeFileSync(ctx.wal, record);
        const relay = makeRelay();
        const readStub = failWalReads('EIO');
        const counts = relay.loadWal();
        expect(counts).to.deep.equal({ records: 0, keys: 0 });
        expect(relay._walUnread).to.equal(true);

        await relay.broadcast('request', RID);
        expect(relay.broadcastFn.callCount, 'an unread WAL must never pass for an empty one').to.equal(0);
        expect(fs.readFileSync.wrappedMethod.call(fs, ctx.wal, 'utf8')).to.equal(record);
        readStub.restore();
    });

    it('once the WAL reads again the recorded leg stays unsent and the sets are restored', async function () {
        fs.writeFileSync(ctx.wal, JSON.stringify({ rid: RID, leg: 'request', phase: 'sent', txid: 'tx-0' }) + '\n');
        const relay = makeRelay();
        const readStub = failWalReads('EMFILE');
        relay.loadWal();
        await relay.broadcast('request', RID);
        readStub.restore();

        await relay.broadcast('request', RID);
        expect(relay._walUnread).to.equal(false);
        expect(relay._published.has(RID)).to.equal(true);
        expect(relay.broadcastFn.callCount, 'the leg the WAL records as sent is not paid for again').to.equal(0);
    });
});
