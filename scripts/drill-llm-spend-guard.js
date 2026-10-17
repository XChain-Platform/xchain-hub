#!/usr/bin/env node
'use strict';
// Live drill for the rolling per-window USD spend guard on LLM dispatch
// (src/providers/llm.js, src/lib/spend_guard.js).
//
// The unit suite proves the guard in-process against a mocked spawn. This drill
// proves it on a DEPLOYED hub: it runs inside the hub container (or against any
// checkout) with the real claude_spawn transport, the real audit log and the real
// reservation/commit path, and only the vendor is replaced, by a stub `claude` CLI
// that answers with a fixed invoice (total_cost_usd) and never dials anyone. No
// real money moves and no vendor credential is needed.
//
// What it asserts, with a $0.10 window and a $0.04 invoice per call:
//   1. back-to-back calls dispatch until the window is spent (2 dispatch, the 3rd
//      is refused with err.kind === 'budget_exhausted' and the stub is NOT run);
//   2. a burst of concurrent calls clears exactly what the window has left (the
//      reserve() step is synchronous, so the burst cannot overspend);
//   3. once the window rolls, dispatch resumes;
//   4. the audit log carries an intent + settle pair per call, the refused call
//      settled as `blocked`.
//
// Run inside the regtest hub container (the drill copies itself in):
//   xchain-hub/scripts/drill-llm-spend-guard.sh dankserver xchain-node-xchain-hub
// or directly against a checkout:
//   node scripts/drill-llm-spend-guard.js
//
// Every knob is an env var the guard already reads (LLM_* keys), so the drill
// configures the guard the same way an operator would; it never touches the
// hub's data dir or its persisted spend window (persist is left off).

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const HUB_ROOT  = process.env.DRILL_HUB_ROOT || path.resolve(__dirname, '..');
const WINDOW_MS = parseInt(process.env.DRILL_WINDOW_MS || '8000', 10);
const CAP_CENTS = 10;   // $0.10 per window
const EST_CENTS = 5;    // reserve $0.05 per call before dispatch
const INVOICE   = 0.04; // what the stub CLI reports as total_cost_usd -> 4c after re-price

// ---- stub vendor: a `claude` CLI that returns a fixed invoice and counts runs ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-spend-drill-'));
const stubBin  = path.join(work, 'claude');
const hitsFile = path.join(work, 'hits');
const cfgDir   = path.join(work, 'claude-config');
fs.mkdirSync(cfgDir);
// The resolver requires a token-shaped credentials file; the stub CLI never reads
// it, so this fixed placeholder cannot grant real access.
fs.writeFileSync(path.join(cfgDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"drill-placeholder"}}\n');
fs.writeFileSync(stubBin, [
    '#!/bin/sh',
    // drain stdin (the prompt) so the parent never sees EPIPE
    'cat > /dev/null',
    'echo x >> ' + JSON.stringify(hitsFile),
    'printf \'%s\' \'{"type":"result","subtype":"success","is_error":false,' +
        '"result":"drill attestation body","total_cost_usd":' + INVOICE + '}\'',
    ''
].join('\n'));
fs.chmodSync(stubBin, 0o755);

// ---- point the deployed module at the stub, with a tiny window ----
process.env.CLAUDE_BIN                         = stubBin;
process.env.HUB_CLAUDE_CONFIG_DIR              = cfgDir;        // resolves the claude_spawn transport
process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW = String(CAP_CENTS);
process.env.LLM_EST_SPEND_USD_CENTS            = String(EST_CENTS);
process.env.LLM_SPEND_WINDOW_MS                = String(WINDOW_MS);
process.env.LLM_SPEND_LOG_PATH                 = path.join(work, 'llm-spend.jsonl');
delete process.env.LLM_ENABLED;                                 // the kill switch stays open
delete process.env.LLM_SPEND_STATE_PATH;                        // and nothing persists

const llm = require(path.join(HUB_ROOT, 'src/providers/llm.js'));
llm.armSpendGuard({}, false);

const hits = () => fs.existsSync(hitsFile) ? fs.readFileSync(hitsFile, 'utf8').split('\n').filter(Boolean).length : 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const failures = [];
function check(cond, msg){ (cond ? console.log : (m => { failures.push(m); console.log(m); }))((cond ? 'PASS ' : 'FAIL ') + msg); }

async function attest(label){
    try {
        const text = await llm.fetch(JSON.stringify({ prompt: 'drill ' + label }), {});
        return { ok: true, text };
    } catch (e) {
        return { ok: false, err: e };
    }
}

