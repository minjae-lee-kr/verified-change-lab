import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT } from './support.ts';

const routes: Record<string, [string, string]> = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
  '/report.json': ['dist/report.json', 'application/json; charset=utf-8'],
};
const server = createServer(async (request, response) => {
  const route = routes[new URL(request.url ?? '/', 'http://127.0.0.1').pathname];
  if (!route || request.method !== 'GET') {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const content = await readFile(join(PROJECT, route[0]));
    response.writeHead(200, {
      'content-type': route[1],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(content);
  } catch {
    response
      .writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      .end('Run pnpm experiment to generate the local evidence report.');
  }
});
server.listen(4318, '127.0.0.1', () =>
  console.log('Read-only evidence report: http://127.0.0.1:4318 (no mutation endpoints)'),
);
