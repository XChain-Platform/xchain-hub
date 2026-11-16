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
 * ANCHOR publisher - archived checkpoint and price verification
 *
 ********************************************************************/

'use strict';

const { resolveQuorumNetwork } = require('../../../quorum_network.js');
const { reserializeRefusal, priceKeyFold, samePriceKey } = require('../unheld_row.js');
const swq = require('../../../../consensus/stake_weighted_quorum.js');
const { getLogger } = require('../../../../observability');
const logger = getLogger();

const HEX64 = /^[0-9a-f]{64}$/;

function withoutKeys(row, keys){
    const out = Object.assign({}, row);
    for(const key of keys) delete out[key];
    return out;
}

function sameRowExcept(local, archived, keys){
    return JSON.stringify(withoutKeys(local, keys)) ===
        JSON.stringify(withoutKeys(archived, keys));
}

// Keep validator_signatures in the checkpoint compare, unlike the other kinds: the set is
// written into the DOGE anchor body, which every co-signer rebuilds from its own rows, so
// anchoring already requires identical sets on every hub. The quorum check is the proof.
function sameRow(local, archived){
    return sameRowExcept(local, archived, ['id']);
}

// Record that a row this hub never held was accepted on its proof alone (a late joiner).
function logUnheld(subject, basis){
    logger.info('StateAnchorPublisher: archive ' + subject +
                ' predates our local history; accepting on ' + basis + ' alone');
}

// Keep batch_block_time in the compare: no signature covers it, so this is the follower's only check.
// A follower whose batch ingest lags (0 or a later landing) refuses an honest round, as finalized_apply
// does; the row re-pends when its stamp changes, but a self-finalized row keeps an orphaned landing's stamp.
// consensus_proof and validator_count are hub-local: hubs hold different signature subsets, while a
// self-finalized count records PREPARE voters rather than proof signatures. The quorum check below proves
// the signed fields; equating validator_count with its valid signer count would refuse honest rounds.
function samePriceRow(local, archived, signatureProofed){
    const keys = signatureProofed ? ['id', 'consensus_proof', 'validator_count'] : ['id'];
    return sameRowExcept(local, archived, keys);
}

function findHeldPriceRow(held, archived, signatureProofed){
    const local = (held || []).find(candidate => samePriceKey(candidate, archived));
    if(signatureProofed && local && String(local.status) === 'skipped') return null;
    return local;
}

function hasHeldLivePriceRow(held, archived){
    return (held || []).some(candidate =>
        samePriceKey(candidate, archived) &&
        String(candidate.status) !== 'skipped');
}

function priceGroupKey(row){
    return JSON.stringify([Number(row.round_number), row.consensus_proof]);
}

