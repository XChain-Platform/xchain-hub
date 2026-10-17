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
 * Snapshot checkpoint wire types
 *
 ********************************************************************/

'use strict';

const XSNP_SIGN_REQ  = 'XSNP_SIGN_REQ';
const XSNP_SIGN      = 'XSNP_SIGN';
const XSNP_FINALIZED = 'XSNP_FINALIZED';

module.exports = { XSNP_SIGN_REQ, XSNP_SIGN, XSNP_FINALIZED };
