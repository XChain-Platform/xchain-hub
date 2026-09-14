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
 **********************************************************************
 *
 * AttestationBatchPublisher: shared constants
 *
 * The P2P envelope types and the catch-up and anchor bounds the batch publisher's
 * parts read. The class file re-exports all four.
 *
 ********************************************************************/

'use strict';

// The two P2P envelope types this engine owns. There is no message-type registry on
// the hub: every engine subscribes to PeerManager's 'message' event and switches on
// envelope.type, so a new pair is one const each and one case each.
const XATTESTB_SIGN_REQ = 'XATTESTB_SIGN_REQ';

const XATTESTB_SIGN     = 'XATTESTB_SIGN';

// How many closed-but-unpublished windows one sweep will attempt. A hub returning
// to a long backlog drains it over several sweeps rather than in one pass, because
// each attempt holds the signing round for up to a full sign timeout and an
// unbounded catch-up would put the LIVE window behind every stale one.
const MAX_CATCHUP_WINDOWS = 4;

// How far behind its own tip a follower will accept a proposed batch anchor, in BTC
// blocks. Roughly one day: long enough that a hub whose chain view lags by hours
// still co-signs, short enough that a proposer cannot reach back to a height whose
// capability set it once controlled.
const ANCHOR_MAX_LAG_BLOCKS = 144;

module.exports = {
    XATTESTB_SIGN_REQ,
    XATTESTB_SIGN,
    MAX_CATCHUP_WINDOWS,
    ANCHOR_MAX_LAG_BLOCKS
};
