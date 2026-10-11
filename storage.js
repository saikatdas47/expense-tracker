import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function postgresStatements(connection) {
  return {
    prepare(sql) {
      let position = 0;
      const text = sql.replace(/\?/g, () => '$' + ++position);
      return {
        async get(...values) { return (await connection.query(text, values)).rows[0]; },
        async all(...values) { return (await connection.query(text, values)).rows; },
        async run(...values) { return { changes: (await connection.query(text, values)).rowCount }; }
      };
    }
  };
}

export async function openStorage(path, databaseUrl) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10000, query_timeout: 10000 });
    // A failed idle connection should not crash the process or log credentials.
    pool.on('error', () => console.error(JSON.stringify({ error: 'database_connection' })));
    try { await pool.query(readFileSync(new URL('./schema-postgres.sql', import.meta.url), 'utf8')); }
    catch (error) { await pool.end(); throw error; }
    return {
      ...postgresStatements(pool),
      async transaction(userId, operation) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Serialize creates for the same account across processes before checking the receipt.
          await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
          const result = await operation(postgresStatements(client));
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      close: () => pool.end()
    };
  }
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const statements = { prepare: sql => sqlite.prepare(sql) };
  let queue = Promise.resolve();
  return {
    ...statements,
    transaction(userId, operation) {
      const result = queue.then(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const value = await operation(statements);
          sqlite.exec('COMMIT');
          return value;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      queue = result.catch(() => {});
      return result;
    },
    close: () => sqlite.close()
  };
}
