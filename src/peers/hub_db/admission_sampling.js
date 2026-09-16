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
 * XChain Hub - Hub DB Admission Sampling
 *
 * Where the height watermark gets its readings: the one accessor every
 * carrier stamps, the hub handle the sample pass reads tips from, and the
 * pass itself (durable floor, tip observations, the anchor queue-drain cap).
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

class HubDbAdmissionSampling {

    // The `heights` object every carrier stamps. One accessor so the heartbeat, the ready
    // frame and the ten REST snapshot pages cannot drift into publishing three different
    // shapes, which a consumer on any one of the three could not tell from a real claim.
    admissionHeights(nowMs) {
        return this.admissionWatermark ? this.admissionWatermark.heights(nowMs) : {};
    }

    // Attach the hub the watermark is sampled from, and start sampling.
    //
    // The broadcaster is constructed with (p2pConfig, db) and has no hub handle, so the
    // two things the watermark needs live behind this call: the per-chain admission tip
    // (XChainHub.resolveAdmissionTips, the DECODER tip rather than the committed tip that
    // a barriered indexer freezes) and the anchor rail's deferred reward-attest queue.
    attachAdmissionSource(hub) {
        if (!hub) return false;
        this._admissionHub = hub;
        if (this._admissionTimer) return true;
        let tick = () => {
            this.sampleAdmission().catch((e) =>
                logger.error(nodeUtil.format('HubDbBroadcaster: admission watermark sample failed:', e && e.message ? e.message : e)));
        };
        this._admissionTimer = setInterval(tick, this.admissionSampleMs);
        if (this._admissionTimer.unref) this._admissionTimer.unref();
        tick();
        return true;
    }

    // One sampling pass: the durable floor once, then this hub's own tip observations, the
    // anchor queue-drain cap, and the floor written back.
    //
    // Every step degrades to "no entry" rather than to a guess, because a watermark entry
    // this hub cannot justify is a completeness claim over rows it may not hold.
    async sampleAdmission() {
        let hub = this._admissionHub;
        let w   = this.admissionWatermark;
        if (!hub || !w) return;

        if (!this._admissionFloorLoaded) {
            this._admissionFloorLoaded = true;
            if (this.db && typeof this.db.getAdmissionWatermarkFloor === 'function') {
                try { w.setFloor(await this.db.getAdmissionWatermarkFloor(hub.network)); }
                catch (e) {
                    logger.warn(nodeUtil.format('HubDbBroadcaster: could not read the admission watermark floor; this hub '
                        + 'publishes no heights until its own tip observations age past one round window:',
                        e && e.message ? e.message : e));
                }
            }
        }

        if (typeof hub.resolveAdmissionTips === 'function') {
            let tips = await hub.resolveAdmissionTips(w.federationChains);
            let at   = Date.now();
            for (let c of Object.keys(tips || {})) w.observeTip(c, tips[c], at);
        }

        // The anchor-attest queue-drain rule. A queued entry at snapshot S means
        // the row for S is not written yet, so the entry may not pass S - 1. An empty queue
        // clears the cap and the generic bounded advance applies.
        let pub   = hub.stateAnchorPublisher;
        let floor = (pub && typeof pub.deferredRewardAttestFloor === 'function')
            ? pub.deferredRewardAttestFloor() : null;
        w.setTableCap('anchor_reward_attestations', 'BTC', (floor === null) ? null : floor - 1);

        if (this.db && typeof this.db.saveAdmissionWatermarkFloor === 'function') {
            try { await this.db.saveAdmissionWatermarkFloor(hub.network, w.heights()); }
            catch (e) {
                logger.warn(nodeUtil.format('HubDbBroadcaster: could not persist the admission watermark floor; a restart '
                    + 'will republish nothing for one round window:', e && e.message ? e.message : e));
            }
        }
    }
}

module.exports = HubDbAdmissionSampling;
