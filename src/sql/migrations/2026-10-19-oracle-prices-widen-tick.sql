-- Widen oracle_prices.tick only after every indexer and explorer mirror has widened it.
-- Indexers use 2026-09-22-oracle-prices-widen-tick.sql; explorers use the hub-mirror reconciler.
-- The runtime order is operator-attested with XCHAIN_HUB_ORACLE_TICK_MIRRORS_WIDENED=1.
-- xchain:migration mode=manual

ALTER TABLE `oracle_prices` MODIFY `tick` VARCHAR(250) NOT NULL;
