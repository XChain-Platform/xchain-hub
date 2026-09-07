--********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
--********************************************************************
--
-- attest_published_batches: the durable at-most-once marker for the periodic
-- ATTEST v5/v6 response batch (the ATTEST response-mirror design, §6.2).
--
-- WHY A TABLE AND NOT THE BUFFER FILE. The batch is a money-bearing broadcast on
-- the operator's one DOGE wallet. The publisher's buffer and dead-letter files
-- live on the disk whose exhaustion is precisely what makes a post-broadcast
-- rewrite fail, so the guard that decides "has this window already been paid for"
-- is kept on the hub DB instead. A restart reads it back before it publishes
-- anything, which is what makes a crash between the send and the sent marker cost
-- an operator check rather than a second fee.
--
-- KEYED ON (network, window_start), NOT ON A BATCH ID. The window is the unit of
-- coverage: every window publishes, an empty one as a row_count 0 head, because a
-- chain-only node proves coverage by finding a head for every window rather than
-- by trusting that a silent hour held nothing. A batch key is derived from the
-- window bounds, so keying on the window is keying on the batch's identity with no
-- second spelling of it.
--
-- STATUS IS THE WHOLE STATE MACHINE:
--   intent  - broadcast intent recorded, outcome UNKNOWN. Written before the send.
--             A restart that finds one QUARANTINES the window: it is never
--             re-published automatically, because the transaction may be in a
--             mempool this hub cannot see, and an operator reconciles it by hand.
--   sent    - the broadcast returned. This hub has paid for the window.
--   deadletter - the window could not be published at all (over the row cap, or a
--             body the wire refuses). Recorded so the sweep stops retrying content
--             that cannot become a batch, and the content itself is written to the
--             publisher's append-only dead-letter file for an operator.
--   landed  - the batch was parsed off DOGE and pushed back through
--             `pushattestbatch`. Authoritative across the whole federation rather
--             than for this hub alone: any hub's batch landing covers the window,
--             so a hub that never published one stops considering it.
--
-- A window with no row at all is simply unpublished, which is the state a window
-- whose signing round found no quorum is deliberately left in: the rows are still
-- in `attestation_responses` and a later attempt rebuilds byte-identical content
-- from them.

CREATE TABLE attest_published_batches (
    network        VARCHAR(20)     NOT NULL,                 -- mainnet/testnet/regtest; the window is scoped to one network's mirror
    window_start   BIGINT UNSIGNED NOT NULL,                 -- unix seconds, inclusive, aligned to the batch window
    window_end     BIGINT UNSIGNED NOT NULL,                 -- unix seconds, EXCLUSIVE upper bound; carried so the batch key is re-derivable from the row alone
    batch_key      CHAR(64)        DEFAULT NULL,             -- sha256 over the window bounds; the wire's own identity, recorded for operator reconciliation
    row_count      INT UNSIGNED    NOT NULL DEFAULT 0,       -- terminal rows the published batch carried; 0 is a legitimate coverage head
    txid           VARCHAR(80)     DEFAULT NULL,             -- DOGE txid of the v5 head (NULL until sent, and may stay NULL if the broadcaster returns none)
    status         VARCHAR(16)     NOT NULL DEFAULT 'intent',-- intent | sent | landed; see the header for what each one licenses
    intent_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,-- when intent was durably recorded, before the send
    sent_at        TIMESTAMP       NULL DEFAULT NULL,        -- when the broadcast returned; a NULL here on an `intent` row is the quarantine marker
    landed_at      TIMESTAMP       NULL DEFAULT NULL,        -- when a batch for this window was seen on chain through pushattestbatch
    PRIMARY KEY (network, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Standalone CREATE INDEX rather than an inline KEY, matching the mirror table:
-- an aged database can back-fill a missing index instead of silently serving full
-- scans. The sweep asks "which recent windows are still unpublished", so it reads
-- this table by network in window order.
CREATE INDEX idx_attest_batch_window ON attest_published_batches (network, status, window_start);
