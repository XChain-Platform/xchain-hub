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

'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const AttestationBatchPublisher = require('../../../../src/attestation/batch_publisher.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

describe('AttestationBatchPublisher reconciliation counters', function () {
    let dir;

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-batch-reconcile-counters-'));
    });

    afterEach(function () {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    });

    it('reports initialized reconciliation and existing publisher counters', function () {
        let identity = ValidatorIdentity.generate();
        let hub = {
            network: 'regtest',
            db: { ...DB_METHODS },
            p2pConfig: {
                ATTEST_BATCH_WINDOW_S_OVERRIDE: '10',
                ATTEST_BATCH_BUFFER_PATH: path.join(dir, 'attest-batch-buffer.jsonl'),
                ATTEST_BATCH_SPEND_STATE_PATH: path.join(dir, 'spend-state.json')
            },
            getIdentity: () => new ValidatorIdentity(identity.privkeyHex),
            peerManager: null
        };

        let stats = new AttestationBatchPublisher(hub).getStats();

        expect(stats).to.include({
            chainReconcileRuns: 0,
            chainReconcileLandedWindows: 0,
            chainReconcileFailures: 0,
            windowsPublished: 0,
            windowsEmpty: 0,
            landedRecorded: 0
        });
    });
});
