CREATE DATABASE IF NOT EXISTS vibemetrics;
USE vibemetrics;

CREATE TABLE IF NOT EXISTS events
(
    project_id LowCardinality(String),
    event_id String,
    session_id String,
    person_id String,
    ts DateTime64(3, 'UTC'),
    event_name LowCardinality(String),
    channel LowCardinality(String),
    page String,
    is_conversion UInt8,
    duration_ms UInt32 DEFAULT 0,
    scroll_depth UInt8 DEFAULT 0,
    referrer String DEFAULT '',
    properties String DEFAULT '{}',
    traffic_type LowCardinality(String) DEFAULT 'unknown',
    country_code FixedString(2) DEFAULT 'ZZ',
    updated_at DateTime64(6, 'UTC') DEFAULT now64(6)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_id, event_id);

CREATE TABLE IF NOT EXISTS crm_deals
(
    project_id LowCardinality(String),
    deal_id String,
    person_id String,
    closed_at DateTime64(3, 'UTC'),
    revenue Decimal(18, 2),
    updated_at DateTime64(6, 'UTC') DEFAULT now64(6)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_id, deal_id);
