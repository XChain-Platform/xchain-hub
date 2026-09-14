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
 * XChain Hub - ROLLCALL round: collect
 *
 * The one gossip type this engine adds, and the rule that decides which
 * signatures are kept: verified, in this hub's own snapshot, deduped by key.
 *
 * src/rollcall/round.js installs every method below on RollcallRound.prototype,
 * non-enumerable like the class's own methods, so callers and tests keep
 * reaching them as round.<method>().
 *
 ********************************************************************/

'use strict';

const ValidatorIdentity = require('../../validators/identity.js');

const { XROLLCALL_SIGN } = require('./wire.js');

// How many not-yet-opened epochs' gossip a hub holds. One is the normal case
// (peers a poll ahead); a few more covers a hub catching up after a stall.
const EARLY_SIG_EPOCHS = 4;

module.exports = {

    // ── collect ──────────────────────────────────────────────────────────────

    _handleMessage(env){
        if(!env || !env.data) return;
        switch(env.type){
            case XROLLCALL_SIGN: return this.onSign(env.data);
        }
    },

    onSign(d){
        let epoch = Number(d.epoch);
        let pk  = String(d.pubkey || '').toLowerCase();
        let sig = String(d.sig || '').toLowerCase();
        if(!Number.isFinite(epoch))      return;
        if(!/^[0-9a-f]{64}$/.test(pk))  return;
        if(!/^[0-9a-f]{128}$/.test(sig)) return;
        let state = this.rounds.get(epoch);
        if(!state){
            // Not opened here yet: hold it, unverified, for the round to judge.
            // Only epochs ahead of every open round are worth holding (an older
            // one can never open), and the holding area stays small.
            let newest = Math.max(-1, ...this.rounds.keys());
            if(epoch <= newest) return;
            let held = this._earlySigs.get(epoch) || new Map();
            if(!held.has(pk)) held.set(pk, sig);
            this._earlySigs.set(epoch, held);
            while(this._earlySigs.size > EARLY_SIG_EPOCHS)
                this._earlySigs.delete(Math.min(...this._earlySigs.keys()));
            return;
        }
        // Deduped by pubkey, and the key is only ever recorded once its signature
        // has verified: admitting a key on first sight would let a garbage pair
        // arriving before the real one suppress it, which reads downstream as an
        // absence and, over K epochs, evicts a validator that was demonstrably
        // present.
        if(state.sigs.has(pk)) return;
        // No floor and no quorum here (that is the chain's job, §3.4). The only
        // two questions are whether the signature is real and whether the signer
        // is in this hub's snapshot.
        if(!state.members.has(pk)) return;
        if(!ValidatorIdentity.verify(state.canonical, sig, pk)) return;
        state.sigs.set(pk, sig);
    }
};
