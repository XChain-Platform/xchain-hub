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
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const { parseCapabilityProofQuery } = require('../../../../src/api/rest/capability_snapshot_proof/params.js');

const CAPABILITIES = ['oracle_publish', 'anchor'];
const LOWER_KEY = 'a'.repeat(64);
const UPPER_KEY = 'B'.repeat(64);
const BAD_PARAMS = { error: 'BAD_PARAMS' };

function parse(query, configuredCapabilities) {
    const configured = arguments.length > 1 ? configuredCapabilities : CAPABILITIES;
    return parseCapabilityProofQuery(query, configured);
}

function expectBad(query, configuredCapabilities) {
    const configured = arguments.length > 1 ? configuredCapabilities : CAPABILITIES;
    expect(parseCapabilityProofQuery(query, configured)).to.deep.equal(BAD_PARAMS);
}

describe('parseCapabilityProofQuery', function () {
    it('accepts a safe non-negative block and leaves omitted pubkeys null', function () {
        expect(parse({ snapshot_block: '120', capability: 'oracle_publish' })).to.deep.equal({
            snapshotBlock: 120,
            capability: 'oracle_publish',
            pubkeys: null
        });
    });

    it('accepts zero, leading zeroes, and configured capabilities supplied as a Set', function () {
        expect(parse({ snapshot_block: '000', capability: 'anchor' }, new Set(['anchor']))).to.deep.equal({
            snapshotBlock: 0,
            capability: 'anchor',
            pubkeys: null
        });
        const longestCapability = 'x'.repeat(64);
        expect(parse({ snapshot_block: '9007199254740991', capability: longestCapability },
            [longestCapability])).to.deep.equal({
            snapshotBlock: Number.MAX_SAFE_INTEGER,
            capability: longestCapability,
            pubkeys: null
        });
    });

    it('accepts one to 256 case-insensitive hex keys and preserves their order and case', function () {
        expect(parse({ snapshot_block: '0', capability: 'anchor', pubkeys: LOWER_KEY })).to.deep.equal({
            snapshotBlock: 0,
            capability: 'anchor',
            pubkeys: [LOWER_KEY]
        });
        expect(parse({ snapshot_block: '5', capability: 'anchor', pubkeys: LOWER_KEY + ',' + UPPER_KEY }).pubkeys)
            .to.deep.equal([LOWER_KEY, UPPER_KEY]);
        const maximum = Array.from({ length: 256 }, (_, index) => index % 2 ? UPPER_KEY : LOWER_KEY);
        expect(parse({ snapshot_block: '5', capability: 'anchor', pubkeys: maximum.join(',') }).pubkeys)
            .to.deep.equal(maximum);
    });
});

describe('parseCapabilityProofQuery', function () {
    it('refuses a missing, repeated, non-string, or malformed snapshot block', function () {
        const refused = [
            undefined, '', '-1', '1.5', 'abc', ' 1', '1 ', '+1', '1e3',
            '9007199254740992', ['1', '2'], 1, null
        ];
        for (const snapshotBlock of refused) {
            expectBad({ snapshot_block: snapshotBlock, capability: 'anchor' });
        }
    });

    it('refuses a missing, empty, repeated, long, or unconfigured capability', function () {
        for (const capability of [undefined, '', ['anchor'], 'x'.repeat(65), 'stake', null]) {
            expectBad({ snapshot_block: '1', capability });
        }
        expectBad({ snapshot_block: '1', capability: 'anchor' }, new Set(['oracle_publish']));
        expectBad({ snapshot_block: '1', capability: 'anchor' }, []);
    });

    it('refuses invalid configured-capability collections', function () {
        for (const configured of [undefined, null, 'anchor', { anchor: true }]) {
            expectBad({ snapshot_block: '1', capability: 'anchor' }, configured);
        }
    });

    it('refuses empty, repeated, non-string, or malformed pubkeys', function () {
        const refused = [
            '', [], undefined, null, LOWER_KEY.slice(1), LOWER_KEY + 'g',
            LOWER_KEY + ',zz', LOWER_KEY + ',', ',' + LOWER_KEY, LOWER_KEY + ',,' + UPPER_KEY
        ];
        for (const pubkeys of refused) {
            expectBad({ snapshot_block: '1', capability: 'anchor', pubkeys });
        }
    });

    it('refuses more than 256 pubkeys', function () {
        expectBad({
            snapshot_block: '1',
            capability: 'anchor',
            pubkeys: Array.from({ length: 257 }, () => LOWER_KEY).join(',')
        });
    });

    it('always returns only the stable error field for unusable input', function () {
        for (const query of [undefined, null, [], 'query']) {
            const result = parse(query);
            expect(result).to.deep.equal(BAD_PARAMS);
            expect(Object.keys(result)).to.deep.equal(['error']);
        }
    });
});
