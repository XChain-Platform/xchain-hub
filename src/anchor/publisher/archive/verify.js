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
 * ANCHOR publisher - archive verification against local rows
 *
 * Byte-comparison of a proposed archive against this hub's own matches, calls,
 * rewards and capability snapshots. A Byzantine leader cannot collect a quorum
 * for rows no honest hub holds.
 *
 ********************************************************************/

'use strict';

const canonicalForms = require('../canonical_forms.js');
const { resolveQuorumNetwork } = require('../../quorum_network.js');
const swq = require('../../../consensus/stake_weighted_quorum.js');
const ar = require('../../../consensus/gates/anchor_reward_gate.js');
const ark = require('../../anchor_reward_key.js');
const { legacyAnchorRewardAmount } = require('../../reward_tracker.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

    // Every archived match's TERMS must byte-equal our own cross_chain_matches
    // row (every hub writes finalized matches, so the local DB is authoritative).
    // validator_signatures is EXCLUDED from the byte-comparison (each hub stores
    // its own collected sig set; membership/order differ per node) and instead
    // verified CRYPTOGRAPHICALLY: the archived sigs must reach 2f+1 of OUR OWN
    // resolved cross_chain set over the XMATCH canonical (strictly stronger than
    // comparing local copies). Capability sets must exactly equal our own
    // resolution (set equality, not subset, so a leader can neither inject a
    // fake validator nor omit a real one).
    //
    // `wrapperSnapshotBlock` is the archive wrapper checkpoint's snapshot_block (the
    // caller's own byte-matched row, never the archive body), needed because the
    // completeness check below has to know which oracle_publish group buildArchive
    // was obliged to emit for the wrapper itself.
    async verifyArchiveAgainstLocal(archive, wrapperSnapshotBlock){
        for(let am of archive.matches){
            if(!(await this.verifyArchivedMatch(am))) return false;
        }
        for(let ac of (archive.calls || [])){
            if(!(await this.verifyArchivedCall(ac))) return false;
        }
        for(const bridge of (archive.bridge_transfers || [])){
            if(!(await this.verifyArchivedBridgeTransfer(bridge))) return false;
        }
        for(const policy of (archive.policy_snapshots || [])){
            if(!(await this.verifyArchivedPolicySnapshot(policy))) return false;
        }
        for(const checkpoint of (archive.state_checkpoints || [])){
            if(!(await this.verifyArchivedStateCheckpoint(checkpoint))) return false;
        }
        if(!(await this.verifyArchivedPriceSnapshots(archive.price_snapshots || [], archive))) return false;
        for(const tombstone of (archive.price_tombstones || [])){
            if(!(await this.verifyArchivedPriceTombstone(tombstone))) return false;
        }
        // Reward rows carry no per-row signatures (they are unilateral local
        // writes), so they verify by RE-DERIVATION: every field must equal what
        // this hub derives independently:
        //   type:      anchor publish rails only; oracle_round/attest_fee are
        //              indexer-derived and must never ride the archive
        //   pubkey:    member of OUR oracle_publish set at the earn block
        //   amount:    exactly OUR configured publish reward
        //   source:    OUR own block-scoped indexer resolution
        //   local row: if we hold (type, round), it must agree (a leader
        //              crediting itself for another hub's publish diverges
        //              here on every hub that saw the real announcement);
        //              absence alone is tolerated (late joiner), the
        //              re-derivation above still bounds what it can say.
        // Loop var is `rr` (reward row), NOT `ar`: the module import `ar`
        // (anchor_reward_activation) is what expectedArchivedRewardAmount reads for the frozen-amount gate.
        for(let rr of (archive.rewards || [])){
            if(!(await this.verifyArchivedReward(rr, archive))) return false;
        }
        let groups = this.archivedSnapshotGroups(archive);
        if(!this.seedRequiredSnapshotGroups(groups, archive, wrapperSnapshotBlock)) return false;
        return this.verifyArchivedSnapshotGroups(groups, archive);
    },

    // One archived match against our own row and the cross_chain set at its block.
    async verifyArchivedMatch(am){
        let rows = await this.db.getCrossChainMatchByMatchId(am.match_id);
        if(rows && rows.length > 0){
            let localTerms    = canonicalForms.serializeMatch(rows[0]);
            let archivedTerms = Object.assign({}, am);
            // id is per-hub bookkeeping (each hub assigns its own AUTO_INCREMENT
            // cursor); the leader archives ITS id as provenance only (ordering
            // is (snapshot_block, match_id)/(snapshot_block, call_id)), so
            // followers must not byte-compare it, like validator_signatures.
            delete localTerms.id;
            delete archivedTerms.id;
            delete localTerms.validator_signatures;
            delete archivedTerms.validator_signatures;
            if(JSON.stringify(localTerms) !== JSON.stringify(archivedTerms)){
                logger.warn("StateAnchorPublisher: archive match " + String(am.match_id).substring(0, 16) +
                             "... TERMS differ from our row; local " + JSON.stringify(localTerms).substring(0, 120) +
                             " vs archived " + JSON.stringify(archivedTerms).substring(0, 120));
                return false;
            }
        } else {
            // A row we never wrote: it predates this hub joining the
            // federation (a late joiner has no copy of earlier history).
            // The cryptographic bar below (archived sigs reaching 2f+1 of
            // OUR OWN resolved cross_chain set at the row's snapshot_block)
            // is the same proof full-parse recovery accepts, so absence is
            // not divergence. A forged row cannot carry those signatures.
            logger.info('StateAnchorPublisher: archive match ' + String(am.match_id).substring(0, 16) +
                        '... predates our local history; accepting on signature quorum alone');
        }

        let set  = await this.resolveCapabilitySet('cross_chain', Number(am.snapshot_block), resolveQuorumNetwork(am, this.network));
        let sigs = this.parseSigs(am.validator_signatures);
        if(!this.quorumVerified(this.matchCanonical(am), sigs, set, swq.isStakeWeightedQuorumActive(Number(am.snapshot_block), resolveQuorumNetwork(am, this.network)))){   // RECORD network
            logger.warn('StateAnchorPublisher: archive match ' + String(am.match_id).substring(0, 16) +
                         '... fails signature quorum against the cross_chain set at block ' + am.snapshot_block);
            return false;
        }
        return true;
    },

    // One archived XCALL relay record, the same way.
    async verifyArchivedCall(ac){
        let rows = await this.db.getCrossChainCallByCallIdAndPhase(ac.call_id, ac.phase);
        if(rows && rows.length > 0){
            let localTerms    = canonicalForms.serializeCall(rows[0]);
            let archivedTerms = Object.assign({}, ac);
            delete localTerms.id;                       // per-hub cursor; see the match loop
            delete archivedTerms.id;
            delete localTerms.validator_signatures;
            delete archivedTerms.validator_signatures;
            if(JSON.stringify(localTerms) !== JSON.stringify(archivedTerms)){
                logger.warn("StateAnchorPublisher: archive call " + String(ac.call_id).substring(0, 16) +
                             "... (" + ac.phase + ") TERMS differ from our row; local " + JSON.stringify(localTerms).substring(0, 160) +
                             " vs archived " + JSON.stringify(archivedTerms).substring(0, 160));
                return false;
            }
        } else {
            logger.info('StateAnchorPublisher: archive call ' + String(ac.call_id).substring(0, 16) +
                        '... (' + ac.phase + ') predates our local history; accepting on signature quorum alone');
        }

        let set  = await this.resolveCapabilitySet('cross_chain', Number(ac.snapshot_block), resolveQuorumNetwork(ac, this.network));
        let sigs = this.parseSigs(ac.validator_signatures);
        if(!this.quorumVerified(this.callCanonical(ac), sigs, set, swq.isStakeWeightedQuorumActive(Number(ac.snapshot_block), resolveQuorumNetwork(ac, this.network)))){   // RECORD network
            logger.warn('StateAnchorPublisher: archive call ' + String(ac.call_id).substring(0, 16) +
                         '... (' + ac.phase + ') fails signature quorum against the cross_chain set at block ' + ac.snapshot_block);
            return false;
        }
        return true;
    },

    // One archived reward row, re-derived field by field (see verifyArchiveAgainstLocal).
    async verifyArchivedReward(rr, archive){
        let tag = (rr && rr.reward_type) + '/#' + (rr && rr.round_number);
        if(!rr || !/^anchor_[A-Za-z_]+$/.test(String(rr.reward_type || ''))){
            logger.warn('StateAnchorPublisher: archive reward ' + tag + ' has a non-anchor reward_type; NOT signing');
            return false;
        }
        let pubkey = String(rr.validator_pubkey || '').toLowerCase();
        // Resolve the RECORD's network once, and use it for the
        // capability set AND both flag-day gates below.
        //
        // The gates read the archive's own network, the same one the capability-set
        // resolution on the next line uses, never `this.network`, the DEPLOYMENT
        // network, matching the record/mirror sites. On an unscoped hub
        // (network === '') a deployment-network gate resolves inactive, so this
        // verifier would expect the legacy operator-tunable amount while the leader
        // that built the row used the FROZEN derived constant, and a perfectly valid
        // archive would be refused signature (or, with the mismatch the other way, a
        // wrong amount signed). The activation constants themselves do not move; only
        // which network they are read for.
        let recordNetwork = resolveQuorumNetwork(archive, this.network);
        let set = await this.resolveCapabilitySet('oracle_publish', Number(rr.block_index), recordNetwork);
        if(!set.some(v => v.pubkey === pubkey)){
            logger.warn('StateAnchorPublisher: archive reward ' + tag + ' pubkey ' + pubkey.substring(0, 12) +
                         '... is not in the oracle_publish set at block ' + rr.block_index + '; NOT signing');
            return false;
        }
        let expectedAmount = this.expectedArchivedRewardAmount(rr, recordNetwork);
        if(expectedAmount !== null && String(rr.amount) !== expectedAmount){
            logger.warn('StateAnchorPublisher: archive reward ' + tag + ' amount ' + rr.amount +
                         ' != expected ' + expectedAmount + '; NOT signing');
            return false;
        }
        let mySource = this.hub.rewardTracker
            ? await this.hub.rewardTracker.resolveSourceByPubkey(pubkey, Number(rr.block_index))
            : null;
        if(!mySource || String(rr.source) !== mySource){
            logger.warn('StateAnchorPublisher: archive reward ' + tag + ' source ' + rr.source +
                         ' does not match our resolution (' + mySource + '); NOT signing');
            return false;
        }
        let local = await this.db.findValidatorRewardsByRewardType(String(rr.reward_type), Number(rr.round_number), ark.rewardRoundQualifier(rr.reward_type, rr.block_index));
        return this.archivedRewardAgreesWithLocal(rr, tag, pubkey, local);
    },

    // A derived reward (per-chain at/above the ANCHOR_REWARD flag-day,
    // anchor_archive at/above the ARCHIVE_REWARD flag-day) carries the FROZEN consensus
    // amount that every indexer credits and recovery restores; below each flag-day the
    // legacy operator-configured amount stands. Mirrors RewardTracker.recordAnchorReward
    // so a leader's own archived rows verify here.
    // The amount this hub expects on the row, or null when neither a frozen constant
    // nor a configured reward applies.
    expectedArchivedRewardAmount(rr, recordNetwork){
        let isDerivedChain   = /^anchor_(BTC|LTC|DOGE)$/.test(String(rr.reward_type || '')) &&
                               ar.isAnchorRewardActive(Number(rr.block_index), recordNetwork);
        // anchor_bundle is the ONLY per-anchor reward the v0 bundle rail records, and it takes the
        // per-chain form's frozen amount and flag-day (RewardTracker isDerivedBundle). Omit
        // it here and every bundle row falls through to the operator-tunable
        // ANCHOR_REWARD_PER_PUBLISH, so a hub carrying that override refuses to co-sign a
        // correct archive (quorum stalls) or signs a non-frozen amount into COLLECT
        // bookkeeping. Keep this branch in lockstep with RewardTracker.
        let isDerivedBundle  = String(rr.reward_type || '') === 'anchor_bundle' &&
                               ar.isAnchorRewardActive(Number(rr.block_index), recordNetwork);
        let isDerivedArchive = String(rr.reward_type || '') === 'anchor_archive' &&
                               ar.isArchiveRewardActive(Number(rr.block_index), recordNetwork);
        let expectedAmount = (isDerivedChain || isDerivedBundle)
            ? ar.ANCHOR_REWARD_AMOUNT
            : isDerivedArchive
            ? ar.ARCHIVE_REWARD_AMOUNT
            : (this.hub.rewardTracker ? legacyAnchorRewardAmount(this.hub.rewardTracker.anchorReward) : null);
        return expectedAmount;
    },

    // Cross-check against ALL our own local rows for this (reward_type,
    // round_number, round_qualifier). The qualifier is the archive leg's
    // snapshot block: round_number is a reissuable MATCH_BATCH_SEQ, so without
    // it a rebase-reissued seq matched an OLDER archive's rows and this guard
    // refused to co-sign a perfectly valid archive.
    // Reward rows are written independently by every hub
    // from the same on-chain anchor-publish events, so an honest hub that
    // saw this round derives the SAME winner set. The table's UNIQUE key
    // is (validator_pubkey, round_number, reward_type, round_qualifier), so two pubkeys can
    // legitimately co-exist for one (reward_type, round_number) under a
    // transient failover double-publish: querying ALL rows tolerates that
    // window (the archived pubkey's own row is matched and verified) while
    // still rejecting a leader that credits a pubkey we never derived.
    //   - a row for the archived pubkey  -> amount/block must agree
    //   - rows exist but none is ours     -> divergence: this hub saw the
    //                                        round and credited a DIFFERENT
    //                                        winner, so the archived pubkey
    //                                        is a misattributed/inflated
    //                                        credit -> NOT signing
    //   - no rows at all                  -> late joiner; re-derivation
    //                                        above already bounds it
    // True unless our own rows for the round contradict the archived credit.
    archivedRewardAgreesWithLocal(rr, tag, pubkey, local){
        if(local && local.length > 0){
            let mine = local.find(r => String(r.validator_pubkey).toLowerCase() === pubkey);
            if(!mine){
                logger.warn('StateAnchorPublisher: archive reward ' + tag + ' credits ' + pubkey.substring(0, 12) +
                             '... but our local rows for this round credit ' +
                             local.map(r => String(r.validator_pubkey).substring(0, 12) + '...').join(',') +
                             '; NOT signing');
                return false;
            }
            if(String(mine.amount) !== String(rr.amount) ||
               (mine.block_index != null && Number(mine.block_index) !== Number(rr.block_index))){
                logger.warn('StateAnchorPublisher: archive reward ' + tag + ' diverges from our row (' +
                             String(mine.validator_pubkey).substring(0, 12) + '.../' + mine.amount + '/' + mine.block_index +
                             ' vs ' + pubkey.substring(0, 12) + '.../' + rr.amount + '/' + rr.block_index + '); NOT signing');
                return false;
            }
        } else {
            logger.info('StateAnchorPublisher: archive reward ' + tag + ' predates our local history; accepting on re-derivation alone');
        }
        return true;
    },

        // Key the inner map on `pubkey|source`, NOT pubkey alone. At/above
        // STAKE_WEIGHTED_QUORUM the snapshot is one row per (source, pubkey), so a key
        // delegated by two sources contributes TWO rows; a pubkey-only map collapsed
        // them to one, making archived.size < resolved.length so `resolved.length !==
        // archived.size` rejected every archive containing a multi-source key (the
        // co-sign stall). The builder (buildArchive) already emits both rows, so the
        // verifier is the odd one out. Inert below SWQ, where source='' and there is one
        // row per pubkey (key becomes `pubkey|`).
    archivedSnapshotGroups(archive){
    let groups = new Map();              // block|capability -> Map<pubkey|source, {amount, source}>
    for(let s of (archive.capability_snapshots || [])){
        let key = Number(s.snapshot_block) + '|' + String(s.capability);
        if(!groups.has(key)) groups.set(key, new Map());
        let sSource = String(s.source != null ? s.source : '');
        groups.get(key).set(String(s.signing_pubkey).toLowerCase() + '|' + sSource,
                            { amount: String(s.amount), source: sSource });
    }
        return groups;
    },

        // COMPLETENESS. `groups` is derived from archive.capability_snapshots, which is
        // ATTACKER-SUPPLIED, so iterating it alone only proves the groups the leader chose
        // to include are honest. A Byzantine elected leader that DROPS a whole
        // (block, capability) group is never visited: the match/call/reward signature
        // checks above resolve their sets LOCALLY, so they still pass, and this hub
        // co-signs. The indexer's full-parse recovery then rebuilds each verification set
        // FROM the archived rows (recovery.js setFor), gets an empty set for the omitted
        // group and refuses the wrapper or the affected match/call: a quorum-signed but
        // permanently unrecoverable anchor stranding settled cross_chain rows.
        //
        // Re-derive the group list exactly as the honest builder does (buildArchive
        // `wants`) and seed any missing key with an EMPTY map, so the loop below judges it
        // with the same `resolved.length !== archived.size` rule as every present group.
        // Seeding rather than rejecting outright is deliberate: a group whose set OUR OWN
        // resolution also finds empty is legitimately absent from an honest archive
        // (buildArchive emits one row per member, so an empty set emits nothing), and
        // rejecting it would stall co-signing on honest rounds.
    // False when a required group sits at a non-numeric block (a malformed archive).
    seedRequiredSnapshotGroups(groups, archive, wrapperSnapshotBlock){
    let wants = (archive.matches || []).map(m => ({ block: m.snapshot_block, capability: 'cross_chain' }))
        .concat((archive.calls   || []).map(c => ({ block: c.snapshot_block, capability: 'cross_chain' })))
        .concat((archive.bridge_transfers || []).map(b => ({ block: b.snapshot_block, capability: 'cross_chain' })))
        .concat((archive.policy_snapshots || []).map(p => ({ block: p.snapshot_block, capability: 'cross_chain' })))
        .concat((archive.state_checkpoints || []).map(c => ({ block: c.snapshot_block, capability: 'oracle_publish' })))
        .concat((archive.price_snapshots || []).filter(p => this.isSignatureProofedPrice(p))
            .map(p => ({ block: p.reference_block, capability: 'price' })))
        .concat((archive.rewards || []).map(r => ({ block: r.block_index,    capability: 'oracle_publish' })));
    if(wrapperSnapshotBlock != null)
        wants.push({ block: wrapperSnapshotBlock, capability: 'oracle_publish' });
    for(let w of wants){
        // An honest builder always emits a finite height; a non-numeric one is a
        // malformed archive, and letting it through would resolve a NaN-keyed set.
        if(!Number.isFinite(Number(w.block))){
            logger.warn('StateAnchorPublisher: archive requires a ' + w.capability +
                         ' snapshot group at a non-numeric block (' + w.block + '); NOT signing');
            return false;
        }
        let key = Number(w.block) + '|' + w.capability;
        if(!groups.has(key)) groups.set(key, new Map());
    }
        return true;
    },

    // Every group, present or seeded, must equal our own resolution of that set.
    async verifyArchivedSnapshotGroups(groups, archive){
    for(let [key, archived] of groups){
        let [block, capability] = key.split('|');
        let resolved = await this.resolveCapabilitySet(capability, Number(block), resolveQuorumNetwork(archive, this.network));
        if(resolved.length !== archived.size){
            logger.warn("StateAnchorPublisher: archive snapshot group " + key + " size " + archived.size +
                         " differs from our resolution (" + resolved.length + ")");
            return false;
        }
        for(let v of resolved){
            let vSource = String(v.source != null ? v.source : '');
            let a = archived.get(v.pubkey + '|' + vSource);
            if(!a || a.amount !== v.amount || a.source !== vSource){
                logger.warn("StateAnchorPublisher: archive snapshot group " + key + " diverges for pubkey " +
                             v.pubkey.substring(0, 12) + "... (local amount/source " + v.amount + "/" + vSource +
                             ", archived " + (a ? (a.amount + "/" + a.source) : "<absent>") + ")");
                return false;
            }
        }
    }
    return true;
    }

};
