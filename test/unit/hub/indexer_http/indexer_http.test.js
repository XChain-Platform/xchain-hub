'use strict';

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
 ********************************************************************/

const assert = require('assert');
const axios = require('axios');

const { axiosFor } = require('../../../../src/hub/indexer_http.js');

describe('indexer HTTP client resolution', function () {
    it('returns the real axios module without an injected module', function () {
        for (const hub of [null, {}, { constructor: { modules: {} } }]) {
            assert.strictEqual(axiosFor(hub), axios);
        }
    });

    it('returns the axios module injected through the hub constructor', function () {
        const axiosStub = {};
        const hub = { constructor: { modules: { axios: axiosStub } } };

        assert.strictEqual(axiosFor(hub), axiosStub);
    });
});
