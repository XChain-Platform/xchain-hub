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
 * ANCHOR publisher - publishing one v0 bundle
 *
 * One bundle end to end: election, the durable at-most-once marker, the
 * publisher-attestation round, build, broadcast, per-section stamp, reward and
 * the BUNDLE_DONE announcement.
 *
 ********************************************************************/

'use strict';

const StateAnchorPublisher = require('../publisher.js');
const ar = require('../../anchor_reward_activation.js');
const { ANCHOR_BUNDLE_MAX_BYTES, XANC_BUNDLE_DONE } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Elect the publisher order for one bundle, or null when the oracle_publish set
    // at its own snapshot block will not resolve.
    async bundlePublisherOrder(network, snapshotBlock, chains){
        // Elect over the oracle_publish set at THIS bundle's own snapshot block, never
        // the caller's network-wide MAX. A byte-budget split can leave a lagging chain's
        // sections in a group whose MAX is older, and BOTH follower verifiers resolve the
        // set at the group's own block (handleAttestSignReq, the BUNDLE_DONE gate), as
        // does the indexer when it verifies the anchor. Ranking the leader over a
        // different population than every verifier is a divergence, not a preference:
        // the attest round refuses to co-sign, BUNDLE_DONE is rejected, and an anchor
        // that does land names a PUBLISHER outside the set the reward derives over. The
        // caller's max-height set keeps its two jobs (the pre-split fail-closed gate and
        // the split's attestation-tail sizing) and is deliberately not passed down here.
        let eligible;
        try { eligible = await this._getActiveOraclePublishPubkeys(snapshotBlock); }
        catch(_e){ eligible = []; }
        // Fail closed per bundle, the twin of the caller's gate: an unresolved set is no
        // licence for every hub to anchor independently. Defer rather than borrow a set
        // resolved at another height.
        if(!eligible || eligible.length === 0){
            logger.warn('StateAnchorPublisher: bundle ' + chains + '/' + network + ' @ ' + snapshotBlock +
                         ' deferred: empty oracle_publish set at the bundle\'s own snapshot block (fail closed)');
            return null;
        }
        let order = StateAnchorPublisher.hashOrder(
            this._bundleElectionKey({ network: network, snapshot_block: snapshotBlock }), eligible);
        return order;
    },

    // Does this hub stand down from a bundle it is not the unlocked publisher for?
    // Counts the stand-down by reason, since both are correct behaviour and silent.
    standsDownFromBundle(order, group, since, failoverOnly, skipped){
        // Someone else's bundle (or our backup rank has not unlocked yet).
        if(!this.mayPublish(order, since)){
            this._skippedNotOurElection += group.length;
            skipped.rows += group.length;
            return true;
        }
        // On a failover wake, publish only as a BACKUP. Rank 0 is always unlocked, so
        // without this the 15-minute wake would replace the leader's
        // ANCHOR_INTERVAL_MS cadence and it would anchor a fresh bundle every wake
        // instead of one per cycle (each superseding the last, all real DOGE).
        if(failoverOnly && this._isRankZero(order)){
            this._skippedLeaderOnWake += group.length;
            skipped.rows += group.length;
            return true;
        }
        return false;
    },

    async bundleHeldByIntent(group, chains, network, snapshotBlock){
        // The durable at-most-once marker, consulted BEFORE building a fresh PSBT and
        // before the attestation round solicits a peer quorum. The existence check
        // reads mined state only, so it cannot see a send this hub made and then
        // crashed on; the marker can. The marker table is UNCHANGED (D11): one row per
        // section, and the bundle holds if ANY section's marker holds, because any one
        // of them is evidence that DOGE may already have paid for this exact set.
        let held = null;
        for(let s of group){
            let intent = await this.getAnchorIntent(s);
            if(this.anchorIntentHolds(intent)){ held = { section: s, intent: intent }; break; }
        }
        if(held){
            let mined = null;
            try { mined = await this._findExistingBundle(group); }
            catch(_e){ mined = null; }        // undetermined indexer: hold, never spend
            if(!(mined && mined.exists)){
                logger.warn('StateAnchorPublisher: bundle ' + chains + '/' + network + ' @ ' + snapshotBlock +
                             ' held: a broadcast intent for ' + held.section.chain + ' recorded at ' +
                             String(held.intent.intent_at) + (held.intent.txid ? ' (txid ' + held.intent.txid + ')' : '') +
                             ' has no mined anchor yet; not rebuilding a second transaction until it ' +
                             'mines or the intent ages past ' + this.anchorIntentTtlMs + 'ms');
                return true;
            }
        }
        return false;
    },

    async collectBundleAttestation(group, me, chains, network, snapshotBlock){
        // ONE publisher-attestation round for the whole bundle (spec §2.5): a 2f+1
        // oracle_publish quorum over the XANCPUB canonical binding THIS hub as the
        // earner, carried in the v0 tail so the indexer DERIVES the reward.
        //
        // A DEGRADED ROUND DEFERS THE BUNDLE, rather than falling through to publish a
        // v0 carrying ATTEST_SIG_COUNT 0 on the reasoning that "the anchor always
        // lands and only the reward gains the quorum dependency". That reasoning is
        // false against the wire: the indexer's v0 BUNDLE parser requires
        // ATTEST_SIG_COUNT >= 1 (actions/anchor.js, the bundle publisher tail), so a
        // count-0 bundle is not a degraded anchor, it is an INVALID one. The fallback
        // therefore paid a real DOGE fee to put a permanently invalid row on chain and
        // still anchored nothing. Count 0 is legal only on the v1 ARCHIVE head, which
        // has its own `< 0` check and its own degraded path; the two are not
        // interchangeable and this site had borrowed the archive's rule.
        //
        // Deferring is safe: nothing is recorded and no transaction is built, so the
        // checkpoints stay pending and the next cycle republishes them. The failure
        // this protects against is transient by nature (peers restarting, a rolling
        // deploy, a split federation), and if it is NOT transient then publishing
        // would not have helped either, it would only have spent fees to say so.
        let bundle = { network: network, snapshot_block: snapshotBlock, sections: group };
        let attested   = false;
        let attestSigs = [];
        if(me && ar.isAnchorRewardActive(snapshotBlock, network)){
            let attest = await this.runPublisherAttestationRound(bundle, me);
            if(attest && attest.met && attest.sigs.length >= 1){
                attested   = true;
                attestSigs = attest.sigs;
            } else {
                this.unattestedDeferrals++;
                this.lastUnattestedDeferralAt = Date.now();
                logger.warn('StateAnchorPublisher: publisher-attestation quorum not reached for bundle ' +
                             chains + '/' + network + ' @ ' + snapshotBlock +
                             '; DEFERRING (a v0 bundle with ATTEST_SIG_COUNT 0 is rejected by the ' +
                             'indexer, so publishing would spend a fee to land an invalid anchor). ' +
                             'The checkpoints stay pending and the next cycle republishes them.');
                return null;
            }
        }
        return { attested: attested, attestSigs: attestSigs };
    },

    // The v0 payload this bundle will sign and send, or null when it does not fit.
    buildBundleWire(group, me, attestSigs, chains, network, snapshotBlock){
        let payload = this._buildV7Payload(group, me, attestSigs);
        // Last byte-budget gate, on the payload that will actually be signed and sent.
        // splitBundle sizes an ESTIMATED tail before the attestation round runs, and
        // after a split it estimates at the caller's network-wide oracle_publish set
        // rather than this group's own block, so the estimate can come in low.
        // Downstream the encoder answers an oversize action with a RangeError that
        // broadcastWithRetry burns its whole retry budget on, after the anchor
        // intents are already recorded and then withdrawn. Refuse here instead:
        // counted, loud, and ahead of the intent loop, with the rows left pending.
        let payloadBytes = Buffer.byteLength(payload, 'utf8');
        if(payloadBytes > ANCHOR_BUNDLE_MAX_BYTES){
            this._bundlesOversize++;
            logger.error('StateAnchorPublisher: v0 bundle ' + chains + '/' + network + ' @ ' + snapshotBlock +
                          ' builds to ' + payloadBytes + ' bytes with ' + attestSigs.length +
                          ' attesting signer(s), past the ' + ANCHOR_BUNDLE_MAX_BYTES + '-byte budget; ' +
                          'NOT broadcasting (nothing recorded, the rows stay pending for the next cycle)');
            return null;
        }
        return payload;
    },

    // One broadcast of a built bundle, through the retry ladder and its existence check.
    async sendBundle(signer, group, payload){
        let broadcaster = signer && signer.broadcastFn
            ? signer.broadcastFn : ((p) => this.defaultBroadcast(p, signer));
        for(let s of group) await this.recordAnchorIntent(s);
        // The existence check makes a lost ACK (this flush OR a previous one) adopt
        // the already-mined bundle instead of paying for a second one.
        let result;
        try {
            result = await this.broadcastWithRetry(broadcaster, payload, undefined,
                () => this._findExistingBundle(group));
        } catch(e){
            // A definitive failure means nothing reached the DOGE node (pre-send
            // build/sign errors, a spend-ceiling refusal, an RPC rejection), so
            // withdraw the intents rather than hold the sections for the TTL over a
            // send that never happened. An AMBIGUOUS send keeps its intents: that
            // case is exactly what the markers are for.
            if(!(e && e.anchorAmbiguousSend)) for(let s of group) await this.withdrawAnchorIntent(s);
            throw e;
        }
        return result;
    },

    async stampBundleSections(group, txid, anchored){
        for(let s of group) await this.markAnchorSent(s, txid);
        // First-writer-wins per section, exactly like the peer path in
        // applyBundleDone. In the documented failover race a hub may already have
        // stamped a peer's txid; without the IS NULL guard, completing our own
        // in-flight publish would overwrite it and leave the fleet holding divergent
        // anchor_txid bytes.
        for(let s of group){
            await this.db.updateStateCheckpoint(txid, s.chain, s.network, s.block_index, s.checkpoint_seq);
            anchored.push({ chain: String(s.chain), network: String(s.network),
                            block_index: Number(s.block_index), txid: txid });
        }
    },

    noteBundlePublished(group, order, result, network, snapshotBlock, chains, txid){
        // Name the rank this bundle was published at. A backup-rank publish is
        // otherwise byte-identical to a healthy leader publish in every observable
        // signal, so a dead rank-0 stays invisible while the ladder absorbs its work.
        // Computed from the SAME `order` mayPublish decided on, so the label can
        // never disagree with the decision that produced the spend.
        let myRank = this._myRank(order);
        // Gate the publish counters and the log verb on whether this call actually
        // spent: an adopted bundle was paid for by a prior broadcast of ours or by a
        // peer, and must never read as an anchor this hub bought.
        let adopted = !!(result && result.exists);
        this._lastAnchorRank = { network: network, snapshotBlock: snapshotBlock,
                                 chains: group.map(s => String(s.chain)), myRank: myRank,
                                 publisherCount: order.length, isLeader: myRank === 0,
                                 adopted: adopted, at: Date.now() };
        if(adopted){
            this._anchorsAdopted++;
        } else {
            if(myRank > 0) this._anchorsAsBackup++; else this._anchorsAsLeader++;
            this._anchorsPublished++;
            this._sectionsAnchored += group.length;
        }
        logger.info('StateAnchorPublisher: ' + (adopted ? 'adopted' : 'anchored') + ' bundle ' +
                    network + ' @ ' + snapshotBlock +
                    ' with ' + group.length + ' section(s) [' + chains + '] (txid ' + txid + ')' +
                    (!adopted && myRank > 0
                        ? ' [FAILOVER: published at backup rank ' + myRank + ' of ' + order.length +
                          '; the rank-0 publisher did not anchor this bundle]'
                        : ''));
    },

    recordBundleReward(group, me, attested, attestSigs, result, network, snapshotBlock, txid){
        // At/above the anchor-reward flag-day the reward is DERIVED on-chain from the
        // v0 publisher attestation (the hub push is retired), and the indexer credits
        // NOTHING for a bundle whose tail carries no attestation. Recording the reward
        // on the degraded fallback would strand it in hub-local + archive bookkeeping
        // only: no live indexer credits it, but a recovering node restores the
        // archived row, forking the COLLECT-spendable ledger live-vs-recovered.
        if(result && result.exists){
            // Adoption path: we did not pay for THIS bundle in this call (a prior
            // lost-ACK broadcast or a peer did). The on-chain payload, not the one we
            // just built, names the earner. Stamp + announce, but never push.
            logger.info('StateAnchorPublisher: adopted existing bundle for ' + network + ' @ ' +
                        snapshotBlock + '; reward push skipped');
        } else if(attested || !ar.isAnchorRewardActive(snapshotBlock, network)){
            // ONE anchor_bundle reward per bundle, round_reference = SNAPSHOT_BLOCK (D3, D21).
            this.recordReward('anchor_bundle', snapshotBlock, me, snapshotBlock, network);
            if(attested)
                this.deferRewardAttestation({
                    // The identity the mined-anchor proof re-SELECTs and re-verifies
                    // against: the FIRST section (chain-ascending), which carries the
                    // same txid as every other. The attestation ROW's chain is 'DOGE'
                    // (D21), resolved in recordRewardAttestation from the reward type.
                    chain: String(group[0].chain), network: network,
                    blockIndex: Number(group[0].block_index), checkpointSeq: Number(group[0].checkpoint_seq),
                    txid: txid, anchorVersion: 0,
                    rewardType: 'anchor_bundle', roundReference: snapshotBlock,
                    snapshotBlock: snapshotBlock,
                    publisher: String(me).toLowerCase(), attestSigs: attestSigs,
                    // We are the publisher, so we own the fan-out: once the drain proves
                    // this anchor mined, the confirmed row goes to every peer (XANCREWARD).
                    federate: true
                });
        } else {
            logger.info('StateAnchorPublisher: degraded bundle (no attestation) at/above the reward flag-day for ' +
                        network + ' @ ' + snapshotBlock + '; reward withheld (no live indexer derives it)');
        }
    },

    announceBundleDone(group, network, snapshotBlock, txid){
        // Tell peers so THEIR copies of every section stop being pending. Without
        // this, every hub whose failover rank unlocks would re-anchor a bundle
        // someone else already paid for.
        if(this.peerManager && this.identity){
            let announced = {
                network: network, snapshot_block: snapshotBlock, txid: txid,
                sections: group.map(s => ({ chain: String(s.chain), block_index: Number(s.block_index),
                                            checkpoint_seq: Number(s.checkpoint_seq) }))
            };
            announced.sig_pubkey = this.identity.getPubkeyHex().toLowerCase();
            announced.sig        = this.identity.sign(this.bundleDoneCanonical(announced, txid));
            this.peerManager.broadcast(XANC_BUNDLE_DONE, announced);
        }
    },

    // Publish ONE bundle: election, marker check, attestation round, build, broadcast,
    // per-section stamp, reward, announcement. Split out of the selector so the byte
    // budget can hand it several bundles for one network in one flush, each electing
    // independently. Never throws past a mid-flush deferral; every other failure is
    // logged and leaves the sections pending for the next flush.
    async publishBundle(signer, network, group, btcBlock, failoverOnly, anchored, skipped){
        let chains = group.map(s => String(s.chain)).join(',');
        try {
            let snapshotBlock = group.reduce((m, s) => Math.max(m, Number(s.snapshot_block)), 0);
            let order = await this.bundlePublisherOrder(network, snapshotBlock, chains);
            if(!order) return;
            // Bounded by CHECKPOINT_INTERVAL_BLOCKS * ANCHOR_CHECKPOINT_EVERY_N (6 at the
            // defaults), since the newest eligible snapshotBlock tracks the tip, so no rank
            // above 0 unlocks here unless that product reaches the tolerance. Intended: see
            // the ANCHOR_ELECTION_TOLERANCE_BLOCKS derivation above.
            let since = Number.isFinite(btcBlock) ? btcBlock - snapshotBlock : null;
            if(this.standsDownFromBundle(order, group, since, failoverOnly, skipped)) return;
            if(await this.bundleHeldByIntent(group, chains, network, snapshotBlock)) return;

            let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
            let attestation = await this.collectBundleAttestation(group, me, chains, network, snapshotBlock);
            if(!attestation) return;
            let payload = this.buildBundleWire(group, me, attestation.attestSigs, chains, network, snapshotBlock);
            if(payload === null) return;

            let result = await this.sendBundle(signer, group, payload);
            let txid = result && result.txid ? result.txid : null;
            if(txid && !(result && result.exists))
                this.notePendingConfirmation('anchor_bundle', txid, network + '/' + snapshotBlock);
            if(!txid){
                // A confirmed DOGE broadcast always returns a txid; a null txid is a
                // false/incomplete success (broadcastTx returned empty instead of
                // throwing). Treat it as a failed publish: leave the sections pending
                // (anchor_txid stays NULL) and do NOT stamp, reward, or announce.
                // Stamping NULL keeps the rows matching the selector so the bundle
                // re-anchors and re-burns DOGE every flush, and peers ignore a null-txid
                // announcement anyway (handleBundleDone early-returns on !d.txid).
                // The intents are NOT withdrawn: an empty return from broadcast_tx is not
                // proof nothing was sent, so the markers hold the sections for the TTL.
                logger.error('StateAnchorPublisher: v0 bundle broadcast returned no txid for ' + chains + '/' +
                              network + ' @ ' + snapshotBlock + '; treating as failed publish (rows stay pending)');
                return;
            }
            await this.stampBundleSections(group, txid, anchored);
            this.noteBundlePublished(group, order, result, network, snapshotBlock, chains, txid);
            this.recordBundleReward(group, me, attestation.attested, attestation.attestSigs, result, network, snapshotBlock, txid);
            this.announceBundleDone(group, network, snapshotBlock, txid);
        } catch(e){
            // A mid-flush deferral: an earlier anchor in this same pass spent the last
            // confirmed output. Not a failure of anything; the sections stay pending and
            // the next wake retries them as a normal flush.
            if(e && e.anchorNoConfirmedUtxo) this.noteNoConfirmedUtxo('the ' + network + ' bundle');
            else logger.error('StateAnchorPublisher: v0 bundle publish failed for ' + network + ': ' + (e && e.message));
        }
    }

};
