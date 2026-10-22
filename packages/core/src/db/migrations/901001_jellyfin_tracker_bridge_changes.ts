import type { Migration } from './types.js';

/** A durable, lossless change feed for the Jellyfin tracker bridge. */
export const jellyfinTrackerBridgeChanges: Migration = {
  id: 901001,
  name: 'jellyfin_tracker_bridge_changes',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS jellyfin_tracker_bridge_state (
        user_uuid TEXT PRIMARY KEY,
        checkpoint_change_id BIGINT NOT NULL DEFAULT 0,
        updated_at_ms BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tracker_record_changes (
        change_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uuid TEXT NOT NULL,
        record_id TEXT NOT NULL,
        change_type TEXT NOT NULL DEFAULT 'upsert',
        record_json TEXT,
        record_updated_at_ms BIGINT
      );
      CREATE TABLE IF NOT EXISTS jellyfin_tracker_bridge_rejections (
        user_uuid TEXT NOT NULL,
        change_id BIGINT NOT NULL,
        record_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        record_json TEXT,
        created_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, change_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_record_changes_user_cursor
        ON tracker_record_changes (user_uuid, change_id);
      INSERT INTO tracker_record_changes (user_uuid, record_id, record_json, record_updated_at_ms)
        SELECT user_uuid, record_id, record_json, updated_at_ms FROM tracker_records;
      CREATE TRIGGER IF NOT EXISTS tracker_records_change_insert AFTER INSERT ON tracker_records BEGIN INSERT INTO tracker_record_changes (user_uuid, record_id, change_type, record_json, record_updated_at_ms) VALUES (NEW.user_uuid, NEW.record_id, 'upsert', NEW.record_json, NEW.updated_at_ms); END;
      CREATE TRIGGER IF NOT EXISTS tracker_records_change_update AFTER UPDATE OF record_json, updated_at_ms ON tracker_records WHEN NEW.record_json <> OLD.record_json OR NEW.updated_at_ms <> OLD.updated_at_ms BEGIN INSERT INTO tracker_record_changes (user_uuid, record_id, change_type, record_json, record_updated_at_ms) VALUES (NEW.user_uuid, NEW.record_id, 'upsert', NEW.record_json, NEW.updated_at_ms); END;
      CREATE TRIGGER IF NOT EXISTS tracker_records_change_delete AFTER DELETE ON tracker_records BEGIN INSERT INTO tracker_record_changes (user_uuid, record_id, change_type, record_json, record_updated_at_ms) VALUES (OLD.user_uuid, OLD.record_id, 'delete', OLD.record_json, OLD.updated_at_ms); END;
    `,
    postgres: `
      LOCK TABLE tracker_records IN SHARE ROW EXCLUSIVE MODE;
      CREATE SEQUENCE IF NOT EXISTS tracker_record_changes_seq;
      CREATE TABLE IF NOT EXISTS jellyfin_tracker_bridge_state (
        user_uuid TEXT PRIMARY KEY,
        checkpoint_change_id BIGINT NOT NULL DEFAULT 0,
        updated_at_ms BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tracker_record_changes (
        change_id BIGINT PRIMARY KEY DEFAULT nextval('tracker_record_changes_seq'),
        user_uuid TEXT NOT NULL,
        record_id TEXT NOT NULL,
        change_type TEXT NOT NULL DEFAULT 'upsert',
        record_json TEXT,
        record_updated_at_ms BIGINT
      );
      CREATE TABLE IF NOT EXISTS jellyfin_tracker_bridge_rejections (
        user_uuid TEXT NOT NULL,
        change_id BIGINT NOT NULL,
        record_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        record_json TEXT,
        created_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, change_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_record_changes_user_cursor
        ON tracker_record_changes (user_uuid, change_id);
      INSERT INTO tracker_record_changes (user_uuid, record_id, record_json, record_updated_at_ms)
        SELECT user_uuid, record_id, record_json, updated_at_ms FROM tracker_records;
      CREATE OR REPLACE FUNCTION record_tracker_record_change() RETURNS TRIGGER AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_uuid, 901001)); INSERT INTO tracker_record_changes (user_uuid, record_id, change_type, record_json, record_updated_at_ms) VALUES (NEW.user_uuid, NEW.record_id, 'upsert', NEW.record_json, NEW.updated_at_ms); RETURN NEW; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS tracker_records_change_insert ON tracker_records;
      CREATE TRIGGER tracker_records_change_insert
        AFTER INSERT ON tracker_records
        FOR EACH ROW EXECUTE FUNCTION record_tracker_record_change();
      DROP TRIGGER IF EXISTS tracker_records_change_update ON tracker_records;
      CREATE TRIGGER tracker_records_change_update
        AFTER UPDATE OF record_json, updated_at_ms ON tracker_records
        FOR EACH ROW EXECUTE FUNCTION record_tracker_record_change();
      CREATE OR REPLACE FUNCTION record_deleted_tracker_record_change() RETURNS TRIGGER AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_uuid, 901001)); INSERT INTO tracker_record_changes (user_uuid, record_id, change_type, record_json, record_updated_at_ms) VALUES (OLD.user_uuid, OLD.record_id, 'delete', OLD.record_json, OLD.updated_at_ms); RETURN OLD; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS tracker_records_change_delete ON tracker_records;
      CREATE TRIGGER tracker_records_change_delete
        AFTER DELETE ON tracker_records
        FOR EACH ROW EXECUTE FUNCTION record_deleted_tracker_record_change();
    `,
  },
};
