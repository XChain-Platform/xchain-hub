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
 * XChain Hub - hand back the input claims of a build we will not broadcast
 *
 * `create_tx` is not read-only. A SUCCESSFUL build reserves every input it
 * selected and returns the receipt as `result.reservation`; the encoder's
 * selection then skips those outpoints until its own 5-minute TTL expires. That
 * is correct for a caller that is about to sign and send, and wrong for every
 * caller that walks away.
 *
 * The hub walks away often. `assertSingleTxEncoding` refuses phase 1 of a
 * two-transaction encoding AFTER the build (it has to: the verdict is read off
 * the encoder's answer, never off the requested encoding), the wallet hook can
 * throw, and the hex it returns can be rejected. Each of those abandons a build
 * whose claims nothing releases, so a funded publishing address goes unavailable
 * to every other publisher and to wallet operations for five minutes, and a
 * retry loop reserves a fresh set of outputs each pass without ever broadcasting.
 *
 * BEFORE BROADCAST ONLY. Once a transaction may have reached the node, holding
 * the inputs is the protective behaviour: releasing them there invites a second
 * build that double-spends a send that actually landed. Callers put the release
 * on failure paths that provably precede `broadcast_tx`, never on an ambiguous
 * send.
 *
 ********************************************************************/

'use strict';

// Release the input claims a successful create_tx minted, when the caller has
// decided not to broadcast it. Best effort by contract: the caller is already on
// a failure path and the real error is what must surface, so a release that
// itself fails is logged and swallowed (the encoder's TTL is the backstop).
// Returns true when a ticket was actually handed back.
//
// `who` names the calling publish rail in the log, so an operator reading a
// failed round can tell which pipeline abandoned the build.
async function abandonBuild(encoder, psbtResult, who){
    let id = psbtResult && psbtResult.reservation && psbtResult.reservation.id;
    if(!id) return false;                                   // nothing was reserved
    if(!encoder || typeof encoder.releaseInputs !== 'function') return false;
    try {
        await encoder.releaseInputs(String(id));
        return true;
    } catch(e){
        console.warn((who || 'publisher') + ': could not release the abandoned build\'s input ' +
                     'reservation (' + ((e && e.message) || e) + '); the encoder frees it on its own ' +
                     'TTL instead');
        return false;
    }
}

module.exports = { abandonBuild };
