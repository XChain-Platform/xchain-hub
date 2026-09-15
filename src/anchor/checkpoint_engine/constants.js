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
 * State checkpoint engine - wire types and the chain set
 *
 * The three p2p message types of a checkpoint round and the chains a checkpoint may
 * name, shared by the class file and the parts that send or check them.
 *
 ********************************************************************/

'use strict';

const coins = require('../../coins');

const XCHK_SIGN_REQ  = 'XCHK_SIGN_REQ';
const XCHK_SIGN      = 'XCHK_SIGN';
const XCHK_FINALIZED = 'XCHK_FINALIZED';

const ALLOWED_CHAINS = [...coins.ALLOWED_COINS];

module.exports = { XCHK_SIGN_REQ, XCHK_SIGN, XCHK_FINALIZED, ALLOWED_CHAINS };
