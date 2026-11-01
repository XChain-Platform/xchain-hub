'use strict';

const { ANCHOR_BUNDLE_MAX_BYTES, ANCHOR_SIG_PAIR_BYTES } = require('../constants.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

function estimatedTailBytes(payload, attestSigCount) {
    const n = Math.max(0, Number(attestSigCount) || 0);
    const base = Buffer.byteLength(payload, 'utf8');
    return base - 1 + String(n).length + (n * ANCHOR_SIG_PAIR_BYTES);
}

module.exports = {
    // Wire bytes a v0 bundle would occupy with the estimated attestation tail.
    v7Bytes(sections, publisher, attestSigCount, foldActive = false) {
        if(foldActive) return this.v3Bytes(sections, publisher, attestSigCount);
        return estimatedTailBytes(this.buildV7Payload(sections, publisher, []), attestSigCount);
    },

    // The no-archive v3 fallback still carries ARCHIVE_COUNT, so it is two bytes
    // wider than v0 and must be the fold-active split floor.
    v3Bytes(sections, publisher, attestSigCount) {
        return estimatedTailBytes(
            this.buildV3Payload(null, sections, null, publisher, []), attestSigCount);
    },

    bundleBytes(sections, publisher, attestSigCount, foldActive) {
        return foldActive
            ? this.v3Bytes(sections, publisher, attestSigCount)
            : this.v7Bytes(sections, publisher, attestSigCount);
    },

    // Pack sections chain-ascending against the wire version that will be sent.
    splitBundle(sections, publisher, attestSigCount, foldActive) {
        const ordered = (sections || []).slice().sort((a, b) => {
            const x = String(a.chain), y = String(b.chain);
            return x < y ? -1 : (x > y ? 1 : 0);
        });
        const bundles = [], oversize = [];
        let current = [];
        for(const s of ordered){
            const alone = this.bundleBytes([s], publisher, attestSigCount, foldActive);
            if(alone > ANCHOR_BUNDLE_MAX_BYTES){
                oversize.push({ chain: String(s.chain), block_index: Number(s.block_index), bytes: alone });
                continue;
            }
            if(current.length > 0 &&
               this.bundleBytes(current.concat([s]), publisher, attestSigCount, foldActive) > ANCHOR_BUNDLE_MAX_BYTES){
                bundles.push(current);
                current = [];
            }
            current.push(s);
        }
        if(current.length > 0) bundles.push(current);
        if(bundles.length > 1)
            logger.info('StateAnchorPublisher: bundle for ' + (ordered[0] ? ordered[0].network : '') +
                        ' exceeds the ' + ANCHOR_BUNDLE_MAX_BYTES + '-byte budget at ' + attestSigCount +
                        ' attesting signers; split chain-ascending into ' + bundles.length + ' bundles [' +
                        bundles.map(b => b.map(s => String(s.chain)).join('+')).join(', ') + ']');
        return { bundles: bundles, oversize: oversize };
    }
};
