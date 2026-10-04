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

const { expect } = require('chai');
const { abandonBuild } = require('../../../../src/lib/encoder_reservation');

function makeEncoder(impl) {
    const calls = [];
    return {
        calls,
        releaseInputs: async (...args) => {
            calls.push(args);
            if (impl) return impl(...args);
            return undefined;
        },
    };
}

describe('abandonBuild', function () {
    describe('nothing reserved', function () {
        const cases = [
            ['a null psbtResult', null],
            ['a result with no reservation', {}],
            ['an empty-string reservation id', { reservation: { id: '' } }],
        ];
        for (const [name, result] of cases) {
            it('resolves false and never calls the encoder for ' + name, async function () {
                const encoder = makeEncoder();
                expect(await abandonBuild(encoder, result, 'rail')).to.equal(false);
                expect(encoder.calls).to.have.length(0);
            });
        }
    });

    describe('unusable encoder', function () {
        const result = { reservation: { id: 42 } };

        it('resolves false for a null encoder', async function () {
            expect(await abandonBuild(null, result, 'rail')).to.equal(false);
        });

        it('resolves false when releaseInputs is not a function', async function () {
            expect(await abandonBuild({ releaseInputs: 'nope' }, result)).to.equal(false);
        });
    });

    describe('release', function () {
        it('releases the stringified id exactly once and resolves true', async function () {
            const encoder = makeEncoder();
            expect(await abandonBuild(encoder, { reservation: { id: 42 } }, 'rail')).to.equal(true);
            expect(encoder.calls).to.deep.equal([['42']]);
        });

        it('resolves false without throwing when release rejects with who given', async function () {
            const encoder = makeEncoder(async () => { throw new Error('x'); });
            const out = await abandonBuild(encoder, { reservation: { id: 42 } }, 'rail');
            expect(out).to.equal(false);
            expect(encoder.calls).to.have.length(1);
        });

        it('resolves false without throwing when release rejects with who omitted', async function () {
            const encoder = makeEncoder(async () => { throw new Error('x'); });
            const out = await abandonBuild(encoder, { reservation: { id: 42 } });
            expect(out).to.equal(false);
            expect(encoder.calls).to.have.length(1);
        });
    });
});