function priceGroups(rows){
    const groups = new Map();
    for(const row of (rows || [])){
        const key = priceGroupKey(row);
        if(!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups.values();
}

function sameSignedPriceFields(first, row){
    const keys = ['round_number', 'reference_block', 'block_timestamp',
        'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];
    return keys.every(key => String(first[key]) === String(row[key]));
}

// A proofed row this hub does not hold must be a plain finalized round row: the PRICE v0
// signature leaves status and consensus_round uncovered, and every writer stores a
// signed round as finalized at consensus round 1. Skipped and disputed need a held twin.
// The signature also leaves reference_chain, source_chain, source_action_index,
// batch_block_time and validator_count uncovered, and honest hubs store differing shapes
// for them, so for an unheld row those five columns rest on the co-signers alone.
function unheldProofedPriceRefusal(row, serialized){
    const shape = reserializeRefusal(row, serialized);
    if(shape) return shape;
    if(String(row.status) !== 'finalized')
        return 'is ' + row.status + ' with no byte-identical held row';
    if(Number(row.consensus_round) !== 1)
        return 'has consensus_round ' + row.consensus_round + ' with no held row';
    return null;
}

function checkpointInteger(value){
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Mirrors validateTombstone in xchain-indexer/bin/recovery/checkpoint_price.js.
function priceTombstoneRefusal(row){
    if(!row || typeof row !== 'object' || Array.isArray(row)) return 'has malformed shape';
    if(!checkpointInteger(row.round_number)) return 'has malformed round_number';
    if(typeof row.coin_pair !== 'string' || row.coin_pair.length === 0)
        return 'has malformed coin_pair';
    return null;
}

// Mirrors the recovery contract in xchain-indexer/bin/recovery/checkpoint_price.js.
function checkpointRecoveryRefusal(row, archiveNetwork){
    if(!row || typeof row !== 'object' || Array.isArray(row)) return 'has malformed shape';
    if(typeof row.chain !== 'string' || row.chain.length === 0 ||
       typeof row.network !== 'string' || row.network.length === 0)
        return 'has malformed chain or network';
    if(archiveNetwork && row.network !== archiveNetwork) return 'has malformed chain or network';
    for(const key of ['id', 'block_index', 'checkpoint_seq', 'snapshot_block'])
        if(!checkpointInteger(row[key])) return 'has malformed integer fields';
    for(const key of ['block_hash', 'ledger_hash', 'actions_hash', 'contract_hash'])
        if(!HEX64.test(String(row[key] || ''))) return 'has malformed ' + key;
    const supersedesFrom = row.supersedes_from == null ? null : row.supersedes_from;
    const rulesDigest = row.rules_digest == null ? null : row.rules_digest;
    const plain = supersedesFrom === null && rulesDigest === null;
    const superseding = checkpointInteger(supersedesFrom) &&
        typeof rulesDigest === 'string' && HEX64.test(rulesDigest);
    if(!plain && !superseding) return 'has malformed supersede fields';
    const rootless = row.state_root === null && row.state_root_version === null &&
        row.block_merkle_root === null && row.block_merkle_version === null;
    const rooted = HEX64.test(String(row.state_root || '')) &&
        checkpointInteger(row.state_root_version) &&
        HEX64.test(String(row.block_merkle_root || '')) &&
        checkpointInteger(row.block_merkle_version);
    if(!rootless && !rooted) return 'has malformed commitment roots';
    if(typeof row.validator_signatures !== 'string') return 'has malformed validator_signatures';
    return null;
}

module.exports = {

    async verifyArchivedStateCheckpoint(row, archive){
        const recoveryShape = checkpointRecoveryRefusal(row, resolveQuorumNetwork(archive, this.network));
        if(recoveryShape){
            logger.warn('StateAnchorPublisher: archive checkpoint ' + (row && row.chain) + '/' +
                        (row && row.network) + '/' + (row && row.checkpoint_seq) + ' ' + recoveryShape +
                        '; NOT signing');
            return false;
        }
        const held = await this.db.getStateCheckpointByChainAndNetworkAndCheckpointSeq(
            row.chain, row.network, Number(row.checkpoint_seq));
        if(held && held.length){
            if(!sameRow(this.serializeStateCheckpoint(held[0]), row)){
                logger.warn('StateAnchorPublisher: archive checkpoint ' + row.chain + '/' +
                            row.network + '/' + row.checkpoint_seq +
                            ' differs from our row; NOT signing');
                return false;
            }
        } else {
            const shape = reserializeRefusal(row, this.serializeStateCheckpoint(row));
            if(shape){
                logger.warn('StateAnchorPublisher: archive checkpoint ' + row.chain + '/' +
                            row.network + '/' + row.checkpoint_seq + ' ' + shape + '; NOT signing');
                return false;
            }
            // Root fields below their flag day are unsigned and rest on co-signers.
            logUnheld('checkpoint ' + row.chain + '/' + row.network + '/' + row.checkpoint_seq,
                      'signature quorum');
        }
        const network = resolveQuorumNetwork(row, this.network);
        const block = Number(row.snapshot_block);
        const set = await this.resolveCapabilitySet('oracle_publish', block, network);
        const weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(!this.quorumVerified(this.stateCheckpointCanonical(row),
                                this.parseSigs(row.validator_signatures), set, weighted)){
            logger.warn('StateAnchorPublisher: archive checkpoint ' + row.chain + '/' +
                        row.network + '/' + row.checkpoint_seq +
                        ' fails signature quorum at block ' + row.snapshot_block);
            return false;
        }
        return true;
    },

    async verifyArchivedPriceSnapshots(rows, archive){
        // A follower the price batch pushes never reached holds 0 where the leader stamped;
        // back-fill those clocks from the indexer first, then compare strictly as before.
        await this.backfillPriceBatchLandings(rows);
        for(const group of priceGroups(rows)){
            if(!(await this.verifyArchivedPriceGroup(group, archive))) return false;
        }
        return true;
    },

    async verifyArchivedPriceGroup(group, archive){
        const first = group[0];
        if(!Number.isFinite(Number(first.round_number)) ||
           group.some(row => !sameSignedPriceFields(first, row))){
            logger.warn('StateAnchorPublisher: archive price group has inconsistent signed fields; NOT signing');
            return false;
        }
        const held = await this.db.findPriceSnapshotsForRound(Number(first.round_number));
        const signatureProofed = this.isSignatureProofedPrice(first);
        let unheld = 0;
        for(const row of group){
            const local = findHeldPriceRow(held, row, signatureProofed);
            if(local && !samePriceRow(this.serializePriceSnapshot(local), row, signatureProofed)){
                logger.warn('StateAnchorPublisher: archive price ' + row.round_number + '/' +
                            row.coin_pair + ' differs from our row; NOT signing');
                return false;
            }
            if(!local && !this.isSignatureProofedPrice(row)){
                logger.warn('StateAnchorPublisher: archive price ' + row.round_number + '/' +
                            row.coin_pair + ' has no verifiable proof or held row; NOT signing');
                return false;
            }
            // Refuse a relabelled proofed row we do not hold (columns outside the signature)
            const refusal = local ? null :
                unheldProofedPriceRefusal(row, this.serializePriceSnapshot(row));
            if(refusal){
                logger.warn('StateAnchorPublisher: archive price ' + row.round_number + '/' +
                            row.coin_pair + ' ' + refusal + '; NOT signing');
                return false;
            }
            if(!local) unheld++;
        }
        if(unheld) logUnheld('price round ' + first.round_number + ' (' + unheld + ' pairs)',
                             'signature quorum');
        if(!signatureProofed) return true;
        const block = Number(first.reference_block);
        const network = resolveQuorumNetwork(archive, this.network);
        const set = await this.resolveCapabilitySet('price', block, network);
        const weighted = swq.isStakeWeightedQuorumActive(block, network);
        const sigs = this.parseSigs(first.consensus_proof);
        if(!this.quorumVerified(this.priceSnapshotCanonical(group, network), sigs, set, weighted)){
            logger.warn('StateAnchorPublisher: archive price round ' + first.round_number +
                        ' fails signature quorum at block ' + first.reference_block);
            return false;
        }
        return true;
    },

    // A tombstone carries no signature, so it cannot be proven when our lookup is empty.
    // Refuse one that conflicts with this archive's price rows or with a live local row.
    async verifyArchivedPriceTombstone(row, archive){
        let refusal = priceTombstoneRefusal(row);
        if(!refusal && JSON.stringify(row) !== JSON.stringify(this.serializePriceTombstone(row)))
            refusal = 'does not re-serialize unchanged';
        if(refusal){
            logger.warn('StateAnchorPublisher: archive price tombstone ' +
                        (row && row.round_number) + '/' + (row && row.coin_pair) + ' ' +
                        refusal + '; NOT signing');
            return false;
        }
        const archived = archive && archive.price_snapshots || [];
        const key = priceKeyFold(row);
        if(archived.some(price => priceKeyFold(price) === key)){
            logger.warn('StateAnchorPublisher: archive price tombstone ' + row.round_number + '/' +
                        row.coin_pair + ' conflicts with a price row in the same archive; NOT signing');
            return false;
        }
        const held = await this.db.findPriceSnapshotsForRound(Number(row.round_number));
        if(hasHeldLivePriceRow(held, row)){
            logger.warn('StateAnchorPublisher: archive price tombstone ' + row.round_number + '/' +
                        row.coin_pair + ' conflicts with our live row; NOT signing');
            return false;
        }
        logger.info('StateAnchorPublisher: archive price tombstone ' + row.round_number + '/' +
                    row.coin_pair + ' has no live row here; accepting on local absence alone');
        return true;
    }

};
