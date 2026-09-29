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
 * XChain Hub - Hub DB Signed Deletion Replay
 *
 * Retains a short, bounded window of fenced signed deletions and sends
 * them to mirror subscribers immediately after their ready frame.
 *
 ********************************************************************/

const MAX_DELETIONS = 64;
const MAX_AGE_MS = 60 * 60 * 1000;

class HubDbDeletionReplay {

    pruneDeletionReplay(nowMs) {
        if (!this._deletionReplay) this._deletionReplay = [];
        const oldest = nowMs - MAX_AGE_MS;
        this._deletionReplay = this._deletionReplay.filter(entry => entry.recordedAt >= oldest);
    }

    recordDeletionForReplay(event, message) {
        if (!event || event.retraction_generation === undefined || event.retraction_generation === null) return;
        if (event.snapshot_block === undefined || event.snapshot_block === null) return;
        if (!Array.isArray(event.retraction_signatures) || event.retraction_signatures.length === 0) return;

        const nowMs = Date.now();
        this.pruneDeletionReplay(nowMs);
        this._deletionReplay.push({ recordedAt: nowMs, message });
        if (this._deletionReplay.length > MAX_DELETIONS)
            this._deletionReplay.splice(0, this._deletionReplay.length - MAX_DELETIONS);
    }

    replayDeletions(ws) {
        this.pruneDeletionReplay(Date.now());
        for (const entry of this._deletionReplay) this.send(ws, entry.message);
    }
}

module.exports = HubDbDeletionReplay;
