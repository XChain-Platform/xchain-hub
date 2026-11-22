'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const exact = require('../../../../src/db/schema/exact_u64.js');
const { isCanonicalInt } = require('../../../../src/lib/canonical_int.js');

describe('hub exact BIGINT reads', function () {
    it('keeps wide u64 values exact and safe values numeric', function () {
        assert.strictEqual(exact.exactU64('18446744073709551615'), '18446744073709551615');
        assert.strictEqual(exact.exactU64('9007199254740993'), '9007199254740993');
        assert.strictEqual(exact.exactU64('42'), 42);
        assert.strictEqual(exact.exactU64(42n), 42);
        assert.strictEqual(exact.exactU64(null), null);
        assert.strictEqual(exact.exactU64(undefined), null);
    });

    it('refuses malformed and out-of-range u64 values', function () {
        assert.throws(() => exact.exactU64('18446744073709551616'), RangeError);
        assert.throws(() => exact.exactU64(-1), RangeError);
        assert.throws(() => exact.exactU64(1.5), RangeError);
        assert.throws(() => exact.exactU64('12abc'), TypeError);
    });

    it('handles signed BIGINT values with the signed range', function () {
        assert.strictEqual(exact.exactI64('-5'), -5);
        assert.strictEqual(exact.exactI64('-9007199254740993'), '-9007199254740993');
        assert.throws(() => exact.exactI64('-9223372036854775809'), RangeError);
    });

    it('casts fields and produces canonical wide integer text', function () {
        const wide = { type: 'BIGINT', signed: () => false, string: () => '9007199254740993' };
        const signed = { type: 'BIGINT', signed: () => true, string: () => '-5' };
        const value = exact.exactU64TypeCast(wide, () => null);
        assert.strictEqual(value, '9007199254740993');
        assert.strictEqual(exact.exactU64TypeCast(signed, () => null), -5);
        assert.strictEqual(exact.exactU64TypeCast({ type: 'INT' }, () => 42), 42);
        assert.strictEqual(isCanonicalInt(value), true);
        assert.strictEqual(isCanonicalInt(9007199254740992), false);
    });

    it('installs the exact cast while retaining numeric safe BIGINT reads', function () {
        const mariadb = { createPool: sinon.stub().returns({ end: sinon.stub().resolves() }) };
        const Database = proxyquire('../../../../src/db', { mariadb });
        const db = new Database(null, 3306, 'hubdb', 'u', 'p');
        assert.strictEqual(db.connectionPoolParams.typeCast, exact.exactU64TypeCast);
        assert.strictEqual(db.connectionPoolParams.bigIntAsNumber, true);
    });
});
