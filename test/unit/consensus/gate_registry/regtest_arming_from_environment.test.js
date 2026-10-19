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
 * test/unit/consensus/gate_registry/regtest_arming_from_environment.test.js
 *
 * src/consensus/gate_registry.js: the regtest arming variables, and the arming
 * following the environment at each read. Split from gate_registry.test.js.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const registry = require('../../../../src/consensus/gate_registry.js');

// The one loaded registry read through `fn` under `env` (one variable set, or
// cleared when the value is undefined), with the environment put back exactly
// as it was. No purge: the arming is applied at each read (D78), so the
// registry every suite holds answers for the venue as it stands now.
function bootedWith(name, value, fn) {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { return fn(registry); } finally {
        if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    }
}


describe('src/consensus/gate_registry.js: regtest arming from the environment', function () {

    const ROLLCALL  = 'rollcall_activation.ROLLCALL_ACTIVATION';
    const ADMISSION = 'mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION';
    const BARRIER   = 'anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION';

    it('keeps regtest UNPINNED when the variable is unset, off or malformed', function () {
        const heard = [];
        const listen = (w) => { if (w.name === 'RegtestArmingWarning') heard.push(w.message); };
        process.on('warning', listen);
        for (const v of [undefined, '', 'off', 'inert', 'no', 'later']) {
            bootedWith('XC_ROLLCALL_REGTEST_ACTIVATION', v, (fresh) => {
                expect(fresh.get(ROLLCALL).regtest, 'value ' + JSON.stringify(v)).to.equal(null);
            });
        }
        // The refused value said so as a process warning, the one channel a
        // registry that depends on no logger has; the accepted ones were silent.
        // The event fires on a later tick, so the check waits for it before the
        // listener goes.
        return new Promise((resolve) => setImmediate(resolve)).then(() => {
            process.removeListener('warning', listen);
            expect(heard, 'exactly one warning, for the malformed value').to.have.lengthOf(1);
            expect(heard[0]).to.match(/XC_ROLLCALL_REGTEST_ACTIVATION="later"/);
        });
    });

    it('arms regtest at the documented height on the armed words and at a given height on an integer', function () {
        for (const v of ['armed', 'GENESIS', ' on ', 'true', 'yes']) {
            bootedWith('XC_ROLLCALL_REGTEST_ACTIVATION', v, (fresh) => {
                expect(fresh.get(ROLLCALL).regtest, 'value ' + JSON.stringify(v))
                    .to.equal(fresh.get('rollcall_activation.ROLLCALL_REGTEST_ARMED_HEIGHT'));
            });
        }
        bootedWith('XC_ROLLCALL_REGTEST_ACTIVATION', '150', (fresh) => {
            expect(fresh.get(ROLLCALL).regtest).to.equal(150);
            expect(fresh.get(ROLLCALL).mainnet, 'the lever must not reach the held networks').to.equal(0);
            expect(fresh.get(ROLLCALL).testnet).to.equal(151200);
            expect(fresh.activeAt(ROLLCALL, 'regtest', null, 150, 0), 'activeAt judges the armed row').to.equal(true);
            expect(fresh.activeAt(ROLLCALL, 'regtest', null, 149, 0)).to.equal(false);
        });
    });

    it('arms every regtest key of the admission family, the barrier included, from the one admission variable', function () {
        bootedWith('XC_MIRROR_ADMISSION_ACTIVATION', '150', (fresh) => {
            const producer = fresh.get(ADMISSION);
            for (const k of ['BTC:regtest', 'LTC:regtest', 'DOGE:regtest']) expect(producer[k], k).to.equal(150);
            expect(producer['BTC:testnet']).to.equal(154234);
            expect(fresh.copy(BARRIER).regtest).to.equal(150);
            expect(fresh.get(ROLLCALL).regtest, 'the roll-call lever is a different variable').to.equal(null);
        });
    });
});

describe('src/consensus/gate_registry.js: the arming follows the environment at each read', function () {

    const GATES = 'rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION';

    it('a carrier re-required alone, with no registry purge, reads the venue as it stands now', function () {
        const before = registry.get(GATES).regtest;
        expect(before, 'the suite runs bare').to.equal(null);
        const saved = process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION;
        process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION = 'armed';
        const id = require.resolve('../../../../src/consensus/gates/rollcall_gates_gate.js');
        const cached = require.cache[id];
        try {
            expect(registry.get(GATES).regtest, 'the loaded registry answers for the environment at the read').to.equal(0);
            delete require.cache[id];
            expect(require('../../../../src/consensus/gates/rollcall_gates_gate.js').ROLLCALL_GATES_ACTIVATION.regtest,
                'a carrier re-required alone sees the armed table, as its own literal did').to.equal(0);
        } finally {
            if (cached) require.cache[id] = cached; else delete require.cache[id];
            if (saved === undefined) delete process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION;
            else process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION = saved;
        }
        expect(registry.get(GATES).regtest, 'restored, the bare reading is back').to.equal(before);
    });
});
