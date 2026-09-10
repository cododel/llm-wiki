import { connect, migrate } from '../storage/database.ts';
import { seed } from '../storage/seed.ts';
import { BlobStore } from '../storage/blobs.ts';
import { authenticate } from '../auth/identity.ts';
import { BrowserAuth } from '../auth/browser.ts';
import { createMcp } from '../mcp/server.ts';
import { loadConfig, type Config } from './config.ts';
import { errorResult, requireCondition } from './errors.ts';
import { publicationPage } from './publication-page.ts';
import type { SQL } from 'bun';
const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');

export function handler(db: SQL, config: Config) {
  const blobs = new BlobStore(db,config.blobDirectory), browser = new BrowserAuth(db,config.auth,config.browser);
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      requireCondition(request.headers.get('host') === new URL(config.origin).host,'invalid_host','Unexpected host',400);
      requireCondition(!request.headers.get('origin') || request.headers.get('origin') === config.origin,'invalid_origin','Unexpected origin',403);
      if (url.pathname === '/health') return Response.json({ status:'ok' });
      if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') return Response.json({ resource:config.auth.audience,authorization_servers:[config.auth.issuer],scopes_supported:['wiki:read','wiki:write','wiki:factcheck'] });
      if (url.pathname === '/auth/login' && request.method === 'GET') return await browser.start();
      if (url.pathname === '/auth/callback' && request.method === 'GET') return await browser.callback(request);
      if (url.pathname === '/publications') return await publicationPage(request,db,browser,config.publicationEnabled);
      const identity = await authenticate(request,config.auth);
      if (url.pathname.startsWith('/attachments/') && request.method === 'GET') {
        const attachmentIdentity = identity.role === 'public' && request.headers.get('cookie')?.includes('__Host-wiki-session=')
          ? (await browser.session(request)).identity : identity;
        const asset = await blobs.read(attachmentIdentity,config.publicationEnabled,url.pathname.slice('/attachments/'.length));
        return new Response(asset.bytes,{headers:{'Content-Type':asset.mediaType,'Content-Disposition':'attachment','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});
      }
      requireCondition(url.pathname === '/mcp','not_found','Resource unavailable',404);
      requireCondition(identity.role !== 'public' || config.publicationEnabled,'unauthorized','Authentication required',401);
      const server = createMcp({db,identity,publicationEnabled:config.publicationEnabled,work:config.work,blobs});
      const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      await server.connect(transport);
      try { return await transport.handleRequest(request); } finally { await server.close(); }
    } catch (error) {
      const result = errorResult(error);
      const headers: Record<string,string> = { 'Cache-Control':'no-store' };
      if (result.status === 401) headers['WWW-Authenticate'] = `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp"`;
      return Response.json({error:result},{status:result.status,headers});
    }
  };
}
if (import.meta.main) {
  const config = await loadConfig(), db = connect(config.databaseUrl);
  await migrate(db); await seed(db);
  const server = Bun.serve({port:config.port,hostname:'0.0.0.0',maxRequestBodySize:30_000_000,fetch:handler(db,config)});
  async function stop() { await server.stop(true); await db.close(); }
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
