// Local QA adapter for the same host service. Production remains a native DSH plugin.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Laboratory } from '../src/host/service.js';
import path from 'node:path';
const lab = new Laboratory(path.resolve('.local/referee')); lab.startClock();
const server = createServer(async (req, res) => {
  if (req.headers.host !== '127.0.0.1:4319') { res.writeHead(403); res.end(); return; }
  if (req.method === 'POST' && req.url?.startsWith('/preview/')) {
    if (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:4319') { res.writeHead(403); res.end(); return; }
    let body = ''; for await (const part of req) { body += part; if (body.length > 100000) { res.writeHead(413); res.end(); return; } }
    try { const value = await lab.admin(req.url.slice('/preview/'.length), JSON.parse(body || '{}')); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, value })); }
    catch (error) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: String(error) })); }
    return;
  }
  if (req.url === '/preview.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile('dist/preview.js')); return; }
  if (req.url !== '/') { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>实验室 · UI 验证</title><style>html,body,#root{margin:0;height:100%;background:#101820}</style><div id="root"></div><script type="module" src="/preview.js"></script></html>');
});
server.listen(4319, '127.0.0.1', () => console.log('QA preview: http://127.0.0.1:4319'));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void lab.dispose().then(() => { server.close(); process.exit(); }); });
