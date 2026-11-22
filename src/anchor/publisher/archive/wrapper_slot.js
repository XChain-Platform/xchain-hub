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
 * ANCHOR publisher - durable archive wrapper signing slots
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { getLogger } = require('../../../observability');
const logger = getLogger();

const SLOT_MEMORY = 4096;
const SLOT_KEY_PREFIX = 'xancwrap_slot:';

function sha256Hex(text){
    return crypto.createHash('sha256').update(String(text)).digest('hex');
}

module.exports = {

    // Archive wrapper canonicals share the indexer's EQUIV slot rule with
    // XANCPUB, but use independent memory and durable keys.
    async claimArchiveWrapperSlot(canonical){
        let slot = this.attestSlotOf(canonical);
        if(slot === null) return true;
        let digest = sha256Hex(canonical);
        let slots = this._archiveWrapperSlots || (this._archiveWrapperSlots = new Map());
        let held = slots.get(slot);
        if(held && held.digest !== digest) return this.refuseSecondArchiveWrapper(slot, held);
        if(held) return (await held.stored) === digest;
        let entry = { digest, stored: null, refused: false };
        entry.stored = this.persistArchiveWrapperSlot(slot, digest);
        slots.set(slot, entry);
        while(slots.size > SLOT_MEMORY) slots.delete(slots.keys().next().value);
        let stored = await entry.stored;
        if(stored === digest) return true;
        if(slots.get(slot) === entry) slots.delete(slot);
        if(stored === null) return false;
        let prior = { digest: stored, stored: Promise.resolve(stored), refused: false };
        slots.set(slot, prior);
        return this.refuseSecondArchiveWrapper(slot, prior);
    },

    archiveWrapperSlotHeld(canonical){
        let slot = this.attestSlotOf(canonical);
        if(slot === null) return true;
        let held = this._archiveWrapperSlots && this._archiveWrapperSlots.get(slot);
        return !!held && held.digest === sha256Hex(canonical);
    },

    async persistArchiveWrapperSlot(slot, digest){
        let key = SLOT_KEY_PREFIX + sha256Hex(slot).slice(0, 48);
        try {
            await this.db.createConsensusStateIfAbsent(key, digest);
            let rows = await this.db.findConsensusState(key);
            let stored = rows && rows.length ? String(rows[0].value || '') : '';
            if(!stored) throw new Error('consensus_state row ' + key + ' absent after insert');
            return stored;
        } catch(e){
            logger.error('StateAnchorPublisher: cannot record archive wrapper slot ' + slot +
                         ' (' + (e && e.message) + '); not signing it until the record succeeds');
            return null;
        }
    },

    refuseSecondArchiveWrapper(slot, held){
        this._archiveWrapperSlotRefusals = (this._archiveWrapperSlotRefusals || 0) + 1;
        if(!held.refused){
            held.refused = true;
            logger.error('StateAnchorPublisher: SECOND ARCHIVE WRAPPER PAYLOAD in slot ' + slot +
                         ': this hub already signed different content there and refuses this one. ' +
                         'Two signatures under one archive wrapper key are slashable.');
        }
        return false;
    }
};
