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
 * XChain Hub - strict boot read of a durable effector log
 *
 * An effector that spends on chain replays an append-only log at boot to learn
 * which spends it already made. Only a missing file is an empty log (the first
 * run). Any other failure (EIO, EMFILE, a mount that is not ready) means the log
 * was not read, and an unread log must never pass for an empty one: the caller
 * would start with no memory of its committed spends and could pay a second fee.
 *
 * The result is recorded on the owner under `flag`, so every spend gate can ask
 * one question, and a later read that succeeds clears it.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability');
const logger = getLogger();

/**
 * @param {object} fs       the caller's fs module
 * @param {object} owner    the engine that holds the flag
 * @param {string} flag     property on `owner` set while the log is unread
 * @param {string} filePath the log
 * @param {string} label    engine name for the log lines
 * @returns {string|null}   the text, or null when the file is absent or unread
 */
function readDurableLog(fs, owner, flag, filePath, label){
    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); }
    catch(e){
        if(e && e.code === 'ENOENT'){ owner[flag] = false; return null; }
        if(!owner[flag]){
            logger.error(label + ': cannot read ' + filePath + ' (' + ((e && (e.code || e.message)) || e) +
                          '); nothing is spent until it reads');
        }
        owner[flag] = true;
        return null;
    }
    if(owner[flag]) logger.warn(label + ': ' + filePath + ' reads again; spending may resume');
    owner[flag] = false;
    return text;
}

module.exports = { readDurableLog };
