CREATE TABLE IF NOT EXISTS search_terms_hourly (
  store_id TEXT NOT NULL,
  hour_start INTEGER NOT NULL,
  search_term TEXT NOT NULL,
  search_count INTEGER NOT NULL DEFAULT 0,
  no_result_count INTEGER NOT NULL DEFAULT 0,
  product_result_total INTEGER NOT NULL DEFAULT 0,
  category_result_total INTEGER NOT NULL DEFAULT 0,
  last_searched_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, hour_start, search_term)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_search_terms_store_hour
  ON search_terms_hourly (store_id, hour_start DESC);
