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

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

// Match a stubbed request by parsed hostname rather than a raw substring, so a
// lookalike host (e.g. api.coingecko.com.evil.example) cannot pass the check.
function hostIs(url, host) {
    try { return new URL(url).hostname === host; } catch (e) { return false; }
}

module.exports = {
    sinon,
    expect,
    proxyquire,
    hostIs
};
