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
 * XChain Hub - folded ANCHOR v3 payload
 *
 * Builds the deterministic checkpoint and archive wire without publisher state.
 *
 ********************************************************************/

'use strict';

function parseSignatures(raw){
    if(Array.isArray(raw)) return raw.filter(s => s && s.pubkey && s.sig);
    try {
        const parsed = JSON.parse(String(raw || '[]'));
        return Array.isArray(parsed) ? parsed.filter(s => s && s.pubkey && s.sig) : [];
    } catch(_e){ return []; }
}

function compareText(a, b){
    const left = String(a);
    const right = String(b);
    return left < right ? -1 : (left > right ? 1 : 0);
}

function sectionParts(section){
    const sigs = parseSignatures(section.validator_signatures).slice()
        .sort((a, b) => compareText(a.pubkey, b.pubkey));
    const parts = [String(section.chain), String(section.block_index), section.block_hash,
        section.ledger_hash, section.actions_hash, section.contract_hash,
        String(section.checkpoint_seq), String(section.snapshot_block),
        String(section.state_root || '').toLowerCase(), String(section.state_root_version),
        String(section.block_merkle_root || '').toLowerCase(), String(section.block_merkle_version),
        String(sigs.length)];
    for(const signature of sigs) parts.push(signature.pubkey, signature.sig);
    return parts;
}

function readArchiveCount(bundle){
    const count = bundle.archive_count;
    if(count !== 0 && count !== 1)
        throw new Error('ARCHIVE_COUNT must be 0 or 1');
    return count;
}

function archiveFields(bundle, sectionCount){
    if(readArchiveCount(bundle) === 0) return [];
    const index = Number(bundle.wrapper_section_index);
    if(!Number.isInteger(index) || index < 0 || index >= sectionCount)
        throw new Error('WRAPPER_SECTION_INDEX must identify a chain section');
    return [String(index), String(bundle.match_batch_seq), String(bundle.match_count),
        String(bundle.batch_crc32), String(bundle.total_chunks), String(bundle.archive_b64)];
}

function attestationParts(bundle){
    const signatures = Array.isArray(bundle.attest_sigs) ? bundle.attest_sigs : [];
    const parts = [String(bundle.publisher || '').toLowerCase(), String(signatures.length)];
    for(const signature of signatures)
        parts.push(String(signature.pubkey).toLowerCase(), String(signature.sig).toLowerCase());
    return parts;
}

function buildAnchorV3Payload(bundle){
    const sections = (bundle.sections || []).slice()
        .sort((a, b) => compareText(a.chain, b.chain));
    const parts = ['ANCHOR', '3', String(bundle.network), String(bundle.snapshot_block),
        String(sections.length)];
    for(const section of sections) parts.push(...sectionParts(section));
    const count = readArchiveCount(bundle);
    parts.push(String(count), ...archiveFields(bundle, sections.length), ...attestationParts(bundle));
    return parts.join('|');
}

function archiveSectionBytes(bundle){
    if(readArchiveCount(bundle) === 0) return 0;
    const fields = archiveFields(bundle, (bundle.sections || []).length);
    return Buffer.byteLength(fields.join('|'), 'utf8') + 1;
}

module.exports = { buildAnchorV3Payload, archiveSectionBytes };
