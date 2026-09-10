import { mkdir, open, link, unlink, lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { sha256 } from './database.ts';
import { requireCondition } from '../runtime/errors.ts';
import { requireRole, type Identity } from '../auth/identity.ts';
import { hashSchema } from '../content/schema.ts';

function format(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes.subarray(0, 12)).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('255044462d')) return 'application/pdf';
  requireCondition(false, 'unsupported_format', 'Only PNG, JPEG and PDF originals are accepted');
}
function errorCode(error: unknown): unknown { return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined; }

export class BlobStore {
  readonly root: string;
  constructor(readonly db: SQL, directory: string, readonly maxBytes = 20 * 1024 * 1024) { this.root = resolve(directory); }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    requireCondition(!(await lstat(this.root)).isSymbolicLink(), 'invalid_storage', 'Blob directory cannot be a symlink');
    await mkdir(join(this.root, 'staging'), { recursive: true, mode: 0o700 });
    requireCondition(!(await lstat(join(this.root, 'staging'))).isSymbolicLink(), 'invalid_storage', 'Staging cannot be a symlink');
  }
  async ingest(identity: Identity, bytes: Uint8Array, declaredType: string, checksum: string) {
    requireRole(identity, 'personal');
    requireCondition(bytes.length > 0 && bytes.length <= this.maxBytes, 'invalid_size', 'Attachment exceeds size limit');
    const mediaType = format(bytes);
    const hash = sha256(bytes);
    requireCondition(mediaType === declaredType && hash === checksum, 'invalid_attachment', 'Format or checksum mismatch');
    await this.initialize();
    const temporary = join(this.root, 'staging', randomUUID());
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try {
      await this.db.begin(async tx => {
        // Reconciliation and finalization serialize on the same hash, including retries.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${hash},0))`;
        try { await link(temporary, join(this.root, hash)); }
        catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
        await this.readBytes(hash);
        const directory = await open(this.root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        await tx`INSERT INTO blobs(hash,size,media_type) VALUES(${hash},${bytes.length},${mediaType}) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO audit(actor,action,detail) VALUES(${identity.actor},'ingest_attachment',${{ hash, size: bytes.length, mediaType }}::jsonb)`;
      });
      return { hash, size: bytes.length, media_type: mediaType };
    } finally { await unlink(temporary); }
  }
  private async readBytes(hash: string): Promise<Uint8Array> {
    requireCondition(hashSchema.safeParse(hash).success, 'not_found', 'Attachment unavailable', 404);
    const path = join(this.root, hash);
    const stat = await lstat(path);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size <= this.maxBytes, 'invalid_attachment', 'Attachment integrity failure');
    const bytes = await readFile(path);
    requireCondition(sha256(bytes) === hash, 'invalid_attachment', 'Attachment integrity failure');
    return bytes;
  }
  async read(identity: Identity, enabled: boolean, hash: string) {
    requireCondition(hashSchema.safeParse(hash).success, 'not_found', 'Attachment unavailable', 404);
    const rows = await this.db<{ media_type: string }[]>`SELECT b.media_type FROM blobs b WHERE b.hash=${hash}
      AND (${identity.role !== 'public'} OR (${enabled} AND EXISTS(SELECT 1 FROM published_blobs p JOIN records r ON r.id=p.record_id
        WHERE p.hash=b.hash AND NOT r.archived AND r.published_revision IS NOT NULL)))`;
    requireCondition(rows.length, 'not_found', 'Attachment unavailable', 404);
    return { bytes: await this.readBytes(hash), mediaType: rows[0]!.media_type };
  }
  async cleanStaging(now = Date.now()) {
    await this.initialize();
    for (const name of await readdir(join(this.root, 'staging'))) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      const path = join(this.root, 'staging', name), stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs > 24 * 3600_000) await unlink(path);
    }
    for(const hash of await readdir(this.root)) {
      if(!hashSchema.safeParse(hash).success)continue;
      await this.db.begin(async tx=>{
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${hash},0))`;
        if((await tx`SELECT hash FROM blobs WHERE hash=${hash}`).length)return;
        const path=join(this.root,hash);
        let stat;
        try {stat=await lstat(path);}catch(error){if(errorCode(error)==='ENOENT')return;throw error;}
        if(stat.isFile()&&!stat.isSymbolicLink()&&now-stat.mtimeMs>24*3600_000)await unlink(path);
      });
    }
  }
}
