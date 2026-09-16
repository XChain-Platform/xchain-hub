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
 * XChain Hub - Indexer HTTP Client
 *
 * The axios instance a hub method posts to an indexer with, resolved per hub
 * class so a stub the class was loaded with reaches the part files too.
 *
 ********************************************************************/

const axios = require('axios');

// Suites load XChainHub.js through proxyquire with an axios stub, and that stub
// reaches the part files only through the class's modules static. A method
// borrowed onto a plain object has no hub class behind it and gets the real
// module, which is what the class file's own require gives it.
function axiosFor(hub) {
    const modules = hub && hub.constructor && hub.constructor.modules;
    return (modules && modules.axios) || axios;
}

module.exports = { axiosFor };
