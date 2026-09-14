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
 * ANCHOR publisher - on-chain existence checks
 *
 * What the DOGE indexer says about an anchor: whether a checkpoint, a bundle, an
 * archive head or a chunk is already mined, so a lost ACK adopts it instead of
 * paying for a second one.
 *
 ********************************************************************/

'use strict';

const axios = require('axios');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // On-chain ANCHOR verification (XANC-ELECTED-FORGE-1 / XANC-V0DONE-SUPPRESS-1
    // residual). A peer's BUNDLE_DONE / FINALIZED announcement is authenticated (signed
    // by an elected sender) but its txid is SELF-ASSERTED: an elected-yet-Byzantine
    // publisher can announce a checkpoint it never actually anchored on DOGE,
    // suppressing the real anchor (bogus anchor_txid stamp) or minting itself a
    // reward. Confirm the anchor really landed by asking OUR OWN DOGE indexer for
    // the DECODED anchor_actions row for this checkpoint. `cp` is a raw
    // state_checkpoints row (our own quorum-agreed copy); its hashes are the bind.
    //
    // Returns the string 'verified' ONLY when the on-chain row exists, is not a
    // decoded-invalid, is buried >= XCHAIN_CONFIRMATIONS_DOGE deep, and its payload
    // hashes byte-match our checkpoint. Every other outcome returns a short reason
    // the caller treats as ABSTAIN (skip stamp+reward): 'no-indexer' (a hub with no
    // DOGE indexer wired fails closed, i.e. skips the receiver stamp+reward; wire
    // DOGE_INDEXER_URL fleet-wide before deploy), 'unreachable',
    // 'absent', 'shallow' are the benign redundant-re-anchor direction the receiver
    // paths already tolerate; 'rejected:status' / 'rejected:mismatch' /
    // 'rejected:txid' / 'rejected:version' are a positively-detected forge.
    //
    // `expect` BINDS the announcement to a specific on-chain transaction:
    //   expect.txid    - the txid the peer announced (signed into the BUNDLE_DONE /
    //                    FINALIZED canonical), so an elected-but-Byzantine publisher
    //                    cannot point at a real-but-different anchor, nor at a
    //                    never-mined one (XANC-ELECTED-FORGE-1).
    //   expect.version - narrows to a specific ANCHOR version (the archive gate binds
    //                    the v1 head), since one checkpoint_seq carries both the v0
    //                    checkpoint bundle and the v1 archive anchor.
    //   expect.rejectVersions - a set of ANCHOR versions to REJECT when no single
    //                    exact version is expected (the BUNDLE_DONE checkpoint path passes
    //                    {1,2}, the archive-carrying set ARCHIVE_VERSIONS names in
    //                    findExistingCheckpointAnchor, so an archive anchor cannot pose
    //                    as a checkpoint anchor).
    // Without `expect` this only proves "this checkpoint is anchored at depth".
    //
    // FAIL CLOSED against an un-upgraded indexer: one that predates the txid filter
    // silently ignores the param and returns no `txid`, so a caller that asked to bind
    // a txid gets 'no-txid-support' (ABSTAIN) rather than a false 'verified'. Roll the
    // DOGE indexers before the hubs.
    async verifyAnchorOnChain(cp, expect){
        if(!cp) return 'no-checkpoint';
        let ix = this.indexers && this.indexers.DOGE;
        if(!ix || !ix.url) return 'no-indexer';
        let want = expect || {};
        let wantTxid = want.txid ? String(want.txid).toLowerCase() : null;
        let res;
        try {
            let params = {
                chain: String(cp.chain), network: String(cp.network),
                block_index: Number(cp.block_index), checkpoint_seq: Number(cp.checkpoint_seq)
            };
            if(wantTxid)                 params.txid    = wantTxid;
            if(want.version != null)     params.version = Number(want.version);
            res = await this._indexerCall('DOGE', 'getanchoraction', params);
        } catch(e){
            logger.warn('StateAnchorPublisher: getanchoraction unreachable for ' + cp.chain + '/' + cp.network +
                         ' @ ' + cp.block_index + '/' + cp.checkpoint_seq + ': ' + (e && e.message));
            return 'unreachable';
        }
        if(!res || !res.exists){
            // The filtered lookup found nothing. `checkpoint_anchored` says whether ANY
            // anchor exists for this checkpoint: if one does, the announced txid is a
            // forge (the checkpoint is anchored, just not by that tx). If none does, the
            // checkpoint simply is not anchored yet, which is the benign direction.
            if(wantTxid && res && res.checkpoint_anchored) return 'rejected:txid';
            return 'absent';
        }
        if(/^invalid/i.test(String(res.status || ''))) return 'rejected:status';
        if(!(Number(res.confirmations) >= this.dogeConfirmations)) return 'shallow';
        // Re-check the binding client-side. The indexer already filtered, so this only
        // fires against an indexer that ignored the filter (pre-upgrade) or answered
        // inconsistently; either way we must not trust an unbound row.
        if(wantTxid){
            if(!res.txid) return 'no-txid-support';
            if(String(res.txid).toLowerCase() !== wantTxid) return 'rejected:txid';
        }
        if(want.version != null && Number(res.version) !== Number(want.version)) return 'rejected:version';
        // Reject a disallowed version even when no single exact version is
        // expected. The BUNDLE_DONE path accepts the CHECKPOINT-anchor version
        // ({0}) but must not accept an ARCHIVE anchor ({1,2}): one
        // checkpoint_seq carries both, and the 4-core-hash byte-match below
        // passes for a v1 archive whose wrapper is this same checkpoint, so
        // without this a Byzantine bundle publisher could name a confirmed v1
        // archive txid as proof of a v0 anchor (stamping the row fleet-wide and
        // mirroring a reward it never earned).
        if(Array.isArray(want.rejectVersions) &&
           want.rejectVersions.map(Number).includes(Number(res.version))) return 'rejected:version';
        // Byte-match the decoded on-chain payload against our own checkpoint. The
        // four core hashes are present on every checkpoint version; state_root and
        // block_merkle_root are compared only when the on-chain anchor is a
        // root-bearing version (v0, the bundle), matching the payload the publisher
        // signed. The v1 archive heads carry no roots and are rejected by
        // rejectVersions above.
        if(!this.anchorHashEq(res.block_hash,    cp.block_hash)    ||
           !this.anchorHashEq(res.ledger_hash,   cp.ledger_hash)   ||
           !this.anchorHashEq(res.actions_hash,  cp.actions_hash)  ||
           !this.anchorHashEq(res.contract_hash, cp.contract_hash)) return 'rejected:mismatch';
        if(Number(res.version) === 0){
            if(!this.anchorHashEq(res.state_root,        cp.state_root) ||
               !this.anchorHashEq(res.block_merkle_root, cp.block_merkle_root)) return 'rejected:mismatch';
        }
        return 'verified';
    },

    // Null-safe hex-hash equality for the on-chain payload byte-match. Both
    // null/empty compare equal (a version that legitimately carries no such hash);
    // a one-sided null is a mismatch. Case-insensitive: hex hashes may differ only
    // in case between the decoder's serialization and ours.
    anchorHashEq(a, b){
        let na = (a == null || a === '') ? null : String(a).toLowerCase();
        let nb = (b == null || b === '') ? null : String(b).toLowerCase();
        return na === nb;
    },

    // JSON-RPC to a per-coin indexer (byte-identical to the ReorgHandler /
    // CrossChainCallEngine helper). The hub attaches its x-api-key; getanchoraction
    // is a FEDERATION_READ_METHOD on the indexer.
    async _indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    },

    // Existence check for ONE SECTION of a checkpoint anchor (v0): asks our own
    // DOGE indexer whether this checkpoint already has a mined, non-invalid
    // anchor. Returns { exists: true, txid } / null (definitively absent);
    // THROWS when undetermined (no indexer wired, unreachable, error reply), so
    // broadcastWithRetry can distinguish "absent" from "can't tell". Any depth
    // counts: even a 1-conf anchor spent our DOGE, so re-broadcasting would
    // double-spend regardless of whether it is deep enough to 'verify' yet.
    //
    // getanchoraction does NOT serve checkpoint anchors only. Its
    // CHECKPOINT_VERSIONS set (indexer anchor_action_query.js: [0,1])
    // carries the v1 ARCHIVE HEADS as well, and an archive head wraps a
    // checkpoint under the SAME (chain, network, block_index, checkpoint_seq)
    // identity it is keyed on, so an UNFILTERED lookup answers with whichever
    // row landed at the higher action_index. Adopting an archive head as this
    // checkpoint's anchor stamps the archive txid, skips the real v0 publish
    // and the reward derived from it, and satisfies the anchor cadence with the
    // wrong artifact on every hub that flushes after the head lands.
    //
    // An archive-head answer is not "absent" either: a real checkpoint anchor
    // can sit BENEATH it at a lower action_index, and calling that absent
    // re-broadcasts and double-spends. So narrow with the RPC's exact-version
    // filter (the same one verifyAnchorOnChain binds) across the checkpoint
    // versions and decide on that, rather than on the unfiltered top row.
    // (The archive path has no such query surface, so it pairs the
    // ambiguous-error defer with its own durable marker,
    // anchor_published_archives, instead of a mined lookup.)
    async findExistingCheckpointAnchor(row){
        let ix = this.indexers && this.indexers.DOGE;
        if(!ix || !ix.url) throw new Error('no DOGE indexer wired');
        // ANCHOR versions carrying an archive batch (v1 head, v2 continuation
        // chunk) and the ones that really anchor a checkpoint. Mirrors the
        // rejectVersions/{0} split the receiver paths already use. The version set
        // RESTARTED at 0 pre-launch (spec anchor-v0-single-wire.md): {0,1,2} is the
        // complete set, and every legacy number is unparseable at/above
        // ANCHOR_ACTIVATION, so asking for one would be a lookup that can only ever
        // answer absent.
        const ARCHIVE_VERSIONS    = [1, 2];
        const CHECKPOINT_VERSIONS = [0];
        let ask = async (version) => {
            let params = {
                chain: String(row.chain), network: String(row.network),
                block_index: Number(row.block_index), checkpoint_seq: Number(row.checkpoint_seq)
            };
            if(version != null) params.version = Number(version);
            let r = await this._indexerCall('DOGE', 'getanchoraction', params);
            if(!r || r.error) throw new Error('getanchoraction failed: ' + (r && r.error));
            return r;
        };
        // A decoded-invalid row never anchored the checkpoint; treat as absent
        // (our own payloads are built from the quorum row, so this is a peer's
        // malformed tx, not our lost ACK).
        let usable = (r) => !!(r && r.exists && !/^invalid/i.test(String(r.status || '')));
        let res = await ask(null);
        if(!res.exists) return null;
        // An indexer too old to report `version` answers NaN here, which is not an
        // archive version, so it keeps the pre-filter behavior rather than
        // fanning out a lookup it would answer identically.
        if(ARCHIVE_VERSIONS.includes(Number(res.version))){
            for(let v of CHECKPOINT_VERSIONS){
                let r = await ask(v);          // throws (undetermined) exactly as the unfiltered call does
                // FAIL CLOSED against an indexer that ignores the version param: it
                // would answer every one of these with the same archive head, and
                // accepting that is the adoption this whole branch exists to stop.
                // Undetermined (throw), never "absent": a false absent re-broadcasts,
                // and it would also drop broadcastWithRetry's ambiguous-send defer.
                if(r && r.exists && Number(r.version) !== Number(v))
                    throw new Error('getanchoraction ignored the version filter (asked v' + v +
                                    ', answered v' + r.version + '); cannot rule out an existing anchor');
                if(usable(r)) return { exists: true, txid: r.txid || null };
            }
            return null;
        }
        if(!usable(res)) return null;
        return { exists: true, txid: res.txid || null };
    },

    // Existence check for a whole BUNDLE (spec §2.4), the failover-race guard on the
    // checkpoint leg. Needs NO new RPC and no new index: it calls the per-section lookup
    // above once per section, on the section's own (chain, network, block_index,
    // checkpoint_seq), which is exactly the key `getanchoraction` already serves.
    //
    // Adopts ONLY when EVERY section resolves to a mined, non-invalid v0 row sharing ONE
    // txid. Anything less is not this bundle: a partial answer would stamp some sections
    // from a transaction that does not carry the others, and a second spend for the
    // missing ones is the correct outcome. THROWS when any section is undetermined (no
    // indexer, unreachable), so _broadcastWithRetry keeps its "absent" vs "can't tell"
    // distinction and never re-broadcasts on an unreadable view.
    //
    // The byte-determinism rule (D5) is what makes this sound in a race: two publishers
    // building the same bundle emit identical bytes, so a section adopted here is the
    // section we would have published.
    async _findExistingBundle(sections){
        let txid = null;
        for(let s of sections || []){
            let r = await this.findExistingCheckpointAnchor(s);   // throws when undetermined
            if(!(r && r.exists)) return null;                      // one section absent: not this bundle
            let t = r.txid ? String(r.txid).toLowerCase() : null;
            if(!t) return null;                                    // cannot prove one transaction carried the set
            if(txid === null) txid = t;
            else if(txid !== t) return null;                       // sections anchored by DIFFERENT transactions
        }
        return txid ? { exists: true, txid: txid } : null;
    },

    // CONTENT-ADDRESSED existence check for an ARCHIVE anchor (v1 head + its v2
    // chunks), the archive-path sibling of findExistingCheckpointAnchor above.
    //
    // The archive path publishes BEFORE it records: _publishArchive broadcasts the head
    // and every continuation chunk, and only then does backfillBatch stamp the rows. A
    // crash in that window leaves the rows pending, so the next flush re-elects exactly
    // the same matches and pays for the whole archive a second time. The checkpoint
    // path's guard could not be reused, because the identity every archive read is keyed
    // on (match_batch_seq) is precisely what the restart does not preserve:
    // _getNextBatchSeq is MAX(batch_seq)+1 fleet-wide, so a peer that archived in the
    // meantime moves the seq, and the re-election publishes the identical bytes under a
    // number nothing on-chain carries.
    //
    // getarchiveanchor is keyed on what the batch IS instead: the checkpoint identity
    // it wraps plus the batch's own content commitment (batch_crc32 + match_count),
    // which the publisher signs into the v1 canonical and can therefore recompute after
    // the restart. Scoped to OUR DOGE address, so the answer only ever covers spends
    // this publisher made: unscoped, anyone who copied our mined head onto the chain
    // would answer "already published" for a batch whose chunks they never sent, and we
    // would skip our own head and strand the archive.
    //
    // Returns the usable response, or null when this batch is definitively not on-chain
    // under our address. THROWS when undetermined (no indexer wired, unreachable, error
    // reply, or an indexer too old to serve the method), so _broadcastWithRetry keeps
    // its "absent" / "can't tell" distinction: an un-upgraded indexer therefore degrades
    // to exactly today's behavior (publish) rather than blocking the archive.
    async archiveAnchorLookup(cp, round){
        let ix = this.indexers && this.indexers.DOGE;
        if(!ix || !ix.url)    throw new Error('no DOGE indexer wired');
        if(!this.dogeAddress) throw new Error('no DOGE_ADDRESS configured');
        let res = await this._indexerCall('DOGE', 'getarchiveanchor', {
            chain: String(cp.chain), network: String(cp.network),
            block_index: Number(cp.block_index), checkpoint_seq: Number(cp.checkpoint_seq),
            batch_crc32: String(round.crc).toLowerCase(),
            match_count: Number(round.count),
            author: String(this.dogeAddress)
        });
        if(!res || res.error) throw new Error('getarchiveanchor failed: ' + (res && res.error));
        if(!res.exists) return null;
        // A decoded-invalid head anchored nothing, so it is not an archive we can adopt
        // or attach chunks to. Same verdict as the checkpoint path.
        if(/^invalid/i.test(String(res.status || ''))) return null;
        // Adopting needs a txid: it is what backfillBatch stamps and what the FINALIZED
        // announcement carries, and a null txid drives the '__partial__' sentinel, which
        // would leave the rows pending and adopt the same txid-less head again every
        // flush (a livelock, not a saving). Treat it as absent and republish instead.
        if(!res.txid){
            logger.warn('StateAnchorPublisher: archive head for batch crc ' + round.crc +
                         ' is on-chain but carries no resolvable txid; treating as absent');
            return null;
        }
        // Chunk geometry must match ours byte-for-byte before we attach to, or adopt,
        // that head: an identical archive split into a different number of chunks (a
        // changed chunk size across the restart) would make our chunk bytes land in
        // slots the head never declared, and the batch would fail reassembly on-chain.
        if(Number(res.total_chunks) !== Number(round.chunks.length)){
            logger.warn('StateAnchorPublisher: archive head for batch crc ' + round.crc + ' declares ' +
                         res.total_chunks + ' chunk(s) but this round built ' + round.chunks.length +
                         '; not adopting (republishing the batch whole)');
            return null;
        }
        if(res.match_batch_seq == null) return null;
        return res;
    },

    // existsCheck for the ARCHIVE HEAD broadcast (v1). The head landing is the spend
    // this guard exists to make at-most-once; the chunk-level check below covers the
    // rest of the batch. `archiveAnchor` rides along on the adopt result so
    // _publishArchive can address the remaining chunk slots under the seq the batch
    // actually landed under, which this process no longer knows.
    async findExistingArchiveAnchor(cp, round){
        let res = await this.archiveAnchorLookup(cp, round);
        if(!res) return null;
        return { exists: true, txid: res.txid || null, archiveAnchor: res };
    },

    // existsCheck for ONE v2 continuation chunk. A crash can land the head and some of
    // its chunks, so per-chunk resolution is what makes the resume cheap: without it the
    // only choices are re-sending every chunk (paying again for the ones that landed) or
    // skipping the batch (stranding it). An absent head answers "chunk absent", which is
    // right in both directions: on a fresh publish the head is still in the mempool and
    // every chunk must go out, and with no head there is nothing for a chunk to attach to.
    async findExistingArchiveChunk(cp, round, chunkIndex){
        let res = await this.archiveAnchorLookup(cp, round);
        if(!res) return null;
        let present = Array.isArray(res.chunks_present) ? res.chunks_present.map(Number) : [];
        if(!present.includes(Number(chunkIndex))) return null;
        return { exists: true, txid: res.txid || null };
    }

};
