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
 * ANCHOR publisher - v0 bundle selection and wire
 *
 * Which checkpoints ride a bundle, who is elected to publish it, and the v0
 * payload those sections serialize to, including the byte-budget split.
 *
 ********************************************************************/

'use strict';

const ar = require('../../anchor_reward_activation.js');
const { ANCHOR_BUNDLE_MAX_BYTES } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();
const { ANCHOR_SIG_PAIR_BYTES } = require('./constants.js');

module.exports = {

    // The BUNDLE election key. One election per bundle, so the key binds only what a
    // bundle is identified by: its network and its snapshot_block (the MAX over the
    // sections, D6). The retired per-row key bound chain and seq as well, which is why
    // one cycle could elect a different publisher per chain and pay three DOGE fees.
    // Takes any object carrying `network` + `snapshot_block`, so a raw state_checkpoints
    // row (every row in a bundle shares the network, and the leader's row carries the
    // bundle block) resolves the same key the bundle does.
    //
    // The 'XANCV7' tag KEEPS its pre-restart spelling even though the wire is now v0
    // (D3). It never reaches the chain, and it feeds hashOrder: renaming it permutes
    // every hub's rank the moment one hub deploys ahead of another, so two elections
    // would run at once mid-rollout. It is an opaque domain separator, not a version.
    bundleElectionKey(b){
        return 'XANCV7|' + b.network + '|' + String(b.snapshot_block);
    },

    // May THIS hub publish for `order` right now? Rank 0 always may; each
    // additional rank unlocks after ANCHOR_ELECTION_TOLERANCE_BLOCKS more BTC
    // blocks past the election anchor point (deterministic failover ladder).
    // A hub outside a non-empty eligible set never publishes, and an empty
    // (unresolved/unavailable) set means abstain (fail closed), never a
    // free-for-all where every hub double-anchors the same checkpoint.
    mayPublish(order, sinceBlocks){
        // Single source of truth for the anchor failover ladder: delegate to _rankUnlocked
        // over our own pubkey so the leader-election path and its follower verifiers can
        // never drift. Behaviour is identical to the prior inline form: an empty order or
        // a pubkey absent from it -> rank < 0 -> false; rank 0 (incl. the order.length===1
        // case) -> true; otherwise rank <= unlocked.
        if(!this.identity) return false;
        return this._rankUnlocked(order, String(this.identity.getPubkeyHex()).toLowerCase(), sinceBlocks);
    },

    // Does this hub LEAD `order` (rank 0)? The failover wake's whole job is to act
    // only where this is false, so the leader's publishing cadence is untouched.
    isRankZero(order){
        if(!this.identity || !order || order.length === 0) return false;
        return order[0] === String(this.identity.getPubkeyHex()).toLowerCase();
    },

    // This hub's position in `order`, or -1 when it is absent (or has no identity).
    // Read-only: telemetry only, never a gate. mayPublish stays the single
    // publish decision so a reporting bug can never authorize a spend.
    _myRank(order){
        if(!this.identity || !order || order.length === 0) return -1;
        return order.indexOf(String(this.identity.getPubkeyHex()).toLowerCase());
    },

    // Pick, per chain, the latest ANCHOR-ELIGIBLE checkpoint (its checkpoint
    // ORDINAL, seq divided by the cadence step, divisible by
    // anchorEveryNCheckpoints - see the constructor for why the raw seq cannot
    // carry this) that is not yet on-chain. Selecting the max eligible seq rather
    // than the absolute max means ineligible rounds never block: they simply stay
    // off-chain. With N=1 (MOD(x,1)=0 for all) this is identical to anchoring every
    // checkpoint.
    // Scoped to this.network when one is configured (matching
    // StateCheckpointEngine's latch loader): a hub DB carrying rows from a
    // prior network deployment must never re-elect publishers for (or spend
    // a real DOGE anchor on) a dead network's perpetually-unanchored
    // checkpoints. A hub with no configured network keeps the legacy
    // unscoped behavior rather than filtering everything out.
    //
    // The statement lives in db/state_checkpoints.js beside its D24 note: the
    // `anchor_txid IS NULL` predicate stays OUTSIDE the MAX subquery.
    async findAnchorEligibleSections(){
        return this.network
            ? await this.db.findAnchorEligibleUnanchoredCheckpointsByNetwork(this.checkpointIntervalBlocks,
                                                                             this.anchorEveryNCheckpoints, this.network)
            : await this.db.findAnchorEligibleUnanchoredCheckpoints(this.checkpointIntervalBlocks,
                                                                    this.anchorEveryNCheckpoints);
    },

    // Group the result set into ONE bundle per network. A chain absent from a
    // group is NOT an anomaly (D4): under the daily cadence the normal case is a
    // chain whose newest eligible seq is already anchored.
    groupSectionsByNetwork(rows){
        let byNetwork = new Map();
        for(let row of (rows || [])){
            // D8: the bundle is root-bearing by construction, so a row with no
            // light-client roots cannot ride one. Below CHECKPOINT_COMMITMENT_ACTIVATION
            // (regtest 0, testnet 146000, mainnet 961000) no federation cutting
            // checkpoints today produces such a row, so this is a loud skip rather than
            // a rootless fallback wire.
            if(row.state_root == null || row.block_merkle_root == null ||
               row.state_root_version == null || row.block_merkle_version == null){
                logger.warn('StateAnchorPublisher: checkpoint ' + row.chain + '/' + row.network + ' @ ' +
                             row.block_index + ' (seq ' + row.checkpoint_seq + ') carries no light-client roots; ' +
                             'skipped, an ANCHOR v0 section is root-bearing by construction');
                continue;
            }
            let net = String(row.network);
            if(!byNetwork.has(net)) byNetwork.set(net, []);
            byNetwork.get(net).push(row);
        }
        return byNetwork;
    },

    // Publish every bundle one network's sections split into. Each split group elects
    // independently, and a group whose oracle_publish set will not resolve is skipped
    // rather than anchored by every hub at once.
    async publishNetworkBundles(signer, network, sections, btcBlock, failoverOnly, anchored, skipped){
        // The bundle's election and attestation block is the MAX of the sections'
        // snapshot blocks (D6); in the normal case every section shares it, and a
        // lagging chain's older un-anchored row rides at its own block.
        let snapshotBlock = sections.reduce((m, s) => Math.max(m, Number(s.snapshot_block)), 0);
        let eligible;
        try { eligible = await this._getActiveOraclePublishPubkeys(snapshotBlock); }
        catch(_e){ eligible = []; }
        // Fail closed: an empty/unresolved oracle_publish set is NOT a licence for
        // every hub to anchor independently (a guaranteed N-way double-anchor + DOGE
        // burn). Skip until the set resolves.
        if(!eligible || eligible.length === 0){
            logger.warn('StateAnchorPublisher: bundle for ' + network + ' @ ' + snapshotBlock +
                         ' deferred: empty oracle_publish set (fail closed)');
            return;
        }
        let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        // Split BEFORE electing, so each bundle the split produces runs its own
        // election at its own SNAPSHOT_BLOCK (publishBundle re-resolves the set there).
        // Sizing uses the max-height oracle_publish set as the attestation tail: exact
        // for an unsplit bundle, whose block IS this one, and a close estimate for a
        // split group at an older block, where the set of that height sizes the round.
        // Size the tail the bundle will ACTUALLY carry. Below the anchor-reward
        // flag-day publishBundle attaches none at all, so charging a tail there would
        // refuse sections that anchor fine today; at/above it an unmet attestation
        // quorum DEFERS rather than degrading to a count-0 wire, so the tail is real.
        let attestTail = ar.isAnchorRewardActive(snapshotBlock, network) ? eligible.length : 0;
        let split = this.splitBundle(sections, me, attestTail);
        for(let refused of split.oversize){
            this._bundlesOversize++;
            logger.error('StateAnchorPublisher: REFUSING to anchor ' + refused.chain + '/' + network +
                          ' @ ' + refused.block_index + ': the section alone is ' + refused.bytes +
                          ' bytes at ' + attestTail + ' attesting signer(s), past the ' +
                          ANCHOR_BUNDLE_MAX_BYTES + '-byte budget. The decoder DROPS an oversize ' +
                          'action silently, so this checkpoint stays off chain until the federation ' +
                          'signer count comes down');
        }
        for(let group of split.bundles)
            await this.publishBundle(signer, network, group, btcBlock, failoverOnly, anchored, skipped);
    },

    // ONE ANCHOR v0 bundle per network per cycle: the LATEST un-anchored checkpoint of
    // every chain rides as a SECTION of one transaction (spec §2.2). Older un-anchored
    // seqs are superseded (the chained hashes commit to all prior history), so only the
    // newest per chain costs DOGE bytes. The bundle runs ONE election, ONE attestation
    // round and ONE UTXO spend where the retired per-chain wires ran N of each.
    //
    // The method keeps its name: flush() and the deferral suites drive it, and what
    // changed is the unit of work inside it, not the seam.
    async publishPendingCheckpoints(signer, btcBlock, failoverOnly){
        let rows     = await this.findAnchorEligibleSections();
        let anchored = [];
        let skipped  = { rows: 0 };
        for(let [network, sections] of this.groupSectionsByNetwork(rows))
            await this.publishNetworkBundles(signer, network, sections, btcBlock, failoverOnly, anchored, skipped);

        // One line per LEADER flush (daily, startup, size-trigger, anchorflush) when
        // it walked candidates and published none, so the stand-down is visible in the
        // log at its natural cadence. The 15-minute wake stays silent: its skips are
        // the designed steady state and the counters above carry them.
        if(!failoverOnly && skipped.rows > 0 && anchored.length === 0){
            logger.info('StateAnchorPublisher: ' + skipped.rows + ' pending checkpoint(s) belong to another hub\'s election ' +
                        '(or our backup rank is still locked); nothing anchored by this hub');
        }
        return anchored;
    },

    // ANCHOR v0, the checkpoint BUNDLE (spec §2.1). One action per network per cycle:
    //
    //   ANCHOR|0|NETWORK|SNAPSHOT_BLOCK|SECTION_COUNT
    //         |CHAIN|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH
    //          |CHECKPOINT_SEQ|SECTION_SNAPSHOT_BLOCK
    //          |STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION
    //          |SIG_COUNT|PUBKEY|SIG|...                    (x SECTION_COUNT)
    //         |PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...
    //
    // Each section is the retired per-chain body minus NETWORK: the indexer rebuilds every
    // section's XCHECKPOINT canonical with the HEADER network, so nothing about
    // per-chain checkpoint verification changes and the stored signatures still verify.
    //
    // TWO ORDERING RULES, and both are load-bearing (D5):
    //   - sections by CHAIN ascending;
    //   - within a section, the (PUBKEY, SIG) pairs by PUBKEY ascending.
    // parseSigs returns the stored JSON order UNSORTED, so without the inner sort two
    // publishers racing the same bundle emit different bytes for identical state, and
    // the attestation round's DB byte-match (§2.5) becomes non-deterministic. The frozen
    // vector deliberately feeds this builder out-of-order input to prove both sorts run.
    //
    // NETWORK comes from the sections (every row in a bundle shares it) and
    // SNAPSHOT_BLOCK is the MAX of the sections' own snapshot blocks (D6).
    //
    // Builds the v0 bundle. The method KEEPS its pre-restart name (it built the v7
    // bundle before the version set restarted at 0): it is the seam the attestation
    // round, the split arithmetic, the follower byte-match and the golden-vector suite
    // all drive, and renaming it would touch every one of them to say nothing new.
    buildV7Payload(sections, publisher, attestSigs){
        let ordered = (sections || []).slice().sort((a, b) => {
            let x = String(a.chain), y = String(b.chain);
            return x < y ? -1 : (x > y ? 1 : 0);
        });
        let network = ordered.length > 0 ? String(ordered[0].network) : '';
        let snapshotBlock = ordered.reduce((m, s) => Math.max(m, Number(s.snapshot_block)), 0);
        let parts = ['ANCHOR', '0', network, String(snapshotBlock), String(ordered.length)];
        for(let s of ordered){
            let sigs = this.parseSigs(s.validator_signatures).slice().sort((a, b) => {
                let x = String(a.pubkey), y = String(b.pubkey);
                return x < y ? -1 : (x > y ? 1 : 0);
            });
            parts.push(String(s.chain), String(s.block_index), s.block_hash,
                       s.ledger_hash, s.actions_hash, s.contract_hash,
                       String(s.checkpoint_seq), String(s.snapshot_block),
                       String(s.state_root || '').toLowerCase(), String(s.state_root_version),
                       String(s.block_merkle_root || '').toLowerCase(), String(s.block_merkle_version),
                       String(sigs.length));
            for(let sg of sigs) parts.push(sg.pubkey, sg.sig);
        }
        parts.push(String(publisher || '').toLowerCase(), String((attestSigs || []).length));
        for(let s of (attestSigs || [])) parts.push(String(s.pubkey).toLowerCase(), String(s.sig).toLowerCase());
        return parts.join('|');
    },

    // Wire bytes a bundle would occupy with `attestSigCount` attesting signers, WITHOUT
    // the signatures existing yet. The split has to run before the attestation round (each
    // split bundle elects and attests on its own), and a (PUBKEY, SIG) pair is fixed width,
    // so the tail is arithmetic: measure the body with an empty tail, then widen
    // ATTEST_SIG_COUNT from its '0' to the real decimal and add one pair per signer.
    v7Bytes(sections, publisher, attestSigCount){
        let n    = Math.max(0, Number(attestSigCount) || 0);
        let base = Buffer.byteLength(this.buildV7Payload(sections, publisher, []), 'utf8');
        return base - 1 + String(n).length + (n * ANCHOR_SIG_PAIR_BYTES);
    },

    // The byte budget and its split rule (D10). Sections are packed chain-ascending into
    // as many bundles as fit under ANCHOR_BUNDLE_MAX_BYTES; overflow is SPLIT, never
    // dropped, because the decoder discards an oversize action silently and a dropped
    // checkpoint is invisible fleet-wide. Returns { bundles, oversize }:
    //   bundles  - section groups, each of which fits with `attestSigCount` attesting
    //              signers, in chain order;
    //   oversize - sections REFUSED because one alone exceeds the budget with that SAME
    //              tail. The caller counts them (bundlesOversize) and says so loudly;
    //              nothing is sent.
    // Both checks size the same tail deliberately. Sizing the lone-section refusal at a
    // zero tail admitted a section that only fits empty-tailed: the splitter passed it,
    // the attestation round filled the tail, and the oversize payload died at the
    // encoder's RangeError instead of being refused here - a checkpoint silently off
    // chain, with bundlesOversize still reading 0. That asymmetry rode on a degraded
    // ATTEST_SIG_COUNT 0 fallback that no longer exists: publishBundle DEFERS an unmet
    // publisher-attestation quorum, because the indexer's v0 parser rejects a count-0
    // bundle outright. The caller passes 0 only below the anchor-reward flag-day, where
    // the payload genuinely carries no tail.
    splitBundle(sections, publisher, attestSigCount){
        let ordered = (sections || []).slice().sort((a, b) => {
            let x = String(a.chain), y = String(b.chain);
            return x < y ? -1 : (x > y ? 1 : 0);
        });
        let bundles = [], oversize = [], current = [];
        for(let s of ordered){
            let alone = this.v7Bytes([s], publisher, attestSigCount);
            if(alone > ANCHOR_BUNDLE_MAX_BYTES){
                oversize.push({ chain: String(s.chain), block_index: Number(s.block_index), bytes: alone });
                continue;
            }
            if(current.length > 0 && this.v7Bytes(current.concat([s]), publisher, attestSigCount) > ANCHOR_BUNDLE_MAX_BYTES){
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
