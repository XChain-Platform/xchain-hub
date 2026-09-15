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
 * ANCHOR publisher - peer message intake and BUNDLE_DONE
 *
 * The p2p entry point, and the announcement that stops every peer's copy of a
 * section from being pending: verified, queued until the anchor is buried, then
 * applied.
 *
 ********************************************************************/

'use strict';

const canonicalForms = require('./canonical_forms.js');
const ValidatorIdentity = require('../../validators/identity.js');
const ar = require('../../anchor_reward_activation.js');
const { XANC_SIGN_REQ, XANC_SIGN, XANC_FINALIZED, XANC_BUNDLE_DONE, XANCPUB_SIGN_REQ, XANCPUB_SIGN, XANCARCHPUB_SIGN_REQ, XANCARCHPUB_SIGN, XANCREWARD } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XANC_SIGN_REQ:  this.handleSignReq(envelope).catch(e => logger.error('StateAnchorPublisher: SIGN_REQ error: ' + (e && e.message))); break;
            case XANC_SIGN:      this.handleSign(envelope).catch(e => logger.error('StateAnchorPublisher: SIGN error: ' + (e && e.message)));        break;
            case XANC_FINALIZED: this.handleFinalized(envelope).catch(e => logger.error('StateAnchorPublisher: FINALIZED error: ' + (e && e.message))); break;
            case XANC_BUNDLE_DONE:   this.handleBundleDone(envelope).catch(e => logger.error('StateAnchorPublisher: BUNDLE_DONE error: ' + (e && e.message)));     break;
            case XANCPUB_SIGN_REQ: this.handleAttestSignReq(envelope).catch(e => logger.error('StateAnchorPublisher: XANCPUB_SIGN_REQ error: ' + (e && e.message))); break;
            case XANCPUB_SIGN:     this.handleAttestSign(envelope).catch(e => logger.error('StateAnchorPublisher: XANCPUB_SIGN error: ' + (e && e.message)));         break;
            case XANCARCHPUB_SIGN_REQ: this.handleArchiveAttestSignReq(envelope).catch(e => logger.error('StateAnchorPublisher: XANCARCHPUB_SIGN_REQ error: ' + (e && e.message))); break;
            case XANCARCHPUB_SIGN:     this.handleArchiveAttestSign(envelope).catch(e => logger.error('StateAnchorPublisher: XANCARCHPUB_SIGN error: ' + (e && e.message)));         break;
            case XANCREWARD:           this.handleRewardAttestation(envelope).catch(e => logger.error('StateAnchorPublisher: XANCREWARD error: ' + (e && e.message)));               break;
        }
    },

    // Peer back-fill for a published ANCHOR v0 BUNDLE. Gated on membership + signature +
    // the sender being the rank-unlocked ELECTED bundle publisher for the referenced
    // snapshot block (see the election re-derivation below); a non-elected member can
    // no longer suppress the anchor or mirror itself the reward. The residual
    // (a Byzantine elected publisher announcing a fake txid) is closed by the per-section
    // on-chain verification below. First writer wins per section (IS NULL guard).
    async handleBundleDone(envelope){
        let d = envelope.data;
        if(!d || !d.txid || !Array.isArray(d.sections) || d.sections.length === 0) return;
        let network = String(d.network || '');
        if(!network) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this.getActiveOraclePublishPubkeys(null);
        // Fail CLOSED on an empty set: d.sig_pubkey is self-asserted and the sig is
        // verified against it, so membership in the oracle_publish set is the ONLY
        // thing tying this announcement to a federation member. An empty set (startup /
        // registry hiccup) must reject, not admit anyone -- otherwise a forged BUNDLE_DONE
        // stamps a bogus anchor_txid (suppressing the real anchor) and mirrors rewards.
        if(pubkeys.length === 0 || !pubkeys.includes(sender)) return;
        if(!ValidatorIdentity.verify(this.bundleDoneCanonical(d, String(d.txid)), String(d.sig || ''), sender)) return;

        // Our OWN copy of every announced section. Without all of them we cannot vet the
        // election: the bundle's snapshot_block is the MAX over the sections' own, read
        // from quorum-agreed rows, never from the wire.
        let rows = [];
        for(let sec of d.sections){
            let r = await this.db.getStateCheckpointByChain(String(sec.chain), network, Number(sec.block_index), Number(sec.checkpoint_seq));
            if(!r || r.length === 0) return;   // no local copy of a section: cannot vet the election
            rows.push(r[0]);
        }
        let snapshotBlock = rows.reduce((m, r) => Math.max(m, Number(r.snapshot_block)), 0);
        // The announced block is signed into the canonical, so a mismatch against what our
        // own rows produce is either a forge or a state divergence; either way, abstain.
        if(Number(d.snapshot_block) !== snapshotBlock) return;

        // Membership + signature alone let ANY oracle_publish member self-assert a bundle
        // it never published, stamping bogus anchor_txids (suppressing the real anchor
        // fleet-wide via the `anchor_txid IS NULL` selector) and mirroring itself the
        // reward. Re-run the SAME bundle election the real publisher ran and require the
        // sender to be rank-unlocked on the failover ladder. Rejecting a BUNDLE_DONE only
        // ever risks a redundant re-anchor (benign, the direction the code already
        // tolerates), never a fork, so using the receiver's own BTC-tip view is safe here.
        let electionSet = await this.getActiveOraclePublishPubkeys(snapshotBlock);
        if(electionSet.length === 0) return;             // fail closed: unresolved election set
        {
            let order = canonicalForms.hashOrder(
                this.bundleElectionKey({ network: network, snapshot_block: snapshotBlock }), electionSet);
            let myBtc = this.hub.resolveBtcLatestBlock ? await this.hub.resolveBtcLatestBlock() : null;
            let since = Number.isFinite(myBtc) ? myBtc - snapshotBlock : null;
            if(!this.rankUnlocked(order, sender, since)) return;   // sender is not a rank-unlocked elected publisher
        }
        // The election gate proves the SENDER is an elected publisher, NOT that it ever
        // published this anchor. Confirm the bundle is really on DOGE at >=
        // XCHAIN_CONFIRMATIONS_DOGE depth by asking OUR OWN DOGE indexer for the DECODED
        // row of EVERY section (payload hashes must byte-match our own copies), which is
        // also what proves the txid carries the whole announced set rather than one chain.
        let verdicts = [];
        for(let row of rows)
            verdicts.push(await this.verifyAnchorOnChain(row, { txid: String(d.txid), rejectVersions: [1, 2] }));
        if(this.bundleDoneUnproven(d, sender, network, snapshotBlock, verdicts)) return;
        await this.applyBundleDone(d, sender, rows);
    },

    // ABSTAIN (queue) when the indexer is unwired/unreachable or the anchor is
    // absent/shallow; REJECT on a decoded-invalid status or a hash mismatch.
    // True when the per-section verdicts stop the stamp here: a rejection is logged and
    // dropped, anything else short of 'verified' is queued for re-verification.
    bundleDoneUnproven(d, sender, network, snapshotBlock, verdicts){
        let rejected = verdicts.find(v => String(v).startsWith('rejected'));
        if(rejected){
            logger.warn('StateAnchorPublisher: BUNDLE_DONE for ' + network + ' @ ' + snapshotBlock +
                         ' REJECTED on-chain (' + rejected + '); skipping stamp + reward');
            return true;
        }
        let unproven = verdicts.find(v => v !== 'verified');
        if(unproven){
            // NOT a rejection: the publisher announces at 0 confirmations (the broadcast
            // returns a mempool txid), so 'absent' / 'shallow' is the NORMAL first answer
            // for a perfectly honest bundle, and 'unreachable' / 'no-indexer' /
            // 'no-txid-support' are local-wiring faults that clear on their own. Dropping
            // those is what left anchor_txid NULL fleet-wide. Queue for re-verification;
            // the queued entry is re-verified in full before it can stamp anything, so
            // queuing grants no authority.
            this.deferBundleDone(d, sender, unproven);
            return true;
        }
        return false;
    },

    // Queue an authenticated-but-not-yet-buried BUNDLE_DONE for re-verification. Keyed on
    // the announcement's identity INCLUDING the txid, so two competing txids for one
    // bundle are tracked separately and whichever actually confirms wins.
    deferBundleDone(d, sender, reason){
        let key = [String(d.network), Number(d.snapshot_block), String(d.txid)].join('|');
        if(this._deferredBundleDone.has(key)) return;
        // Bounded: drop the OLDEST entry rather than the new one (Map preserves
        // insertion order), so a flood cannot pin the queue on stale announcements.
        if(this._deferredBundleDone.size >= this.announceQueueMax){
            let oldest = this._deferredBundleDone.keys().next().value;
            this._deferredBundleDone.delete(oldest);
            logger.warn('StateAnchorPublisher: deferred BUNDLE_DONE queue full (' + this.announceQueueMax +
                         '); dropped the oldest entry ' + oldest);
        }
        this._deferredBundleDone.set(key, { d: d, sender: sender, at: Date.now() });
        logger.info('StateAnchorPublisher: BUNDLE_DONE for ' + d.network + ' @ ' + d.snapshot_block +
                    ' not yet buried (' + reason + '); queued for re-verification (' +
                    this._deferredBundleDone.size + ' pending)');
    },

    // Re-verify queued BUNDLE_DONE announcements and stamp the ones that have since been
    // buried. Runs on its own timer (announceRetryMs) and at the head of every flush.
    // The announcement's authenticity (membership, signature over the txid-bearing
    // canonical, publisher election at the bundle's immutable snapshot_block) was settled
    // at receipt and cannot change; what is re-checked is the ONE thing that does change,
    // namely whether the bundle is really on DOGE at depth.
    async drainDeferredBundleDone(){
        if(this._deferredBundleDone.size === 0) return;
        for(let [key, entry] of [...this._deferredBundleDone]){
            let d = entry.d;
            if(Date.now() - entry.at > this.announceRetryTtlMs){
                this._deferredBundleDone.delete(key);
                logger.warn('StateAnchorPublisher: deferred BUNDLE_DONE ' + key + ' expired after ' +
                             this.announceRetryTtlMs + 'ms without confirming; dropping so the failover ' +
                             'ladder can re-anchor if the bundle is still pending');
                continue;
            }
            try {
                let rows = [], allStamped = true;
                for(let sec of d.sections){
                    let r = await this.db.getStateCheckpointByChain(String(sec.chain), String(d.network), Number(sec.block_index), Number(sec.checkpoint_seq));
                    if(!r || r.length === 0){ rows = null; break; }   // section gone (reorg): let the TTL clear it
                    if(r[0].anchor_txid == null) allStamped = false;
                    rows.push(r[0]);
                }
                if(!rows) continue;
                if(allStamped){                    // our own publish or another announcement got there
                    this._deferredBundleDone.delete(key);
                    continue;
                }
                let verdicts = [];
                for(let row of rows)
                    verdicts.push(await this.verifyAnchorOnChain(row, { txid: String(d.txid), rejectVersions: [1, 2] }));
                let rejected = verdicts.find(v => String(v).startsWith('rejected'));
                if(rejected){
                    this._deferredBundleDone.delete(key);
                    logger.warn('StateAnchorPublisher: deferred BUNDLE_DONE ' + key + ' REJECTED on re-verification (' +
                                 rejected + '); dropped');
                    continue;
                }
                if(verdicts.every(v => v === 'verified')){
                    this._deferredBundleDone.delete(key);
                    await this.applyBundleDone(d, entry.sender, rows);
                    logger.info('StateAnchorPublisher: deferred BUNDLE_DONE ' + key + ' confirmed on DOGE; stamped');
                }
            } catch(e){
                logger.warn('StateAnchorPublisher: deferred BUNDLE_DONE ' + key + ' re-verification error: ' + (e && e.message));
            }
        }
    },

    // Apply a fully-verified BUNDLE_DONE: stamp anchor_txid on EVERY section and mirror
    // the reward. Shared by the immediate receipt path and the deferred re-verification
    // drain, so an announcement that arrives at 0 confirmations lands EXACTLY the same
    // rows as one that arrives already buried.
    async applyBundleDone(d, sender, rows){
        // Key each stamp on checkpoint_seq exactly as the publisher's own stamp does:
        // the section list is part of the signed bundleDoneCanonical, so binding seq here
        // stops one BUNDLE_DONE from marking a DIFFERENT (or multiple) seq row(s) at the
        // same height.
        for(let row of rows){
            await this.db.updateStateCheckpoint(String(d.txid), String(row.chain), String(d.network), Number(row.block_index), Number(row.checkpoint_seq));
        }
        // The bundle's own block, re-derived from OUR copies of the rows (quorum-agreed
        // state, identical on every hub), never from the wire.
        let snapshotBlock = rows.reduce((m, r) => Math.max(m, Number(r.snapshot_block)), 0);
        // At/above the anchor-reward flag-day the reward is indexer-DERIVED from the
        // on-chain v0 attestation. BUNDLE_DONE does not say (and its signed canonical does
        // not bind) whether the tail carried an attestation at all, so a mirror here could
        // mint a reward for a degraded ATTEST_SIG_COUNT 0 bundle that no live indexer
        // credits (a stranded archive-only credit; the live-vs-recovered fork). Skip the
        // mirror at/above the flag-day: the attested publisher records its own row and
        // live + recovering indexers both derive the credit from the on-chain attestation.
        // Below the flag-day the mirror remains the only transport.
        if(!ar.isAnchorRewardActive(snapshotBlock, String(d.network)))
            this.recordReward('anchor_bundle', snapshotBlock, sender, snapshotBlock, String(d.network));
    },

    // The string a BUNDLE_DONE sender signs. It binds the network, the bundle's block,
    // the announced txid AND the full section list (chain:block_index:checkpoint_seq,
    // chain-ascending), so a sender cannot re-point a signed announcement at a different
    // set of checkpoint rows than the one it published.
    bundleDoneCanonical(d, txid){
        let sections = (d.sections || []).slice().sort((a, b) => {
            let x = String(a.chain), y = String(b.chain);
            return x < y ? -1 : (x > y ? 1 : 0);
        }).map(s => [String(s.chain), String(s.block_index), String(s.checkpoint_seq)].join(':')).join(',');
        return 'XANCBUNDLEDONE|' + String(d.network) + '|' + String(d.snapshot_block) + '|' +
               sections + '|' + String(txid || '');
    }

};
