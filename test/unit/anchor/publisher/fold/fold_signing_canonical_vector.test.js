'use strict';

const { expect } = require('chai');
const { foldArchiveCanonical } = require('../../../../../src/anchor/publisher/canonical_forms.js');
const { extendWrapperCanonicalBase } = require('../../../../../src/anchor/publisher/fold/wrapper_canonical.js');

// Load the sibling indexer verifier only in the monorepo layout; a single-repo checkout lacks it.
let Anchor = null, anchorErr = null;
try { Anchor = require('../../../../../../xchain-indexer/src/actions/anchor/index.js'); } catch (e) { anchorErr = e; }

// Skip without the sibling, but fail in the required-siblings lane (XCHAIN_REQUIRE_SIBLINGS=1).
function requireIndexer() {
    if (Anchor) return;
    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-indexer anchor is unloadable: ' +
            (anchorErr && anchorErr.message));
    this.skip();
}

// Same literal as the indexer's v3_archive_equiv_canonical.test.js; keep both byte-identical.
const EXPECTED = 'EQUIV|XCHECKPOINT|BTC|regtest|100007|7|5|0||XCHECKPOINT|BTC|regtest|100007|' +
    'a'.repeat(64) + '|' + 'b'.repeat(64) + '|' + 'c'.repeat(64) + '|' + 'd'.repeat(64) +
    '|7|41647|' + 'e'.repeat(64) + '|1|' + 'f'.repeat(64) + '|1|5|1|8665563e|1';

function wrapperCheckpoint(){
    return {
        chain: 'BTC', network: 'regtest', block_index: 100007,
        block_hash: 'a'.repeat(64), ledger_hash: 'b'.repeat(64),
        actions_hash: 'c'.repeat(64), contract_hash: 'd'.repeat(64),
        checkpoint_seq: 7, snapshot_block: 41647,
        state_root: 'e'.repeat(64), state_root_version: 1,
        block_merkle_root: 'f'.repeat(64), block_merkle_version: 1
    };
}

function indexerSection(sectionIndex){
    const cp = wrapperCheckpoint();
    return {
        FORMAT: 0, SECTION_INDEX: sectionIndex, NETWORK: cp.network, CHAIN: cp.chain,
        BLOCK_INDEX_CHECKPOINTED: String(cp.block_index), BLOCK_HASH: cp.block_hash,
        LEDGER_HASH: cp.ledger_hash, ACTIONS_HASH: cp.actions_hash, CONTRACT_HASH: cp.contract_hash,
        CHECKPOINT_SEQ: String(cp.checkpoint_seq), SNAPSHOT_BLOCK: String(cp.snapshot_block),
        STATE_ROOT: cp.state_root, STATE_ROOT_VERSION: '1',
        BLOCK_MERKLE_ROOT: cp.block_merkle_root, BLOCK_MERKLE_VERSION: '1',
        FOLD_ARCHIVE: { WRAPPER_SECTION_INDEX: '0', MATCH_BATCH_SEQ: '5', MATCH_COUNT: '1',
            BATCH_CRC32: '8665563e', TOTAL_CHUNKS: '1' }
    };
}

describe('folded ANCHOR wrapper signing canonical vector', function () {
    it('signs the byte string the indexer rebuilds for the wrapper section', function () {
        const canonical = foldArchiveCanonical(wrapperCheckpoint(), 5, 1, '8665563e', 1);
        expect(canonical).to.equal(EXPECTED);
        expect(canonical).to.have.lengthOf(491);
    });

    it('lowercases an upper-case batch CRC before signing', function () {
        expect(foldArchiveCanonical(wrapperCheckpoint(), 5, 1, '8665563E', 1)).to.equal(EXPECTED);
    });

    it('ends in the archive suffix the shared wrapper helper appends', function () {
        const archive = { WRAPPER_SECTION_INDEX: 0, MATCH_BATCH_SEQ: 5, MATCH_COUNT: 1,
            BATCH_CRC32: '8665563e', TOTAL_CHUNKS: 1 };
        const signed = foldArchiveCanonical(wrapperCheckpoint(), 5, 1, '8665563e', 1);
        expect(signed.endsWith(extendWrapperCanonicalBase('', 0, archive))).to.equal(true);
    });

    describe('against the sibling indexer verifier', function () {
        before(requireIndexer);

        it('the indexer rebuilds the hub signer bytes for the wrapper section', function () {
            const hub = foldArchiveCanonical(wrapperCheckpoint(), 5, 1, '8665563e', 1);
            expect(Anchor.prototype.canonical.call({}, indexerSection(0))).to.equal(hub);
        });

        it('a non-wrapper section keeps the batch sequence out of its round id', function () {
            const plain = Anchor.prototype.canonical.call({}, indexerSection(1));
            expect(plain.startsWith('EQUIV|XCHECKPOINT|BTC|regtest|100007|7|0||')).to.equal(true);
        });
    });
});
