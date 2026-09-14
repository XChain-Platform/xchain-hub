/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Hub - Oracle Publisher: turning one closed window into signed, enqueued wires
 *
 * Leader election at the window anchor, the reconcile that makes the buffered copy
 * agree with price_snapshots, the coverage self-check, and the flag-day split. A
 * takeover runs everything here except the leader check, so it puts the same
 * canonical content on chain the leader would have.
 *
 ********************************************************************/

'use strict';

const swq = require('../../stake_weighted_quorum.js');
const pst = require('../../price_sig_tally_activation.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ----- Window assembly -----

    // Turn one closed window into zero or more signed, enqueued PRICE v0 wires.
    //
    // opts.takeover: this hub is NOT the window's leader and is stepping in after
    // the leader stayed silent (see attemptTakeover). Everything downstream of the
    // leader check is identical, deliberately: a takeover must put the same
    // canonical content on chain the leader would have, never a variant.
    async _assembleWindow(windowIndex, opts) {
        if (!this.enabled) return;
        let takeover = !!(opts && opts.takeover);
        if (!takeover && this._assembledWindows.has(windowIndex)) return;

        let first  = windowIndex * this.batchWindowRounds;
        let last   = first + this.batchWindowRounds - 1;
        // Before anything is read off the buffer, make it agree with price_snapshots.
        // Every co-signer re-derives this window from ITS price_snapshots,
        // so a buffered round that has drifted from this hub's own rows is a proposal
        // no honest peer can ever reproduce. Reconciling here is also what unsticks a
        // window that drifted before the buffer learned to track a re-finalization.
        await this.reconcileBufferedWindow(first, last);
        let rounds = this.bufferedRange(first, last);
        if (rounds.length === 0) { this.noteAssembled(windowIndex); return; }

        // The window's anchor is the LAST included round's own BTC anchor, matching the
        // batch anchor the wire header carries and the anchor every verifier resolves
        // the signature set against.
        let anchor = parseInt(rounds[rounds.length - 1].btcBlockHeight);

        // Who publishes this window, and whether this hub is it.
        let election = await this.electWindowPublisher(windowIndex, first, last, anchor, takeover);
        if (!election) return;

        // The self-check. A window published with a hole in it puts a signed, permanent
        // claim on chain that the missing round did not finalize.
        if (!(await this._windowCoverageComplete(first, last, rounds))) return;

        let signer = this.getBatchSigner();
        if (!signer) {
            logger.warn('OraclePublisher: no OracleBatchSigner available; window [' + first + ',' +
                last + '] stays unpublished');
            return;
        }

        let wires = await this.signWindowWires(signer, rounds, anchor, election.publisherCount);
        // Quorum was not reached. Nothing publishes for this window and it is
        // deliberately NOT memoized, so a later leader (or a later catch-up on
        // this hub) can re-propose the identical canonical content.
        if (wires === null) return;

        this.noteAssembled(windowIndex);
        if (wires.length === 0) return;
        await this.enqueueWindowWires(windowIndex, first, last, wires, election, takeover);
    },

    // Leader election over the SAME sorted oracle_publish snapshot the v0 rail
    // rotates on, keyed on the window rather than the round. Returns the rank state
    // when this hub is the one to publish, and null on every other outcome: an
    // unresolved set, a hub outside it, or a follower (which arms its takeover here).
    async electWindowPublisher(windowIndex, first, last, anchor, takeover) {
        let pubkeys = await this._getActiveOraclePublishPubkeys(anchor);
        if (pubkeys.length === 0) return null;   // fail closed, already logged by the resolver
        let me     = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
        let myRank = me ? pubkeys.indexOf(me) : -1;
        if (myRank < 0) {
            // Not an oracle_publish validator at this anchor. Recorded rather than
            // returned silently: this is the state a monitor has to be able to name, so
            // that a node which is not in the publisher set can be left alone instead of
            // being read as a publisher that has failed to publish.
            this._publisherRole = 'not_in_set';
            return null;
        }

        let leaderRank = windowIndex % pubkeys.length;
        // Membership is re-derived per window off the block-pinned snapshot, so a hub
        // added to or dropped from the set flips on the next window close and never
        // reports a stale role.
        this._publisherRole = 'in_set';
        this._lastRankState = {
            round:          last,
            myRank:         myRank,
            leaderRank:     leaderRank,
            isLeader:       leaderRank === myRank,
            publisherCount: pubkeys.length
        };
        if (leaderRank !== myRank && !takeover) {
            // Not our window. The buffered rounds are NOT dropped here: they are this
            // hub's evidence for the on-chain observation prune, and its material if a
            // later window has to re-propose this one.
            this._followerRounds++;
            this.noteAssembled(windowIndex);
            let pruned = await this.pruneObservedWindow(first, last);
            // Pruned means the leader's batch is already on chain, so there is
            // nothing to take over. Only an unobserved window gets a timer.
            if (pruned === 0) this.scheduleTakeover(windowIndex, myRank, leaderRank, pubkeys.length);
            return null;
        }
        if (takeover) this.takeoverAttempts++;
        else this._leaderRounds++;
        return { myRank: myRank, leaderRank: leaderRank, publisherCount: pubkeys.length };
    },

    // Pack the window into wires and run a signing round for each, splitting at every
    // armed flag day first. Null when a range failed to reach quorum, which withholds
    // the whole window rather than publishing the part that signed.
    async signWindowWires(signer, rounds, anchor, publisherCount) {
        let sigCountHint = await this._priceSetSizeHint(anchor, publisherCount);
        let wires = [];
        for (let segment of this.splitByFlagDay(rounds)) {
            let idx = 0;
            while (idx < segment.length) {
                let take  = Math.max(1, this._packSegment(segment.slice(idx), sigCountHint));
                let range = segment.slice(idx, idx + take);
                let wire  = await this.signAndSizeRange(signer, range);
                if (wire === null) return null;
                idx += wire.rounds.length;
                if (wire.unpublishable) continue;   // the ceiling case, already dead-lettered
                wires.push(wire);
            }
        }
        return wires;
    },

    // Put every signed wire on the durable queue and drain it. The enqueue is what
    // makes the window survive a crash between signing and broadcast.
    async enqueueWindowWires(windowIndex, first, last, wires, election, takeover) {
        if (takeover) {
            this.takeoverPublished++;
            logger.warn('OraclePublisher: TAKING OVER window [' + first + ',' + last + '] from its ' +
                'silent leader (rank ' + election.leaderRank + '); this hub is rank ' + election.myRank +
                ' and has seen no on-chain batch covering it');
        }
        if (wires.length > 1) {
            // Counted at assembly, not at broadcast: splitting is a decision this code
            // makes, and it stays worth seeing even if the wires then fail to send.
            this.batchSplitCount += wires.length - 1;
            logger.info('OraclePublisher: window [' + first + ',' + last + '] split into ' +
                wires.length + ' PRICE v0 wires to fit ' + this.constructor.PRICE_WIRE_MAX_BYTES + ' bytes');
        }

        for (let i = 0; i < wires.length; i++) {
            await this._enqueue({
                // Identity field stays the FIRST round, so _processQueue's Sets and the
                // retention sweep's queue-floor clamp keep working on a scalar (D10).
                round: wires[i].firstRound,
                batch: {
                    windowIndex: windowIndex,
                    firstRound:  wires[i].firstRound,
                    lastRound:   wires[i].lastRound,
                    anchor:      wires[i].anchor,
                    rounds:      wires[i].rounds.map(r => parseInt(r.round)),
                    sigCount:    wires[i].sigCount,
                    compressed:  wires[i].compressed,
                    wireIndex:   i,
                    wireCount:   wires.length
                },
                wire: wires[i].wire
            });
        }

        await this._processQueue();
        await this.pruneObservedWindow(first, last);
    },

    // Make the buffered copy of a window agree with price_snapshots, which is the ONE
    // store both sides of the signing round can see: the leader proposes from the
    // buffer and every co-signer re-derives from its own price_snapshots, so anything
    // the buffer holds that its own DB contradicts is a proposal that cannot reach
    // quorum however honest the leader is.
    //
    // Replaces drifted rounds and sheds already-landed ones. It never ADDS a round:
    // a finalized round with no buffered copy is _windowCoverageComplete's case, and
    // that path deliberately withholds the window rather than inventing content.
    //
    // Best effort by design. A DB error leaves the buffer as it was and assembly
    // proceeds exactly as before, because the signing round is the real gate: the
    // worst a stale proposal can do is fail to reach quorum, which is where this
    // window already was.
    async reconcileBufferedWindow(first, last) {
        if (!this.db) return 0;
        let rows;
        try {
            rows = await this.db.findPriceSnapshotsByRoundNumber(first, last, 'finalized');
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: cannot reconcile the buffered copy of window [' + first +
                ',' + last + '] against price_snapshots; proposing the buffer as-is: ', e && e.message));
            return 0;
        }

        let derived = this.roundsFromSnapshotRows(rows);

        let changed = 0;
        for (let [r, entry] of derived) {
            let buffered = this._buffer.get(r);
            if (!buffered) continue;
            if (entry.batchSourced) {
                this._buffer.delete(r);
                changed++;
                logger.warn('OraclePublisher: dropping buffered round ' + r + ' from window [' + first +
                    ',' + last + ']: it came from a batch that already landed on chain, so it needs ' +
                    'no re-publishing and its own BTC anchor is no longer recoverable here');
                continue;
            }
            // Fail CLOSED on a derived round that is not well formed. The buffer is the
            // only copy of a finalized round this hub holds once its rows age out, so a
            // half-read row (a NULL anchor, an unpriced pair) must leave it alone rather
            // than overwrite good content with a header the canonical builder would
            // turn into NaN.
            if (!this.wellFormedRound(entry)) {
                logger.warn('OraclePublisher: skipping reconcile of buffered round ' + r +
                    ': its price_snapshots rows did not read back as a complete round');
                continue;
            }
            if (this.sameBufferedRound(buffered, entry)) continue;
            entry.bufferedAt = Date.now();
            this._buffer.set(r, entry);
            changed++;
            logger.warn('OraclePublisher: buffered round ' + r + ' disagreed with this hub\'s own ' +
                'price_snapshots; refreshed it from the DB so the batch proposal is something ' +
                'peers can reproduce');
        }
        if (changed > 0) this.rewriteBufferFile(this.bufferedRange(-Infinity, Infinity));
        return changed;
    },

    // price_snapshots rows, one per pair, rebuilt into the canonical builder's round
    // shape keyed by round number.
    roundsFromSnapshotRows(rows) {
        let derived = new Map();
        for (let row of (rows || [])) {
            let r = parseInt(row.round_number);
            if (!Number.isFinite(r)) continue;
            let entry = derived.get(r);
            if (!entry) {
                entry = { round: r, timestamp: parseInt(row.block_timestamp),
                          btcBlockHeight: parseInt(row.reference_block), pairs: [],
                          // A batch-sourced row's reference_block is the LANDING chain's
                          // height, not this round's BTC anchor, so its content can no
                          // longer be rebuilt here. It is also, by definition, already on
                          // chain. See OracleBatchSigner.deriveWindow.
                          batchSourced: String(row.proof_head || '').indexOf('{"batch"') === 0 };
                let admit = this.admission.columnsAdmitBlocks(row);
                if (admit !== null) entry.admitBlocks = admit;
                derived.set(r, entry);
            }
            entry.pairs.push({ pair: String(row.coin_pair), price: String(row.price) });
        }
        return derived;
    },

    // Is a round read back from price_snapshots complete enough to sign? Every field
    // the canonical builder reads has to be a real value, or the bytes it produces
    // carry a NaN and no verifier on any chain accepts them.
    wellFormedRound(entry) {
        if (!entry || !Number.isFinite(entry.round)) return false;
        if (!Number.isFinite(entry.timestamp) || !Number.isFinite(entry.btcBlockHeight)) return false;
        if (!Array.isArray(entry.pairs) || entry.pairs.length === 0) return false;
        for (let p of entry.pairs) {
            if (!p.pair || p.pair === 'undefined') return false;
            if (p.price === undefined || p.price === null ||
                p.price === '' || p.price === 'null' || p.price === 'undefined') return false;
        }
        return true;
    },

    // Refuse the window if any round it should carry finalized locally but is not in
    // the buffer. Deliberately keyed on status = 'finalized' ONLY: the third enum value
    // 'disputed' marks a reorg-retracted row, and the signing round refuses to sign
    // disputed content, so treating a disputed round as "present but unbuffered" would
    // stall the window forever waiting for something no peer will ever co-sign.
    // No exemption for early rounds: batching is unconditional, so every round that
    // finalized locally was buffered and an unbuffered one is a real coverage hole.
    async _windowCoverageComplete(first, last, rounds) {
        if (!this.db) return true;
        let rows;
        try {
            rows = await this.db.findPriceSnapshotsByRoundNumberAndStatus(first, last, 'finalized');
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: cannot self-check window [' + first + ',' + last +
                '] against price_snapshots; withholding the batch (fail closed): ', e && e.message));
            return false;
        }
        let have    = new Set(rounds.map(r => parseInt(r.round)));
        let missing = [];
        for (let row of (rows || [])) {
            let r = parseInt(row.round_number);
            if (!Number.isFinite(r) || have.has(r)) continue;
            missing.push(r);
        }
        if (missing.length > 0) {
            logger.warn('OraclePublisher: window [' + first + ',' + last + '] has finalized round(s) ' +
                missing.join(', ') + ' with no buffered copy; withholding the batch rather than ' +
                'publishing a signed claim that they did not finalize');
            return false;
        }
        return true;
    },

    // A composite verdict of every armed oracle flag day at one BTC anchor. Rounds
    // whose keys differ cannot share a wire: a batch resolves those gates ONCE on the
    // batch anchor, so a straddling range would judge its earlier rounds under a rule
    // set they never finalized under. OracleBatchSigner.straddlesArmedOracleFlagDay is
    // the receiving-side twin of this, and it refuses SILENTLY, so a leader that skips
    // this split simply never reaches quorum and the window never publishes.
    //
    // The mirror admission activation is the third bit: each round carries its own map
    // era-keyed on its own anchor, and every round in one batch sits in one era, so the
    // window splits at that boundary exactly as it does at the other two.
    flagDayKey(btcBlockHeight) {
        let h = Number(btcBlockHeight);
        return (swq.isStakeWeightedQuorumActive(h, this.network) ? '1' : '0') +
               (pst.isPriceSigTallyVerifyFirstActive(h, this.network) ? '1' : '0') +
               (this.admission.isAdmissionEra(this.network, h) ? '1' : '0');
    },

    splitByFlagDay(rounds) {
        let segments = [];
        let current  = [];
        let key      = null;
        for (let r of rounds) {
            let k = this.flagDayKey(r.btcBlockHeight);
            if (key === null || k === key) {
                current.push(r);
            } else {
                segments.push(current);
                current = [r];
            }
            key = k;
        }
        if (current.length > 0) segments.push(current);
        return segments;
    },

};
