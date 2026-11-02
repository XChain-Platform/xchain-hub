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
//
// validateLimit accepts digit strings, so the handler must hand the hub the parsed
// number: a raw string reaches `LIMIT ?` as a quoted value and MariaDB rejects it.

const sinon      = require('sinon');
const { expect } = require('chai');
const { buildOracleRpc } = require('../../../../src/api/rpc/oracle.js');

describe('getpricesnapshots digit-string limit', function () {
    let hub;
    let rpc;

    beforeEach(function () {
        hub = { getPriceSnapshots: sinon.stub().resolves([]) };
        rpc = buildOracleRpc({ hub });
    });

    it('passes a numeric limit to the hub for a digit string, a string with status, and a number', async function () {
        await rpc.getpricesnapshots({ limit: '2' });
        await rpc.getpricesnapshots({ limit: '2', status: 'all' });
        await rpc.getpricesnapshots({ limit: 2 });
        expect(hub.getPriceSnapshots.callCount).to.equal(3);
        for (const call of hub.getPriceSnapshots.getCalls()) {
            expect(typeof call.args[0]).to.equal('number');
            expect(call.args[0]).to.equal(2);
        }
    });

    it('normalizes zero-padded digit strings', async function () {
        await rpc.getpricesnapshots({ limit: '0050' });
        expect(hub.getPriceSnapshots.firstCall.args[0]).to.equal(50);
    });

    it('defaults an omitted limit to 50', async function () {
        await rpc.getpricesnapshots({});
        expect(hub.getPriceSnapshots.firstCall.args[0]).to.equal(50);
    });

    it('still refuses invalid limits without calling the hub', async function () {
        for (const bad of ['0', '1e3', '10001']) {
            const out = await rpc.getpricesnapshots({ limit: bad });
            expect(out).to.have.property('error');
        }
        expect(hub.getPriceSnapshots.called).to.equal(false);
    });
});
