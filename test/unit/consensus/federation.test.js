'use strict';

const { expect } = require('chai');
const { isFederatedHub } = require('../../../src/consensus/federation');

function pbftIsFederated(minValidators, validators) {
    return minValidators > 1 || validators.length > 1;
}

describe('consensus/federation isFederatedHub', () => {
    const rows = [
        ['nothing set', {}, false],
        ['min 1, empty set, no peers, no seeds', { minValidators: 1, validators: [], peers: [], seedNodes: [] }, false],
        ['min 1, one validator', { minValidators: 1, validators: ['a'] }, false],
        ['min 2', { minValidators: 2 }, true],
        ['min as numeric string', { minValidators: '3' }, true],
        ['two active validators', { minValidators: 1, validators: ['a', 'b'] }, true],
        ['one open peer', { minValidators: 1, validators: ['a'], peers: [{ id: 'p' }] }, true],
        ['peer count form', { peers: 2 }, true],
        ['zero peer count', { peers: 0 }, false],
        ['seed list', { seedNodes: ['10.0.0.1:9000'] }, true],
        ['seed csv', { seedNodes: 'a:1, b:2' }, true],
        ['blank seed entries', { seedNodes: ['', '  '] }, false],
        ['blank seed csv', { seedNodes: ' , ' }, false],
        ['non-numeric min', { minValidators: 'x' }, false],
    ];

    for (const [name, input, expected] of rows) {
        it(name, () => expect(isFederatedHub(input)).to.equal(expected));
    }

    it('accepts no argument', () => expect(isFederatedHub()).to.equal(false));

    it('strictly widens pbft isFederated', () => {
        let widened = 0;
        for (const min of [0, 1, 2, 5]) {
            for (const validators of [[], ['a'], ['a', 'b']]) {
                for (const peers of [[], [{}]]) {
                    for (const seedNodes of [[], ['s:1']]) {
                        const hub = isFederatedHub({ minValidators: min, validators, peers, seedNodes });
                        const base = pbftIsFederated(min, validators);
                        if (base) expect(hub).to.equal(true);
                        if (hub && !base) widened++;
                    }
                }
            }
        }
        expect(widened).to.be.greaterThan(0);
    });
});
