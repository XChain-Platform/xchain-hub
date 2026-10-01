'use strict';

function heldRowVerdict({ row, heldAtSeq, latestHeldSeq, prevOriginBlock }) {
    const seq = row && row.seq;
    if (!Number.isInteger(seq) || seq < 1) return 'refuse';

    if (heldAtSeq && typeof heldAtSeq === 'object') {
        return heldAtSeq.snapshot_id === row.snapshot_id &&
            heldAtSeq.members_hash === row.members_hash ? 'pass' : 'refuse';
    }

    const latest = Number(latestHeldSeq) || 0;
    if (seq <= latest) return 'refuse';
    if (seq > latest + 1) return 'abstain';
    if (seq === 1) return 'pass';
    if (typeof prevOriginBlock !== 'number' || !Number.isFinite(prevOriginBlock)) return 'abstain';
    if (!(Number(row.origin_block) > Number(prevOriginBlock))) return 'refuse';
    return 'pass';
}

module.exports = { heldRowVerdict };
