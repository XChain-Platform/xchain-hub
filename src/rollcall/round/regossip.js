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
 * XChain Hub - ROLLCALL round: push on connect
 *
 * A signature is broadcast once, when it is signed. A peer link that drops and
 * comes back while both hubs keep running misses every signature sent in the
 * gap, so on each new link this hub replays the signatures it holds for the
 * rounds still inside the accept window.
 *
 * src/rollcall/round.js installs the method below on RollcallRound.prototype,
 * non-enumerable like the class's own methods.
 *
 ********************************************************************/

'use strict';

const { XROLLCALL_SIGN } = require('./wire.js');

module.exports = {

    onPeerConnect(addr){
        let pm = this.peerManager;
        if(!pm || typeof pm.sendToPeer !== 'function') return;
        if(!Number.isFinite(this.lastTip)) return;
        for(let [epoch, state] of this.rounds){
            if(this.lastTip - epoch > this.acceptWindow) continue;
            for(let [pubkey, sig] of state.sigs){
                pm.sendToPeer(addr, XROLLCALL_SIGN, { epoch, pubkey, sig });
            }
        }
    }
};
