-- Widen oracle_prices.tick only after every indexer and explorer mirror has widened it.
-- Indexers use 2026-09-22-oracle-prices-widen-tick.sql; explorers use the hub-mirror reconciler.
-- The order is operator-attested: apply this file by hand only once every mirror is widened.
-- xchain:migration mode=manual

ALTER TABLE `oracle_prices` MODIFY `tick` VARCHAR(250) NOT NULL;
