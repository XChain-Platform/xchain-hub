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

const { expect } = require('chai');
const prune = require('../../src/lib/capability_snapshot_prune.js');

// Minimal stand-in for src/db.js: it records the SQL it is handed and serves
// rows out of an in-memory capability_snapshots table, so the tests exercise
// the real query text and the real batching loop without a MariaDB instance.
class FakeDb {
    constructor(rows){
        this.rows    = rows.map(r => Object.assign({}, r));
        this.queries = [];
    }

    _match(sql, args){
        // Recover the bound values in the same order buildWhere pushes them.
        let i    = 2;
        let from = args[0], to = args[1];
        let cap    = sql.includes('capability = ?') ? args[i++] : null;
        let before = sql.includes('created_at < ?') ? args[i++] : null;
        return this.rows.filter(r =>
            r.snapshot_block >= from && r.snapshot_block <= to
            && (cap === null || r.capability === cap)
            && (before === null || Date.parse(r.created_at.replace(' ', 'T')) < Date.parse(before.replace(' ', 'T'))));
    }

    async doQuery(sql, args){
        this.queries.push({ sql, args: args.slice() });

        if(sql.startsWith('DELETE')){
            let limit   = args[args.length - 1];
            let victims = this._match(sql, args).slice(0, limit);
            this.rows   = this.rows.filter(r => !victims.includes(r));
            return { affectedRows: victims.length };
        }

        let matched = this._match(sql, args);

        if(sql.includes('COUNT(DISTINCT snapshot_block) AS block_count FROM')
           && !sql.includes('GROUP BY')){
            return [{ block_count: new Set(matched.map(r => r.snapshot_block)).size }];
        }

        let agg = (rs) => ({
            rows_count:  rs.length,
            min_block:   Math.min(...rs.map(r => r.snapshot_block)),
            max_block:   Math.max(...rs.map(r => r.snapshot_block)),
            block_count: new Set(rs.map(r => r.snapshot_block)).size,
            min_created: rs.map(r => r.created_at).sort()[0],
            max_created: rs.map(r => r.created_at).sort().slice(-1)[0]
        });

        if(sql.includes('GROUP BY snapshot_block, capability')){
            let limit = args[args.length - 1];
            let keys  = new Map();
            for(let r of matched){
                let k = r.snapshot_block + '|' + r.capability;
                if(!keys.has(k)) keys.set(k, []);
                keys.get(k).push(r);
            }
            return [...keys.values()]
                .sort((a, b) => a[0].snapshot_block - b[0].snapshot_block)
                .slice(0, limit)
                .map(rs => Object.assign({ snapshot_block: rs[0].snapshot_block, capability: rs[0].capability }, agg(rs)));
        }

        // Grouped-by-capability summary.
        let byCap = new Map();
        for(let r of matched){
            if(!byCap.has(r.capability)) byCap.set(r.capability, []);
            byCap.get(r.capability).push(r);
        }
        return [...byCap.keys()].sort().map(cap =>
            Object.assign({ capability: cap }, agg(byCap.get(cap))));
    }

    async close(){}
}

// A dead chain incarnation left cross_chain snapshots across
// blocks 131-487, and the live chain has since written its own rows down at the
// low heights it has actually reached.
const DEAD_WRITE = '2026-06-01 10:00:00';   // written under the dead incarnation
const LIVE_WRITE = '2026-07-20 10:00:00';   // written after the chain was reset

function deadChainFixture(){
    let rows = [];
    for(let b = 131; b <= 487; b += 1){
        rows.push({ snapshot_block: b, capability: 'cross_chain', signing_pubkey: 'dead' + b, source: 'sX', created_at: DEAD_WRITE });
    }
    // Live-chain rows below the dead range, which must survive.
    rows.push({ snapshot_block: 12,  capability: 'cross_chain',   signing_pubkey: 'live12',  source: 'sA', created_at: LIVE_WRITE });
    rows.push({ snapshot_block: 130, capability: 'cross_chain',   signing_pubkey: 'live130', source: 'sA', created_at: LIVE_WRITE });
    // A different capability inside the dead range, to prove --capability scoping.
    rows.push({ snapshot_block: 200, capability: 'oracle_publish', signing_pubkey: 'op200',  source: 'sB', created_at: DEAD_WRITE });
    return rows;
}

