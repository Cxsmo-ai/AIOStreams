import Database from '../packages/core/node_modules/better-sqlite3/lib/index.js';

const db = new Database('/app/data/db.sqlite');
const rows = db
  .prepare(
    `SELECT nzb_hash, release_key
      FROM usenet_library
      WHERE status = 'failed'
        AND last_used_at >= '2026-08-09 17:45:00'
        AND release_key IS NULL`
  )
  .all();

if (process.env.APPLY !== 'true') {
  const summary = db
    .prepare(
      `SELECT status, substr(release_key, 1, 4) AS key_type, count(*) AS count,
              max(last_used_at) AS last_used_at
         FROM usenet_library
        GROUP BY status, substr(release_key, 1, 4)
        ORDER BY status, key_type`
    )
    .all();
  console.log(
    JSON.stringify({ matchingFailures: rows.length, applied: false, summary })
  );
  process.exit(0);
}

const deleteRows = db.transaction(() => {
  let aliases = 0;
  let library = 0;
  let verdicts = 0;
  const releaseKeys = new Set();
  for (const row of rows) {
    aliases += db
      .prepare(
        'DELETE FROM usenet_library_aliases WHERE nzb_hash = ? OR alias_hash = ?'
      )
      .run(row.nzb_hash, row.nzb_hash).changes;
    library += db
      .prepare('DELETE FROM usenet_library WHERE nzb_hash = ?')
      .run(row.nzb_hash).changes;
    if (row.release_key) releaseKeys.add(row.release_key);
  }
  for (const releaseKey of releaseKeys) {
    verdicts += db
      .prepare(
        `DELETE FROM release_blocklist_entries
          WHERE source_rid = (
            SELECT rid FROM release_blocklist_sources WHERE id = 'local'
          )
            AND key_id = (
              SELECT id FROM release_blocklist_keys WHERE k = ?
            )`
      )
      .run(releaseKey).changes;
  }
  verdicts += db
    .prepare(
      `DELETE FROM release_blocklist_entries
        WHERE source_rid = (
          SELECT rid FROM release_blocklist_sources WHERE id = 'local'
        )
          AND last_at >= CAST(strftime('%s', '2026-08-09 17:45:00') AS INTEGER)
          AND key_id IN (
            SELECT id FROM release_blocklist_keys WHERE k LIKE 'nh1:%'
          )`
    )
    .run().changes;
  db.prepare(
    `DELETE FROM release_blocklist_keys
      WHERE k LIKE 'nh1:%'
        AND NOT EXISTS (
          SELECT 1 FROM release_blocklist_entries WHERE key_id = release_blocklist_keys.id
        )`
  ).run();
  return { aliases, library, verdicts };
});

console.log(
  JSON.stringify({ matchingFailures: rows.length, applied: true, ...deleteRows() })
);
