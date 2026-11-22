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
 * The checkpoint leader's replay-hold read across every configured chain.
 *
 ********************************************************************/

'use strict';

const { indexerReplayOpen } = require('./replay_hold.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

function noteUnreadable(unreadable, chain, value){
    const reason = String(value).slice(0, 200);
    unreadable.push(chain + ': ' + reason);
    logger.warn('StateCheckpointEngine: replay state unreadable for ' + chain + ' (' + reason +
                '); its round re-reads the indexer and fails closed on its own');
}

// Read each chain's replay state and return why the cadence holds, or null. An unreadable
// chain is logged and left to its own round, whose fresh read fails or declines per chain;
// with every chain unreadable the replay state is unknown everywhere, so the cadence holds.
async function leaderReplayHoldReason(engine){
    let checked = 0;
    const unreadable = [];
    for(const chain of engine.chains){
        if(!engine.indexers[chain] || !engine.indexers[chain].url) continue;
        checked++;
        try {
            const bh = await engine.indexerCall(chain, 'getblockhashes', {});
            if(!bh){
                noteUnreadable(unreadable, chain, 'empty getblockhashes result');
                continue;
            }
            if(bh.error){
                noteUnreadable(unreadable, chain, bh.error);
                continue;
            }
            if(indexerReplayOpen(bh.rules)) return 'indexer_replaying';
        } catch(e){
            noteUnreadable(unreadable, chain, (e && e.message) || e);
        }
    }
    if(checked > 0 && unreadable.length === checked)
        return 'indexer_replay_unreadable: ' + unreadable.join('; ');
    return null;
}

module.exports = { leaderReplayHoldReason };
