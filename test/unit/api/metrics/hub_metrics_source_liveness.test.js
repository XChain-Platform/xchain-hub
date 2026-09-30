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
 **********************************************************************/

'use strict';

const assert = require('assert');
const { setSourceLiveness } = require('../../../../src/api/hub_metrics_source_liveness');

function recordingGauge() {
    const calls = [];
    return {
        calls,
        set(labels, value) {
            calls.push({ labels, value });
        }
    };
}

describe('setSourceLiveness', function () {
    it('records live and dead source samples', function () {
        const gauge = recordingGauge();

        const count = setSourceLiveness(gauge, {
            live: ['binance', 'coinbase'],
            dead: ['kraken']
        });

        assert.strictEqual(count, 3);
        assert.deepStrictEqual(gauge.calls, [
            { labels: { source: 'binance' }, value: 1 },
            { labels: { source: 'coinbase' }, value: 1 },
            { labels: { source: 'kraken' }, value: 0 }
        ]);
    });

    it('sets no samples without a liveness summary', function () {
        const gauge = recordingGauge();

        assert.strictEqual(setSourceLiveness(gauge, null), 0);
        assert.strictEqual(setSourceLiveness(gauge, undefined), 0);
        assert.deepStrictEqual(gauge.calls, []);
    });

    it('sets live samples when the dead list is missing', function () {
        const gauge = recordingGauge();

        assert.strictEqual(setSourceLiveness(gauge, { live: ['binance'] }), 1);
        assert.deepStrictEqual(gauge.calls, [
            { labels: { source: 'binance' }, value: 1 }
        ]);
    });

    it('ignores invalid summaries, lists and source keys', function () {
        const gauge = recordingGauge();

        assert.strictEqual(setSourceLiveness(gauge, 'not-a-summary'), 0);
        assert.strictEqual(setSourceLiveness(gauge, {
            live: ['binance', 7, null],
            dead: 'kraken'
        }), 1);
        assert.deepStrictEqual(gauge.calls, [
            { labels: { source: 'binance' }, value: 1 }
        ]);
    });

    it('leaves the latest sample live after a source recovers', function () {
        const gauge = recordingGauge();

        setSourceLiveness(gauge, { live: [], dead: ['binance'] });
        setSourceLiveness(gauge, { live: ['binance'], dead: [] });

        const latest = gauge.calls.filter(call => call.labels.source === 'binance').at(-1);
        assert.strictEqual(latest.value, 1);
    });
});
