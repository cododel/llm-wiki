import type { SQL } from 'bun';
import { BrowserAuth } from '../auth/browser.ts';
import { Reader } from '../content/reads.ts';
import { approvePublication } from '../content/publication.ts';
import { idSchema } from '../content/schema.ts';
import { requireCondition } from './errors.ts';

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function html(body: string): Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Wiki publication approval</title><body><h1>Publication approval</h1>${body}</body></html>`,
    { headers: { 'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff' } });
}
export async function publicationPage(request: Request, db: SQL, browser: BrowserAuth, enabled: boolean) {
  requireCondition(enabled, 'disabled', 'Publication is disabled',404);
  const session = await browser.session(request);
  const id = new URL(request.url).searchParams.get('id');
  if (!id) {
    requireCondition(request.method === 'GET','invalid_method','GET required',405);
    const pending = await db<{ id: string; title: string }[]>`SELECT p.id,v.title FROM publication_requests p JOIN revisions v ON v.id=p.revision_id
      WHERE p.state='pending' AND p.expires_at>now() ORDER BY p.created_at LIMIT 100`;
    return html(`<ul>${pending.map(p => `<li><a href="/publications?id=${p.id}">${escape(p.title)}</a></li>`).join('')}</ul>`);
  }
  requireCondition(idSchema.safeParse(id).success,'not_found','Request unavailable',404);
  if (request.method === 'POST') {
    requireCondition(request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'),'invalid_input','Form encoding required');
    const form = new URLSearchParams(await request.text());
    browser.validateCsrf(request,session.csrf,form.get('csrf') ?? '');
    await approvePublication(db,session.identity,enabled,id);
    return html('<p>This exact revision is now public.</p><a href="/publications">Back</a>');
  }
  requireCondition(request.method === 'GET','invalid_method','GET required',405);
  const rows = await db<{ record_id:string;revision_id:string;state:string;attachments:string[];published_revision:string|null }[]>`
    SELECT p.record_id,p.revision_id,p.state,p.attachments,r.published_revision FROM publication_requests p JOIN records r ON r.id=p.record_id WHERE p.id=${id}`;
  requireCondition(rows.length,'not_found','Request unavailable',404);
  const row = rows[0]!, reader = new Reader(db,session.identity,{publicEnabled:enabled});
  const page = await reader.page(row.record_id,row.revision_id);
  const old = row.published_revision ? await reader.page(row.record_id,row.published_revision) : null;
  const jobs = await db<{ state:string;result:unknown }[]>`SELECT state,result FROM jobs WHERE revision_id=${row.revision_id} ORDER BY created_at DESC LIMIT 20`;
  return html(`<h2>${escape(page.title)}</h2><p>Request state: ${escape(row.state)}. Revision: ${row.revision_id}</p>
    <p>Factchecking informs your decision; it does not block publication.</p><h3>Check results</h3><pre>${escape(JSON.stringify(jobs,null,2))}</pre>
    <h3>Previous public revision</h3><pre>${escape(old ? JSON.stringify(old,null,2) : '(not published)')}</pre>
    <h3>Requested revision (complete content and metadata)</h3><pre>${escape(JSON.stringify(page,null,2))}</pre>
    <h3>Explicitly selected attachments</h3><ul>${row.attachments.map(hash=>`<li><a href="/attachments/${hash}">${hash}</a></li>`).join('')}</ul>
    <form method="post"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit">Publish this exact revision</button></form>`);
}
