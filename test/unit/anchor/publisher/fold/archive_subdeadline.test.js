/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR publisher fold archive sub-deadline tests
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { raceArchiveCosign } = require('../../../../../src/anchor/publisher/fold/archive_subdeadline.js');

function after(ms, outcome, reject){
    return new Promise((resolve, rejectPromise) => {
        setTimeout(() => reject ? rejectPromise(outcome) : resolve(outcome), ms);
    });
}

describe('raceArchiveCosign', function () {
    it('keeps an archive result that resolves before the deadline', async function () {
        let value = { signature: 'archive-signature' };
        expect(await raceArchiveCosign(after(5, value), 50)).to.deep.equal({
            archiveCount: 1,
            value
        });
    });

    it('drops an archive result when the deadline wins', async function () {
        expect(await raceArchiveCosign(after(40, 'late'), 20)).to.deep.equal({
            archiveCount: 0,
            reason: 'deadline'
        });
    });

    it('turns an early archive rejection into an error result', async function () {
        let error = new Error('co-sign failed');
        expect(await raceArchiveCosign(after(5, error, true), 50)).to.deep.equal({
            archiveCount: 0,
            reason: 'error',
            error
        });
    });

    it('treats non-positive and non-finite deadlines as already elapsed', async function () {
        for(let deadlineMs of [0, -1, Infinity, NaN]){
            expect(await raceArchiveCosign(Promise.resolve('ready'), deadlineMs)).to.deep.equal({
                archiveCount: 0,
                reason: 'deadline'
            });
        }
    });

    it('does not change the settled result after a late resolution', async function () {
        let resolveCosign;
        let cosign = new Promise(resolve => { resolveCosign = resolve; });
        let raced = raceArchiveCosign(cosign, 20);
        let result = await raced;

        resolveCosign('too late');
        await after(20);

        expect(result).to.deep.equal({ archiveCount: 0, reason: 'deadline' });
        expect(await raced).to.equal(result);
    });
});
