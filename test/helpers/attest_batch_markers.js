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

// In-memory attest_published_batches for the suites that drive the batch marker
// through a retraction and the sweep that follows it.

// Answers one marker statement against `markers`, or undefined when the statement
// is not a marker statement, so a caller can fall through to its own tables. Each
// status predicate is honoured, because the safety of every marker move is that it
// can only change a row in the status it names.
function queryMarkers(markers, sql, args){
    if(/^INSERT INTO attest_published_batches/i.test(sql)){
        let cols = sql.substring(sql.indexOf('(') + 1, sql.indexOf(')'))
            .split(',').map(s => s.trim());
        let row = {};
        cols.forEach((c, i) => { row[c] = args[i]; });
        let found = markers.find(r => r.network === row.network &&
            Number(r.window_start) === Number(row.window_start));
        if(found) Object.assign(found, row);
        else markers.push(row);
        return { affectedRows: found ? 0 : 1 };
    }
    if(/^DELETE FROM attest_published_batches/i.test(sql)){
        let [network, start, end, status] = args;
        let idx = markers.findIndex(r => r.network === network &&
            Number(r.window_start) === Number(start) &&
            Number(r.window_end) === Number(end) && r.status === status);
        if(idx < 0) return { affectedRows: 0 };
        markers.splice(idx, 1);
        return { affectedRows: 1 };
    }
    // The reopen: a status move guarded on the exact window end and the old status.
    if(/^UPDATE attest_published_batches SET status = \? WHERE network = \? AND window_start = \? AND window_end = \? AND status = \?$/i.test(sql)){
        let [to, network, start, end, from] = args;
        let found = markers.find(r => r.network === network && Number(r.window_start) === Number(start) &&
            Number(r.window_end) === Number(end) && r.status === from);
        if(!found) return { affectedRows: 0 };
        found.status = to;
        return { affectedRows: 1 };
    }
    if(/^SELECT window_start FROM attest_published_batches WHERE network = \? AND status = \?$/i.test(sql)){
        return markers.filter(r => r.network === args[0] && r.status === args[1])
            .map(r => ({ window_start: r.window_start }));
    }
    if(/FROM attest_published_batches WHERE network = \? AND window_start = \?/i.test(sql)){
        let found = markers.find(r => r.network === args[0] &&
            Number(r.window_start) === Number(args[1]));
        return found ? [Object.assign({}, found)] : [];
    }
    return undefined;
}

// The sweep's read of every window in one status, the reopened ones included, as a
// method a hand-built DB fake spreads in beside its own.
function statusReads(markers){
    return {
        async findAttestPublishedBatchesByNetworkAndStatus(network, status){
            return markers.filter(m => m.network === network && m.status === status)
                .map(m => ({ window_start: m.window_start }));
        }
    };
}

module.exports = { queryMarkers, statusReads };
