'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The in-memory store behind the cadence stall meter suite, kept beside it so that
// suite stays under the file-length limit.

const { DB_METHODS } = require('./mockHub.js');

// Minimal in-memory state_checkpoints + capability_snapshots store (same shape
// as the cadence-latch suite; unknown SELECTs fall through to []).
function memDb() {
    let checkpoints = [], snapshots = [];
    return { ...DB_METHODS,
        checkpoints, snapshots,
        async doQuery(sql, params) {
            if (sql.startsWith('SELECT MAX(checkpoint_seq)')) {
                let max = null;
                for (let r of checkpoints) if (r.chain === params[0] && r.network === params[1] && (max == null || r.checkpoint_seq > max)) max = r.checkpoint_seq;
                return [{ max_seq: max }];
            }
            if (sql.startsWith('SELECT MAX(snapshot_block)')) {
                let max = null;
                for (let r of checkpoints) if (max == null || r.snapshot_block > max) max = r.snapshot_block;
                return [{ last_block: max }];
            }
            if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) {
                let [chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash,
                     checkpoint_seq, snapshot_block] = params;
                if (!checkpoints.some(r => r.chain === chain && r.network === network && r.checkpoint_seq === checkpoint_seq))
                    checkpoints.push({ chain, network, block_index, block_hash, ledger_hash, actions_hash,
                                       contract_hash, checkpoint_seq, snapshot_block });
                return [];
            }
            if (sql.startsWith('SELECT * FROM state_checkpoints'))
                return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] &&
                                               r.block_index === params[2] && r.checkpoint_seq === params[3]).slice(0, 1);
            if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                snapshots.push({ snapshot_block: params[0], capability: params[1], signing_pubkey: params[2] });
                return [];
            }
            return [];
        }
    };
}

module.exports = { memDb };
