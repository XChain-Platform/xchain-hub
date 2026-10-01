'use strict';

const { expect } = require('chai');
const { observedListIds, firstListOutside } =
    require('../../../../../../src/anchor/publisher/archive/list_observed.js');

describe('observed archive lists', () => {
    it('returns an empty set when list snapshots are absent or not an array', () => {
        expect(observedListIds({})).to.deep.equal(new Set());
        expect(observedListIds({ list_snapshots: {} })).to.deep.equal(new Set());
    });

    it('records the string id of each list snapshot', () => {
        expect(observedListIds({
            list_snapshots: [{ snapshot_id: 'alpha' }, { snapshot_id: 12 }]
        })).to.deep.equal(new Set(['alpha', '12']));
    });

    it('returns null when every announced list was observed', () => {
        const observed = new Set(['alpha', '12']);

        expect(firstListOutside(observed, [
            { snapshot_id: 'alpha' }, { snapshot_id: 12 }
        ])).to.equal(null);
    });

    it('names the first missing list by its 16-character prefix', () => {
        const observed = new Set(['present']);

        expect(firstListOutside(observed, [
            { snapshot_id: 'present' },
            { snapshot_id: 'abcdefghijklmnop-extra' },
            { snapshot_id: 'later' }
        ])).to.equal('list abcdefghijklmnop...');
    });

    it('skips null entries and null ids', () => {
        const observed = observedListIds({
            list_snapshots: [null, { snapshot_id: null }, { snapshot_id: 'present' }]
        });

        expect(observed).to.deep.equal(new Set(['present']));
        expect(firstListOutside(observed, [null, { snapshot_id: null }])).to.equal(null);
    });
});
