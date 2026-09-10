import { SQL, type TransactionSQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export type Transaction = TransactionSQL;
export type Database = SQL | Transaction;
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function connect(url: string): SQL {
  if (!/^postgres(?:ql)?:\/\//.test(url)) throw new Error('PostgreSQL DATABASE_URL required');
  return new SQL(url, { max: 10, connectionTimeout: 10, idleTimeout: 20 });
}

export async function migrate(db: SQL): Promise<void> {
  const directory = new URL('../../migrations/', import.meta.url);
  await db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(71822001)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)`;
    for (const name of (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort()) {
      const source = await Bun.file(new URL(name, directory)).text();
      const checksum = sha256(source);
      const applied = await tx`SELECT checksum FROM schema_migrations WHERE name = ${name}`;
      if (applied.length) {
        if (applied[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      // Only packaged, versioned migration SQL is executed without parameter binding.
      await tx.unsafe(source).simple();
      await tx`INSERT INTO schema_migrations(name,checksum) VALUES (${name},${checksum})`;
    }
  });
}
