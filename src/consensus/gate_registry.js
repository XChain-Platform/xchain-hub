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
 * The hub's activation registry: every flag-day table this hub judges, as
 * (key, value) rows keyed '<stem>.<EXPORT>', the spelling the rules digest and
 * the signed GATES field already use. The carriers at the top of src/ keep
 * their predicates and read their tables from here, so a table lives in ONE
 * place per repo and a moved carrier can no longer read as "not yet active".
 *
 * The region between the SHARED-GATES markers is a BYTE TWIN of the block in
 * xchain-indexer/src/protocol_changes/shared_rows.js and in the registry files
 * of xchain-sync, xchain-explorer and xchain-sdk. The twin is the block, not
 * this file: each consumer wraps the same bytes in its own addGate. Nothing in
 * the block may reference anything but addGate, UNARMED and UNPINNED, and no
 * key, spelling or order in it changes inside a window.
 *
 * Readers get(), copy(), has(), keys() and rows(). A miss THROWS a
 * RegistryMissError naming the key: a row a build lacks is a build defect and
 * never a network state. Nothing may add a row after this module loads.
 *
 ********************************************************************/

'use strict';

const config = require('../config');   // the environment's one home: lazy getters, nothing evaluated at load

// The two sentinels a block row may use: a height or instant the operator has not
// named yet (a real number, year 2286, so the fingerprint tells it apart from
// UNPINNED) and a network the gate is not ratified for at all (never active: every
// predicate refuses a null threshold explicitly, because `0 >= null` is true).
const UNARMED = 9999999999;
const UNPINNED = null;

const UNITS = ['height', 'time', 'epoch', 'ruleset', 'constant'];
const KEY_RE = /^[A-Za-z0-9_/-]+(\.[A-Za-z0-9_]+)+$/;

class RegistryMissError extends Error {
    constructor(key) {
        super('activation registry has no row ' + JSON.stringify(key));
        this.name = 'RegistryMissError';
        this.key = key;
    }
}

// key -> { unit, value }, in block order. A Map, so no key off the wire can
// ever resolve to an inherited member.
const entries = new Map();

