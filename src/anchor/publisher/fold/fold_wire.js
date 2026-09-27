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
 *
 * XChain Hub - folded ANCHOR bundle wire
 *
 ********************************************************************/

'use strict';

const { ANCHOR_BUNDLE_MAX_BYTES } = require('../constants.js');
const { buildAnchorV3Payload } = require('./v3_payload.js');

function archiveBundleFields(archive){
    if(archive === null) return { archive_count: 0 };
    return {
        archive_count: 1,
        wrapper_section_index: archive.wrapper_section_index,
        match_batch_seq: archive.match_batch_seq,
        match_count: archive.match_count,
        batch_crc32: archive.batch_crc32,
        total_chunks: archive.total_chunks,
        archive_b64: archive.archive_b64
    };
}

function buildFoldBundleWire(group, me, attestSigs, archive, network, snapshotBlock){
    const payload = buildAnchorV3Payload({
        network,
        snapshot_block: snapshotBlock,
        sections: group,
        ...archiveBundleFields(archive),
        publisher: me,
        attest_sigs: attestSigs
    });
    return Buffer.byteLength(payload, 'utf8') > ANCHOR_BUNDLE_MAX_BYTES ? null : payload;
}

module.exports = { buildFoldBundleWire };
