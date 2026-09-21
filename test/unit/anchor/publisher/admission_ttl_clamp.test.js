'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../src/anchor/publisher');
const {
    ANCHOR_ATTEST_ARRIVAL_MARGIN_S
} = require('../../../../src/consensus/gates/anchor_reward_gate.js');

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const CHECKPOINT_AGE_MS = 6 * 10 * 60 * 1000;
const RAW_STAMP_SKEW_MS = 2 * 60 * 60 * 1000;

describe('anchor publisher admission TTL clamps', function () {
    it('does not let raised TTLs push the anchor-attest trail past its arrival budget', function () {
        const raisedTtlMs = 24 * 60 * 60 * 1000;
        const pub = new StateAnchorPublisher({
            db: {},
            p2pConfig: {
                DOGE_ADDRESS: 'Dpub1',
                ANCHOR_ANNOUNCE_RETRY_TTL_MS: String(raisedTtlMs),
                ANCHOR_INTENT_TTL_MS: String(raisedTtlMs)
            }
        });

        expect(pub.announceRetryTtlMs).to.equal(SIX_HOURS_MS);
        expect(pub.anchorIntentTtlMs).to.equal(SIX_HOURS_MS);

        const worstCaseTrailMs = CHECKPOINT_AGE_MS + pub.anchorIntentTtlMs +
            pub.announceRetryTtlMs + RAW_STAMP_SKEW_MS;
        expect(worstCaseTrailMs).to.be.at.most(ANCHOR_ATTEST_ARRIVAL_MARGIN_S * 1000);
    });
});