function isPlainObject(v) {
    if (v === null || typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

// A deep copy of plain data, frozen when asked. Primitives and RegExps come
// back as they are: nothing a row holds of those kinds can be edited in place.
function clone(value, freeze) {
    let out;
    if (Array.isArray(value)) out = value.map((v) => clone(v, freeze));
    else if (isPlainObject(value)) {
        out = {};
        for (const k of Object.keys(value)) out[k] = clone(value[k], freeze);
    } else return value;
    return freeze ? Object.freeze(out) : out;
}

function addGate(key, unit, table) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('addGate: key ' + JSON.stringify(key) + ' does not match ' + String(KEY_RE));
    if (entries.has(key)) throw new Error('addGate: duplicate key ' + key);
    if (!UNITS.includes(unit)) throw new Error('addGate: ' + key + ' unit must be one of ' + UNITS.join('|') + ', got ' + JSON.stringify(unit));
    if (unit !== 'constant' && !isPlainObject(table)) throw new Error('addGate: ' + key + ' table must be a plain object of network keys');
    entries.set(key, { unit, value: clone(table, true) });
}

// The regtest entries a VENUE arms from its environment. The block writes them
// UNPINNED (the block is data, an environment read is not) and the lever is applied
// when the row is READ, at the reader's own require time: that is when the three
// carriers resolved process.env into their literal, one grammar in three
// copies, so a module re-required under a new environment still sees the new height
// and the rules digest still reads its values once and caches them. The variable
// name and the armed height are rows of the block, never restated here.
const ADMISSION = ['mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ENV',
    'mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT', 'MIRROR ADMISSION'];
const VENUE_LEVERS = {   // key -> [entries, env row, armed-height row, label]
    'rollcall_activation.ROLLCALL_ACTIVATION': [['regtest'],
        'rollcall_activation.ROLLCALL_REGTEST_ENV', 'rollcall_activation.ROLLCALL_REGTEST_ARMED_HEIGHT', 'ROLLCALL'],
    'rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION': [['regtest'],
        'rollcall_gates_activation.ROLLCALL_GATES_REGTEST_ENV', 'rollcall_gates_activation.ROLLCALL_GATES_REGTEST_ARMED_HEIGHT', 'ROLLCALL gates'],
    'mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION': [['BTC:regtest', 'LTC:regtest', 'DOGE:regtest'], ...ADMISSION],
    'mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION': [['BTC:regtest', 'LTC:regtest', 'DOGE:regtest'], ...ADMISSION],
    // The anchor-attest barrier shares the admission family's lever: one venue variable arms both.
    'anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION': [['regtest'], ...ADMISSION],
};

// The carriers' grammar, case-insensitive and trimmed: armed | genesis | on | true |
// yes arm at the documented height, a non-negative integer arms at that height,
// unset | '' | off | inert | false | no | none stay inert, and anything else fails
// CLOSED to inert and says so once (a typo that silently armed a venue would produce
// closes nobody meant to drive).
const warned = new Set();
function venueHeight([, envKey, armedKey, label]) {
    const envName = valueOf(envKey, true);
    const raw = config.env()[envName];
    if (raw === undefined || raw === null) return UNPINNED;
    const s = String(raw).trim().toLowerCase();
    if (s === '' || s === 'off' || s === 'inert' || s === 'false' || s === 'no' || s === 'none') return UNPINNED;
    if (s === 'armed' || s === 'genesis' || s === 'on' || s === 'true' || s === 'yes') return valueOf(armedKey, true);
    if (/^\d+$/.test(s)) {
        const h = parseInt(s, 10);
        if (Number.isFinite(h) && h >= 0) return h;
    }
    if (!warned.has(envName + '=' + s)) {
        warned.add(envName + '=' + s);
        process.stderr.write(label + ': ignoring ' + envName + '=' + JSON.stringify(String(raw))
            + '; regtest stays INERT. Expected a non-negative height, "armed", or "off".\n');
    }
    return UNPINNED;
}

// The row's value with any venue lever applied, frozen or as a mutable copy.
function valueOf(key, freeze) {
    const row = entries.get(key);
    if (!row) throw new RegistryMissError(key);
    const lever = VENUE_LEVERS[key];
    if (!lever) return freeze ? row.value : clone(row.value, false);
    const armed = clone(row.value, false);
    const height = venueHeight(lever);
    for (const k of lever[0]) armed[k] = height;
    return freeze ? Object.freeze(armed) : armed;
}

/** @returns {*} the frozen row value; throws RegistryMissError on a miss, never null. */
function get(key) { return valueOf(key, true); }
/** @returns {*} a mutable deep copy of the row value, for a carrier whose table was never frozen. */
function copy(key) { return valueOf(key, false); }
function has(key) { return entries.has(key); }
function keys() { return [...entries.keys()]; }
/** @returns {Array<[string, *]>} every row in block order, levers applied. */
function rows() { return keys().map((key) => [key, get(key)]); }

// SHARED-GATES BEGIN
addGate('anchor_reward_activation.ANCHOR_ATTEST_ARRIVAL_MARGIN_S', 'constant', 64800);
addGate('anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION', 'height', {
    mainnet: null,        // INERT under the 2026-08-29 mainnet write hold
    testnet: null,        // SIZED AT THE CUT from the measured tip plus the roll window
    regtest: UNPINNED,   // shares the family's arming seam so one venue lever arms both
});
addGate('anchor_reward_activation.ANCHOR_REWARD_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers before this height
    testnet: 0,
    regtest: 0,
});
addGate('anchor_reward_activation.ANCHOR_REWARD_AMOUNT', 'constant', '10.00000000');
addGate('anchor_reward_activation.ANCHOR_REWARD_DERIVE_ACTIVATION', 'height', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 anchor reward attestations, 0 validator_rewards rows, measured 2026-09-09)
    testnet: 0,           // ARMED at genesis 2026-08-14 per the 2026-08-11 operator ruling; see the testnet note above
    regtest: 0,
});
addGate('anchor_reward_activation.ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS', 'constant', 60);
addGate('anchor_reward_activation.ANCHOR_REWARD_MIRROR_MATURITY', 'constant', 144);
addGate('anchor_reward_activation.ARCHIVE_REWARD_ACTIVATION', 'height', {
    mainnet: 963000,      // ARMED 2026-07-16, RE-PINNED 2026-08-12 off block 969500 onto the mainnet pre-freeze deploy-train boundary (tip 959,853 on 07-27 at ~144 blocks/day + 21d); deploy every consumer before this height
    testnet: 0,
    regtest: 0,
});
addGate('anchor_reward_activation.ARCHIVE_REWARD_AMOUNT', 'constant', '10.00000000');
addGate('attest_relay_activation.ATTEST_RELAY_ACTIVATION', 'height', {
    mainnet: 963000,      // ARMED 2026-07-30, RE-PINNED 2026-08-12 off block 969500 with the rest of the coordinated mainnet activation cohort; deploy every indexer + hub before this height
    testnet: 0,
    regtest: 0,
});
addGate('attest_relay_reject_slot_activation.ATTEST_RELAY_REJECT_SLOT_ACTIVATION', 'time', {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 attestations, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});
addGate('attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION', 'height', {
    mainnet: null,        // INERT: operator-owned height, unratified. The legacy on-chain response path runs byte for byte.
    testnet: 151324,      // ARMED 2026-09-07 at the chain tip on the operator ruling: exercising the mirror on testnet is the point of this train, so it activates on deploy rather than waiting on a future height.
    regtest: 0,           // ARMED at genesis so the e2e mirror venue exercises the mirror path
});
addGate('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING', 'constant', {
    confirmations: 3,
    maxSlots:      2,
});
addGate('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION', 'height', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 attestations, measured 2026-09-09)
    testnet: 150780,      // ARMED 2026-09-02. Tip was 150760 at 17:08Z running 20 min/block, so ~20 blocks (~6.5h). Sized to OUR fleet's deploy wave, not to the community's, and the SAFETY comes from deploy ORDER rather than from this margin: only an upgraded hub can PRODUCE a widened ATTEST v1, so indexers upgraded before hubs leaves no divergence window even if the height arrives mid-deploy.
    regtest: 0,           // ARMED at genesis so the e2e venue exercises the ladder
});
addGate('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2', 'constant', {
    startOffset: 0,
    headroom:    1,
    maxSlots:    2,
});
addGate('attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION', 'height', {
    mainnet: null,        // INERT: operator-owned height, unratified. Ratified only after the mirror arms there.
    testnet: 151800,      // SIZED 2026-09-08 (tip 151483 at 07:32Z, about 5 blocks/h): above the 151324 mirror floor and past the v0.16.0 indexer-then-hub roll; keyed on the request block.
    regtest: 0,           // ARMED at genesis so the e2e mirror venue exercises the flip
});
addGate('checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 146000,      // ARMED 2026-07-22: first BTC-testnet anchor past all three STATE_COMMITMENT testnet thresholds; was 0, which forced the SPV root suffix from testnet genesis before the indexer computes roots, so the hub refused to sign every testnet checkpoint
    regtest: 0,
});
addGate('cross_chain_royalty_activation.CROSS_CHAIN_ROYALTY_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers before this height
    testnet: 0,
    regtest: 0,
});
addGate('equivocation_header.ENGINE_TAGS', 'constant', {
    DEX:        'XDEX',
    XCALL:      'XCALL',
    ATTEST:     'XATTEST',
    ORACLE:     'XORACLE',
    // PRICE batches. A DISTINCT tag from ORACLE, not a reuse: a batch canonical
    // carries first_round/last_round and no scalar `round`, and SLASH v0 reads
    // `round` out of an ORACLE-tagged content to judge equivocation, skipping its
    // distinct-rounds guard when either side lacks one. Under a shared tag an
    // honest validator that signed one per-round consensus canonical and one batch
    // at the same BTC anchor would be provably equivocating, for a full bond burn plus permanent
    // capability disqualification. The batch ROUND_ID is
    // `<anchor>|<first_round>|<last_round>` (pipes are safe here; equivKey treats
    // the round id as opaque), so two honest batches that split one window
    // differently do not collide on one key either.
    ORACLE_BATCH: 'XORACLEB',
    CHECKPOINT: 'XCHECKPOINT',
    CONFIG:     'XCONFIG',
    NODEPROOF:  'XNODEPROOF',
    // ROLLCALL presence proofs. Namespacing ONLY, exactly like XNODEPROOF: the
    // tag is deliberately absent from SLASH's ENGINE_CAPABILITY map, so no
    // ROLLCALL canonical is a slashable family. Several valid ROLLCALLs per
    // epoch are expected (a leader's, sweepers', self-publishes), every one
    // carrying signatures over the SAME canonical for that epoch, so two of
    // them are never conflicting content for one key. ROUND_ID is the BTC
    // EPOCH_HEIGHT in decimal, VIEW is 0.
    ROLLCALL:   'XROLLCALL',
    // Cross-chain bridge transfer records. ROUND_ID is the transfer_id, VIEW is the live
    // PBFT view on the hub and the row's finalizing_view on an indexer. Mapped to the
    // cross_chain capability in SLASH's ENGINE_CAPABILITY: a forged transfer record directs
    // value, so two conflicting canonicals for one transfer_id must be slashable.
    BRIDGE:     'XBRIDGE',
    // Per-token policy snapshots (allow list, block list, sleep) carried from an origin row
    // to every bridged copy. A DISTINCT tag from BRIDGE, not a reuse: the two canonicals
    // share no field layout, and SLASH judges equivocation within one tag family, so one tag
    // over both would make a validator that signed one transfer and one snapshot at the same
    // round id provably equivocating. ROUND_ID is the snapshot_id.
    POLICY:     'XPOLICY',
});
addGate('equivocation_header.EQUIV_HEADER_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
});
addGate('mirror_admission_activation.ADMIT_COLUMN_CHAINS', 'constant', ['BTC', 'LTC', 'DOGE']);
addGate('mirror_admission_activation.ADMIT_MARGIN_BLOCKS', 'constant', {
    default:                      4,
    attestation_responses:        1,    // their 120 s forward margin was chosen to be as SHORT as propagation allows
    oracle_prices:                1,    // effective_at stays the economic filter; admission is what the barrier certifies
    anchor_reward_attestations: 144,    // the existing ANCHOR_REWARD_MIRROR_MATURITY, already frozen fleet-wide
});
addGate('mirror_admission_activation.ADMIT_MAX_FUTURE_BLOCKS', 'constant', {
    BTC:      6,
    LTC:     24,
    DOGE:    60,
    default:  6,
});
addGate('mirror_admission_activation.ADMIT_MIN_FUTURE_BLOCKS', 'constant', 1);
addGate('mirror_admission_activation.CANONICAL_HEIGHT_RE', 'constant', /^(?:0|[1-9][0-9]*)$/);
addGate('mirror_admission_activation.CHAIN_CODE_RE', 'constant', /^[A-Z0-9]{1,10}$/);
addGate('mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION', 'height', {
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,   // SIZED AT THE CUT, strictly below the consumer height for this key
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    'BTC:regtest':  UNPINNED,
    'LTC:regtest':  UNPINNED,
    'DOGE:regtest': UNPINNED,
});
addGate('mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION', 'height', {
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,   // SIZED AT THE CUT, strictly above the producer height for this key
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    'BTC:regtest':  UNPINNED,
    'LTC:regtest':  UNPINNED,
    'DOGE:regtest': UNPINNED,
});
addGate('mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT', 'constant', 0);
addGate('mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ENV', 'constant', 'XC_MIRROR_ADMISSION_ACTIVATION');
addGate('price_pair_activation.PRICE_PAIR_RE_LEGACY', 'constant', /^[A-Z]{3,5}\/[A-Z]{3,5}$/);
addGate('price_pair_activation.PRICE_PAIR_RE_WIDE', 'constant', /^[A-Z]{3,6}\/[A-Z]{3,5}$/);
addGate('price_pair_activation.PRICE_PAIR_TICKER_MAX_LEGACY', 'constant', 5);
addGate('price_pair_activation.PRICE_PAIR_TICKER_MAX_WIDE', 'constant', 6);
addGate('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION', 'time', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 PRICE actions, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});
addGate('price_scale_activation.PRICE_SCALE_ACTIVATION', 'time', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 PRICE actions, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});
addGate('price_scale_activation.PRICE_SCALE_MAX_DECIMALS', 'constant', 8);
addGate('price_scale_activation.PRICE_VALUE_RE_CANONICAL', 'constant', /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/);
addGate('price_scale_activation.PRICE_VALUE_RE_LEGACY', 'constant', /^[0-9]+(\.[0-9]+)?$/);
addGate('price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION', 'height', {
    mainnet: 963000,      // ARMED, RE-PINNED 2026-08-12 off 969500 onto the shared pre-freeze train boundary; deploy ALL indexers + hubs before this height
    testnet: 0,
    regtest: 0,
});
addGate('retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION', 'height', {
    mainnet: 963000,      // ARMED 2026-07-16, RE-PINNED 2026-08-12 off 969500 onto the shared pre-freeze train boundary (tip 959,853 on 07-27 at ~144 blocks/day + 21d); deploy every consumer before this era
    testnet: 0,
    regtest: 0,
});
addGate('rollcall_activation.ROLLCALL_ACCEPT_WINDOW_BLOCKS', 'constant', { mainnet: 144, testnet: 144, regtest: 12 });
addGate('rollcall_activation.ROLLCALL_ACTIVATION', 'epoch', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 validators, 0 stakes, 0 roll-calls, measured 2026-09-09)
    testnet: 151200,      // 1008 x 150 = 144 x 1050; tip was 150400 on 2026-08-30, ~5.5 days out
    regtest: UNPINNED,   // ARMS AT 0 when the venue sets XC_ROLLCALL_REGTEST_ACTIVATION
});
addGate('rollcall_activation.ROLLCALL_DOGE_MATURITY', 'constant', { mainnet: 60, testnet: 60, regtest: 2 });
addGate('rollcall_activation.ROLLCALL_EVICT_MISSES', 'constant', 2);
addGate('rollcall_activation.ROLLCALL_INTERVAL_BLOCKS', 'constant', { mainnet: 1008, testnet: 1008, regtest: 30 });
addGate('rollcall_activation.ROLLCALL_PROOF_DELAY_BLOCKS', 'constant', { mainnet: 36, testnet: 36, regtest: 2 });
addGate('rollcall_activation.ROLLCALL_REGTEST_ARMED_HEIGHT', 'constant', 0);
addGate('rollcall_activation.ROLLCALL_REGTEST_ENV', 'constant', 'XC_ROLLCALL_REGTEST_ACTIVATION');
addGate('rollcall_activation.ROLLCALL_REWARD_AMOUNT', 'constant', '10.00000000');
addGate('rollcall_activation.ROLLCALL_STREAK_LOOKBACK', 'constant', 4);
addGate('rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION', 'epoch', {
    mainnet: null,        // INERT placeholder: the operator owns this height
    testnet: 152208,      // SIZED 2026-09-08: the first epoch boundary (151200 + 1008) after the v0.16.0 roll, which lands between the 151200 and 152208 closes
    regtest: UNPINNED,   // ARMS AT 0 when the venue sets XC_ROLLCALL_GATES_REGTEST_ACTIVATION
});
addGate('rollcall_gates_activation.ROLLCALL_GATES_REGTEST_ARMED_HEIGHT', 'constant', 0);
addGate('rollcall_gates_activation.ROLLCALL_GATES_REGTEST_ENV', 'constant', 'XC_ROLLCALL_GATES_REGTEST_ACTIVATION');
addGate('snapshot_reorg_buffer.CANONICAL_REORG_BUFFER', 'constant', 6);
addGate('snapshot_reorg_buffer.SNAPSHOT_BURIAL_ACTIVATION', 'height', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 validators, 0 stakes, measured 2026-09-09)
    // ARMED AT GENESIS, operator-ratified 2026-08-18 as part of the pre-launch "every
    // feature active on testnet" ruling. Safe because testnet's indexer state is being
    // REBUILT from the chain before launch, and because testnet carries no artifacts
    // signed under the current reading for this to reinterpret: the live explorer reports
    // 0 validators, 0 capability stakes and 0 checkpoints on BTC testnet, so nothing has
    // ever been quorum-signed there. Mainnet was measured the same way on 2026-09-09.
    testnet: 0,
    regtest: 0,
});
addGate('stake_weighted_quorum.STAKE_WEIGHTED_QUORUM_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
});
addGate('token_bridge_activation.TOKEN_BRIDGE_ACTIVATION', 'height', {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
});
addGate('token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION', 'height', {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
});
addGate('xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION', 'height', {
    'BTC:mainnet':  9999999999,
    'LTC:mainnet':  9999999999,
    'DOGE:mainnet': 9999999999,
    mainnet:        9999999999,   // fallback for a coin with no entry above
    'BTC:testnet':  9999999999,   // the arming train sizes this at the measured TBTC tip
    'LTC:testnet':  9999999999,   // the arming train sizes this at the measured TLTC tip
    'DOGE:testnet': 9999999999,   // the arming train sizes this at the measured TDOGE tip
    testnet:        9999999999,   // fallback: a testnet coin with no entry above stays dark
    regtest:        0,            // genesis-active so the e2e rail exercises the armed rule
});
// SHARED-GATES END

// HUB-ONLY GATES: none. Every module SHARED_GATES names is an indexer twin or a
// shared carrier, so all 29 of the digest's value rows are in the block (its other
// 4 keys are admission FUNCTIONS, read from their carrier). The four hub-only
// activation files keep their literals and are not rows (decision D34).

module.exports = { addGate: undefined, get, copy, has, keys, rows, UNARMED, UNPINNED, RegistryMissError };
