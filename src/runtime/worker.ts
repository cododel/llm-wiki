import { connect, migrate } from '../storage/database.ts';
import { seed } from '../storage/seed.ts';
import { BlobStore } from '../storage/blobs.ts';
import { Queue } from '../factcheck/queue.ts';
import { deliver } from '../delivery/outbox.ts';
import { loadConfig } from './config.ts';

if (import.meta.main) {
  const config = await loadConfig(), db = connect(config.databaseUrl);
  await migrate(db); await seed(db);
  const queue = new Queue(db,config.work), blobs = new BlobStore(db,config.blobDirectory);
  let stopping = false;
  process.once('SIGTERM',() => { stopping = true; }); process.once('SIGINT',() => { stopping = true; });
  try {
    while (!stopping) {
      try {
        await queue.recover();
        if (config.work.factcheck) await queue.detect(config.workerIdentity);
        await queue.scheduledReview(config.workerIdentity,config.reviewIntervalSeconds);
        await deliver(db,config.destinations);
        await blobs.cleanStaging();
        await db`DELETE FROM browser_flows WHERE expires_at<now()`;
        await db`DELETE FROM browser_sessions WHERE expires_at<now()`;
      } catch { console.error('Worker cycle failed; retained state will be retried'); }
      if (!stopping) await Bun.sleep(1000);
    }
  } finally { await db.close(); }
}
