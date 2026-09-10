import { createHmac, randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { canonical } from '../content/schema.ts';
import { emitEvent } from '../factcheck/queue.ts';
export interface Destination { url: string; secret: string }
export type Destinations = Partial<Record<'factcheck' | 'review' | 'notification', Destination>>;
export async function deliver(db: SQL, destinations: Destinations, fetcher: typeof fetch = fetch) {
  for (const channel of ['factcheck','review','notification'] as const) {
    const target = destinations[channel];
    if (!target) continue;
    const token = randomUUID();
    const claimed = await db.begin(async tx => {
      const rows = await tx<{ id: string; payload: Record<string, unknown>; attempts: number }[]>`
        SELECT id,payload,attempts FROM outbox WHERE channel=${channel} AND
        ((state='pending' AND available_at<=now()) OR (state='sending' AND lease_until<now()))
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!rows.length) return null;
      await tx`UPDATE outbox SET state='sending',lease_token=${token},lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE id=${rows[0]!.id}`;
      return rows[0]!;
    });
    if (!claimed) continue;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = canonical({ ...claimed.payload, event_id: claimed.id });
    const signature = createHmac('sha256', target.secret).update(`${timestamp}.${body}`).digest('hex');
    let success = false;
    try {
      const response = await fetcher(target.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'X-Wiki-Event': claimed.id, 'X-Wiki-Timestamp': timestamp, 'X-Wiki-Signature': `sha256=${signature}` }, body });
      success = response.ok;
      await response.body?.cancel();
    } catch { /* Delivery failure is recorded independently from workflow completion. */ }
    await db.begin(async tx => {
      const state = success ? 'delivered' : claimed.attempts >= 4 ? 'failed' : 'pending';
      const changed = await tx`UPDATE outbox SET state=${state},lease_token=NULL,available_at=now()+${Math.min(3600, 2 ** claimed.attempts * 30)}*interval '1 second'
        WHERE id=${claimed.id} AND state='sending' AND lease_token=${token} RETURNING id`;
      if (changed.length && state === 'failed') {
        if (channel === 'notification') await tx`INSERT INTO events(id,kind,detail) VALUES(${randomUUID()},'notification_failure',${{ event_id: claimed.id }}::jsonb)`;
        else await emitEvent(tx, null, 'delivery_failure', { event_id: claimed.id, channel });
      }
    });
  }
}
