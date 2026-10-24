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
 * ANCHOR publisher - the regtest-only next archive seq override
 *
 * ANCHOR_ARCHIVE_NEXT_SEQ_OVERRIDE pins the batch seq every archive draw on this hub
 * returns, ahead of the row-derived seq, the federation floor and the own-address
 * redraw, so a regtest drill can make a hub lead a v1 head under a seq it already
 * spent and watch the indexers refuse it. Reusing a spent seq is exactly what those
 * floors exist to prevent, so the override is honoured on regtest only: set on any
 * other network, a standalone hub included, it is refused with a named error, at boot
 * and again at the draw.
 *
 ********************************************************************/

'use strict';

const hubConfig = require('../../../config');

const NEXT_SEQ_OVERRIDE = 'ANCHOR_ARCHIVE_NEXT_SEQ_OVERRIDE';

class ArchiveNextSeqOverrideNetworkError extends Error {
    constructor(network){
        super(NEXT_SEQ_OVERRIDE + ' is honoured on regtest only; refusing it on network ' + JSON.stringify(network));
        this.name = 'ArchiveNextSeqOverrideNetworkError';
        this.network = network;
    }
}

class ArchiveNextSeqOverrideValueError extends Error {
    constructor(value){
        super(NEXT_SEQ_OVERRIDE + ' must be a non-negative integer, got ' + JSON.stringify(value));
        this.name = 'ArchiveNextSeqOverrideValueError';
        this.value = value;
    }
}

// The pinned next seq, or null when the override is unset. `network` is the hub's own
// network ('' for a standalone hub); `raw` defaults to the environment value.
function resolveArchiveNextSeqOverride(network, raw = hubConfig[NEXT_SEQ_OVERRIDE]){
    if(raw === undefined || raw === null || String(raw).trim() === '') return null;
    const net = String(network || '').toLowerCase();
    if(net !== 'regtest') throw new ArchiveNextSeqOverrideNetworkError(net);
    const text = String(raw).trim();
    const seq = Number(text);
    if(!/^\d+$/.test(text) || !Number.isSafeInteger(seq)) throw new ArchiveNextSeqOverrideValueError(raw);
    return seq;
}

module.exports = {
    NEXT_SEQ_OVERRIDE,
    ArchiveNextSeqOverrideNetworkError,
    ArchiveNextSeqOverrideValueError,
    resolveArchiveNextSeqOverride
};
