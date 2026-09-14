/*
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 *
 * The prune module now lives in src/validators/. This path stays as a re-export
 * until its remaining requirer under test/ is repointed.
 */
'use strict';

module.exports = require('../validators/capability_snapshot_prune.js');
