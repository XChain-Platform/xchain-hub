'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const { expect } = require('chai');
const crypto     = require('crypto');
const MerkleTree = require('../../src/MerkleTree');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const leaf = (n) => sha('leaf-' + n);

describe('MerkleTree', function () {

    it('hashPair = sha256(left + right)', function () {
        expect(MerkleTree.hashPair('aa', 'bb')).to.equal(sha('aabb'));
    });

    it('single leaf: root is the leaf itself', function () {
        let l = leaf(1);
        expect(MerkleTree.root([l])).to.equal(l);
    });

    it('two leaves: root = hashPair(a, b)', function () {
        let a = leaf(1), b = leaf(2);
        expect(MerkleTree.root([a, b])).to.equal(MerkleTree.hashPair(a, b));
    });

    it('odd width duplicates the last node', function () {
        let a = leaf(1), b = leaf(2), c = leaf(3);
        let expected = MerkleTree.hashPair(MerkleTree.hashPair(a, b), MerkleTree.hashPair(c, c));
        expect(MerkleTree.root([a, b, c])).to.equal(expected);
    });

    it('empty input yields a null root', function () {
        expect(MerkleTree.root([])).to.be.null;
        expect(MerkleTree.buildTree([]).root).to.be.null;
    });

    it('is order-sensitive (a different leaf order yields a different root)', function () {
        let a = leaf(1), b = leaf(2);
        expect(MerkleTree.root([a, b])).to.not.equal(MerkleTree.root([b, a]));
    });

    it('generateProof → verifyProof round-trips for every leaf', function () {
        let leaves = [1, 2, 3, 4, 5].map(leaf);          // odd-ish tree
        let tree = MerkleTree.buildTree(leaves);
        leaves.forEach((l, i) => {
            let proof = MerkleTree.generateProof(tree.layers, i);
            expect(MerkleTree.verifyProof(l, proof, tree.root), 'leaf ' + i).to.be.true;
        });
    });

    it('verifyProof rejects a wrong leaf', function () {
        let leaves = [1, 2, 3, 4].map(leaf);
        let tree = MerkleTree.buildTree(leaves);
        let proof = MerkleTree.generateProof(tree.layers, 0);
        expect(MerkleTree.verifyProof(leaf(99), proof, tree.root)).to.be.false;
    });
});