(async () => {
    console.log('drill: hub root ' + HUB_ROOT + ', window ' + WINDOW_MS + 'ms, cap ' + CAP_CENTS + 'c, est ' + EST_CENTS + 'c, invoice $' + INVOICE);
    console.log('drill: stats before ' + JSON.stringify(llm.spendStats()));

    // 1. back-to-back sequential calls
    const r1 = await attest('1'); const s1 = llm.spendStats();
    check(r1.ok && s1.spentInWindowUsdCents === 4, 'call 1 dispatched and re-priced to the 4c invoice (spent=' + s1.spentInWindowUsdCents + ')');
    const r2 = await attest('2'); const s2 = llm.spendStats();
    check(r2.ok && s2.spentInWindowUsdCents === 8, 'call 2 dispatched (spent=' + s2.spentInWindowUsdCents + ')');
    const hitsBefore3 = hits();
    const r3 = await attest('3'); const s3 = llm.spendStats();
    check(!r3.ok && r3.err && r3.err.kind === 'budget_exhausted' && r3.err.budgetExhausted === true,
          'call 3 refused as budget_exhausted (' + (r3.ok ? 'dispatched!' : String(r3.err && r3.err.message)) + ')');
    check(r3.err && r3.err.paused === undefined, 'refusal is not the operator kill switch');
    check(hits() === hitsBefore3, 'no vendor call issued for the refused attestation (hits=' + hits() + ')');
    check(s3.spentInWindowUsdCents === 8, 'refusal did not consume budget (spent=' + s3.spentInWindowUsdCents + ')');
    check(s3.blocked && Object.values(s3.blocked).some(v => Number(v) > 0), 'refusal counted in stats.blocked ' + JSON.stringify(s3.blocked));

    // 3. the window rolls, dispatch resumes
    console.log('drill: waiting ' + WINDOW_MS + 'ms for the window to roll');
    await sleep(WINDOW_MS + 250);
    const s4pre = llm.spendStats();
    check(s4pre.spentInWindowUsdCents === 0, 'window rolled (spent=' + s4pre.spentInWindowUsdCents + ')');
    const r4 = await attest('4'); const s4 = llm.spendStats();
    check(r4.ok && s4.spentInWindowUsdCents === 4, 'call 4 dispatched after the roll (spent=' + s4.spentInWindowUsdCents + ')');

    // 2. a concurrent burst against the 6c left: one more 5c reservation fits, the rest refuse
    const hitsBeforeBurst = hits();
    const burst = await Promise.all(['b1', 'b2', 'b3', 'b4'].map(attest));
    const okCount = burst.filter(r => r.ok).length;
    const refused = burst.filter(r => !r.ok && r.err && r.err.kind === 'budget_exhausted').length;
    check(okCount === 1 && refused === 3, 'burst of 4: ' + okCount + ' dispatched, ' + refused + ' refused');
    check(hits() - hitsBeforeBurst === 1, 'burst issued exactly one vendor call (hits delta=' + (hits() - hitsBeforeBurst) + ')');
    check(llm.spendStats().spentInWindowUsdCents === 8, 'window holds 8c after the burst (spent=' + llm.spendStats().spentInWindowUsdCents + ')');

    // 4. audit log: intent+settle per call, refusals settled as blocked
    const recs = fs.readFileSync(process.env.LLM_SPEND_LOG_PATH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const intents = recs.filter(r => r.phase === 'intent').length;
    const settles = recs.filter(r => r.phase === 'settle');
    const blocked = settles.filter(r => r.status === 'blocked').length;
    const okSet   = settles.filter(r => r.status === 'ok').length;
    check(intents === 8 && settles.length === 8, 'audit: ' + intents + ' intents, ' + settles.length + ' settles (8 calls)');
    check(okSet === 4 && blocked === 4, 'audit: ' + okSet + ' ok, ' + blocked + ' blocked');
    check(hits() === 4, 'stub vendor ran exactly 4 times total (hits=' + hits() + ')');

    console.log('drill: stats after ' + JSON.stringify(llm.spendStats()));
    console.log('drill: work dir ' + work);
    if (failures.length) { console.log('DRILL FAILED: ' + failures.length + ' check(s)'); process.exit(1); }
    console.log('DRILL PASSED');
    process.exit(0);
})().catch(e => { console.error('drill crashed', e); process.exit(2); });