// The venue as it looks once the reset chain has mined back up through the dead
// range: the same heights now carry BOTH a dead row and a fresh one.
function remimedFixture(){
    let rows = deadChainFixture();
    for(let b = 140; b <= 160; b += 1){
        rows.push({ snapshot_block: b, capability: 'cross_chain', signing_pubkey: 'live' + b, source: 'sA', created_at: LIVE_WRITE });
    }
    return rows;
}

describe('lib/capability_snapshot_prune (stale snapshot prune)', () => {

    describe('normalizeRange', () => {
        it('requires fromBlock so a typo cannot become a full-table wipe', () => {
            expect(() => prune.normalizeRange({})).to.throw(/fromBlock is required/);
            expect(() => prune.normalizeRange({ toBlock: 487 })).to.throw(/fromBlock is required/);
            expect(() => prune.normalizeRange({ fromBlock: -1 })).to.throw(/fromBlock is required/);
            expect(() => prune.normalizeRange({ fromBlock: 1.5 })).to.throw(/fromBlock is required/);
            expect(() => prune.normalizeRange({ fromBlock: 'abc' })).to.throw(/fromBlock is required/);
        });

        it('accepts CLI string numbers and defaults toBlock to open-ended', () => {
            let r = prune.normalizeRange({ fromBlock: '131' });
            expect(r.fromBlock).to.equal(131);
            expect(r.toBlock).to.equal(prune.MAX_BLOCK);
            expect(r.capability).to.equal(null);
        });

        it('rejects an inverted range', () => {
            expect(() => prune.normalizeRange({ fromBlock: 487, toBlock: 131 })).to.throw(/must be >= fromBlock/);
        });

        it('allows a single-block range', () => {
            let r = prune.normalizeRange({ fromBlock: 145, toBlock: 145 });
            expect(r).to.deep.equal({ fromBlock: 145, toBlock: 145, capability: null, createdBefore: null });
        });

        it('rejects a capability that is not a bare lowercase name', () => {
            for(let bad of ['cross chain', 'cross_chain; DROP TABLE x', 'CrossChain', '1cross', 'x'.repeat(21), 5]){
                expect(() => prune.normalizeRange({ fromBlock: 1, capability: bad }), String(bad)).to.throw(/Invalid capability/);
            }
        });

        it('accepts the real capability names', () => {
            for(let cap of ['price', 'cross_chain', 'oracle_publish', 'attestation', 'full_node']){
                expect(prune.normalizeRange({ fromBlock: 1, capability: cap }).capability).to.equal(cap);
            }
        });
    });

    describe('buildWhere', () => {
        it('binds every value rather than interpolating it', () => {
            let w = prune.buildWhere({ fromBlock: 131, toBlock: 487, capability: 'cross_chain' });
            expect(w.clause).to.equal('snapshot_block BETWEEN ? AND ? AND capability = ?');
            expect(w.args).to.deep.equal([131, 487, 'cross_chain']);
            expect(w.clause).to.not.include('cross_chain');
        });

        it('omits the capability predicate when unscoped', () => {
            let w = prune.buildWhere({ fromBlock: 0, toBlock: 9, capability: null });
            expect(w.clause).to.equal('snapshot_block BETWEEN ? AND ?');
            expect(w.args).to.deep.equal([0, 9]);
        });
    });

    describe('summarizeStale', () => {
        it('reports the dead range without touching any row', async () => {
            let db = new FakeDb(deadChainFixture());
            let before = db.rows.length;
            let s = await prune.summarizeStale(db, { fromBlock: 131, toBlock: 487 });

            expect(s.total).to.equal(358);            // 357 cross_chain + 1 oracle_publish
            expect(s.blocks).to.equal(357);           // block 200 is shared by both capabilities
            expect(s.minBlock).to.equal(131);
            expect(s.maxBlock).to.equal(487);
            expect(s.byCapability.map(c => c.capability)).to.deep.equal(['cross_chain', 'oracle_publish']);
            expect(db.rows.length).to.equal(before);
            expect(db.queries.every(q => q.sql.startsWith('SELECT'))).to.equal(true);
        });

        it('scopes to one capability when asked', async () => {
            let db = new FakeDb(deadChainFixture());
            let s = await prune.summarizeStale(db, { fromBlock: 131, toBlock: 487, capability: 'cross_chain' });
            expect(s.total).to.equal(357);
            expect(s.byCapability).to.have.lengthOf(1);
        });

        it('returns zeroes and nulls on an empty range', async () => {
            let db = new FakeDb(deadChainFixture());
            let s = await prune.summarizeStale(db, { fromBlock: 1000, toBlock: 2000 });
            expect(s.total).to.equal(0);
            expect(s.blocks).to.equal(0);
            expect(s.minBlock).to.equal(null);
            expect(s.maxBlock).to.equal(null);
        });
    });

    describe('createdBefore fence', () => {
        it('rejects anything that is not a DATE or DATETIME literal', () => {
            for(let bad of ['2026/07/01', 'yesterday', "2026-07-01' OR 1=1", '2026-07-01T00:00:00', 20260701]){
                expect(() => prune.normalizeRange({ fromBlock: 1, createdBefore: bad }), String(bad)).to.throw(/Invalid createdBefore/);
            }
        });

        it('rejects a well-formed but impossible date', () => {
            expect(() => prune.normalizeRange({ fromBlock: 1, createdBefore: '2026-13-40' })).to.throw(/not a real date/);
        });

        it('binds the cutoff rather than interpolating it', () => {
            let w = prune.buildWhere(prune.normalizeRange({ fromBlock: 131, toBlock: 487, createdBefore: '2026-06-18' }));
            expect(w.clause).to.equal('snapshot_block BETWEEN ? AND ? AND created_at < ?');
            expect(w.args).to.deep.equal([131, 487, '2026-06-18']);
        });

        it('narrows a summary to the pre-reset writes only', async () => {
            let db   = new FakeDb(remimedFixture());
            let all  = await prune.summarizeStale(db, { fromBlock: 131, toBlock: 487 });
            let dead = await prune.summarizeStale(db, { fromBlock: 131, toBlock: 487, createdBefore: '2026-07-01' });
            expect(all.total).to.equal(379);
            expect(dead.total).to.equal(358);
        });
    });

    describe('listStaleBlocks', () => {
        it('reports per-block groups with their write times', async () => {
            let db   = new FakeDb(remimedFixture());
            let list = await prune.listStaleBlocks(db, { fromBlock: 131, toBlock: 135 });
            expect(list.map(b => b.snapshotBlock)).to.deep.equal([131, 132, 133, 134, 135]);
            expect(list.every(b => b.capability === 'cross_chain' && b.rows === 1)).to.equal(true);
            expect(list[0].minCreated).to.equal(DEAD_WRITE);
        });

        it('caps the result at the requested limit', async () => {
            let db   = new FakeDb(remimedFixture());
            let list = await prune.listStaleBlocks(db, { fromBlock: 131, toBlock: 487 }, 5);
            expect(list).to.have.lengthOf(5);
        });

        it('rejects a non-positive limit', async () => {
            let db = new FakeDb(remimedFixture());
            let threw = false;
            try { await prune.listStaleBlocks(db, { fromBlock: 131 }, 0); }
            catch(e){ threw = /limit must be a positive integer/.test(e.message); }
            expect(threw).to.equal(true);
        });
    });

    describe('pruneStale', () => {
        it('clears the dead range and leaves live-chain rows alone', async () => {
            let db  = new FakeDb(deadChainFixture());
            let res = await prune.pruneStale(db, { fromBlock: 131, toBlock: 487 });

            expect(res.deleted).to.equal(358);
            expect(res.remaining).to.equal(0);
            expect(db.rows.map(r => r.snapshot_block).sort((a, b) => a - b)).to.deep.equal([12, 130]);
        });

        it('leaves other capabilities in the range untouched when scoped', async () => {
            let db  = new FakeDb(deadChainFixture());
            let res = await prune.pruneStale(db, { fromBlock: 131, toBlock: 487, capability: 'cross_chain' });

            expect(res.deleted).to.equal(357);
            expect(res.remaining).to.equal(0);
            expect(db.rows.filter(r => r.capability === 'oracle_publish')).to.have.lengthOf(1);
        });

        it('deletes in bounded batches and stops on the first short batch', async () => {
            let db  = new FakeDb(deadChainFixture());
            let res = await prune.pruneStale(db, { fromBlock: 131, toBlock: 487, batchSize: 100 });

            expect(res.deleted).to.equal(358);
            expect(res.batches).to.equal(4);          // 100 + 100 + 100 + 58
            let deletes = db.queries.filter(q => q.sql.startsWith('DELETE'));
            expect(deletes).to.have.lengthOf(4);
            expect(deletes[0].sql).to.include('LIMIT ?');
            expect(deletes[0].args[deletes[0].args.length - 1]).to.equal(100);
        });

        it('is idempotent: a second run deletes nothing', async () => {
            let db = new FakeDb(deadChainFixture());
            await prune.pruneStale(db, { fromBlock: 131, toBlock: 487 });
            let again = await prune.pruneStale(db, { fromBlock: 131, toBlock: 487 });
            expect(again.deleted).to.equal(0);
            expect(again.remaining).to.equal(0);
        });

        it('clears an open-ended range above a reset chain tip', async () => {
            let db  = new FakeDb(deadChainFixture());
            let res = await prune.pruneStale(db, { fromBlock: 146 });   // everything past the live tip
            expect(res.deleted).to.equal(343);                          // 342 cross_chain (146-487) + 1 oracle_publish
            expect(db.rows.map(r => r.snapshot_block).every(b => b <= 145)).to.equal(true);
        });

        it('refuses an invalid batch size before issuing any DELETE', async () => {
            let db = new FakeDb(deadChainFixture());
            let before = db.rows.length;
            for(let bad of [0, -1, 2.5, 'x']){
                let threw = false;
                try { await prune.pruneStale(db, { fromBlock: 131, toBlock: 487, batchSize: bad }); }
                catch(e){ threw = /batchSize must be a positive integer/.test(e.message); }
                expect(threw, 'batchSize=' + bad).to.equal(true);
            }
            expect(db.rows.length).to.equal(before);
        });

        it('spares live rows at re-mined heights when fenced by write time', async () => {
            let db  = new FakeDb(remimedFixture());
            let res = await prune.pruneStale(db, { fromBlock: 131, toBlock: 487, createdBefore: '2026-07-01' });

            expect(res.deleted).to.equal(358);       // only the dead-incarnation rows
            expect(res.remaining).to.equal(0);

            let survivors = db.rows.filter(r => r.snapshot_block >= 131 && r.snapshot_block <= 487);
            expect(survivors).to.have.lengthOf(21);  // the re-mined 140-160 live rows
            expect(survivors.every(r => r.created_at === LIVE_WRITE)).to.equal(true);
        });

        it('without the fence it would also take the re-mined live rows', async () => {
            let db  = new FakeDb(remimedFixture());
            let res = await prune.pruneStale(db, { fromBlock: 131, toBlock: 487 });
            expect(res.deleted).to.equal(379);       // 358 dead + 21 live: why the fence exists
        });

        it('refuses to run without an explicit range', async () => {
            let db = new FakeDb(deadChainFixture());
            let threw = false;
            try { await prune.pruneStale(db, {}); } catch(e){ threw = /fromBlock is required/.test(e.message); }
            expect(threw).to.equal(true);
            expect(db.queries).to.have.lengthOf(0);
        });
    });
});
