import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerLaboratoryRoutes, type FetchRoute } from '../src/host/transport.js';
import { createLaboratoryApi } from '../src/client/transport.js';
import { LAB_METHODS } from '../src/shared/transport.js';
import { TracedLaboratory as Laboratory } from './support.js';
import { playSetup } from '../src/client/types.js';
function fixture(admin: (method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) {
  const routes = new Map<string, FetchRoute>();
  registerLaboratoryRoutes({ fetch: { register(route) { assert.ok(route.path.startsWith('/api/')); routes.set(route.path, route); } } }, admin);
  const connection = { rpc: { async call(channel: string, endpoint: string, payload: unknown) {
    // Desktop logical carrier admits only /api; unmatched POSTs reproduce 405.
    assert.equal(channel, '/api');
    const route = routes.get(`${channel}/${endpoint}`);
    if (!route) throw new Error('HTTP 405');
    const request = new Request(`http://dsh.internal${route.path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: endpoint, payload }) });
    const response = await route.fetch(request); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.type, 'server-response'); assert.equal(body.rpcId, 'test-rpc'); return body.result;
  } } };
  return { routes, api: createLaboratoryApi(connection) };
}
test('页面查看、开局、暂停和停止通过共享 /api 入口往返宿主', async () => {
  const lab = new Laboratory(path.resolve('.local/test-records'));
  const { routes, api } = fixture((m, p, s) => lab.admin(m, p, s));
  try {
    assert.equal(routes.size, LAB_METHODS.length);
    const initial = await api('view') as { observation: { status: string } }; assert.equal(initial.observation.status, 'ready');
    const display = await api('display') as {frame:{scene:object};observation:object};assert.ok(display.frame.scene);assert.ok(!('image' in display.observation));
    await api('start', { setup: playSetup() });
    const started = await api('view') as { observation: { status: string } }; assert.equal(started.observation.status, 'countdown');
    const paused = await api('pause') as { observation: { status: string } }; assert.equal(paused.observation.status, 'paused');
    const stopped = await api('stop') as { observation: { status: string } }; assert.equal(stopped.observation.status, 'stopped');
  } finally { await lab.dispose(); }
});
test('接口保留 RPC 关联标识并将宿主错误呈现为普通错误', async () => {
  const { api } = fixture(async () => { throw new Error('测试错误'); });
  await assert.rejects(api('view'), /测试错误/);
  await assert.rejects(api('truth'), /未知实验室请求/);
});
test('接口拒绝错误方法、畸形 JSON 与不匹配的 RPC 信封', async () => {
  let called = false; const { routes } = fixture(async () => { called = true; });
  const route = routes.get('/api/laboratory.view')!;
  assert.equal((await route.fetch(new Request('http://dsh.internal' + route.path))).status, 405);
  assert.equal((await route.fetch(new Request('http://dsh.internal' + route.path, { method: 'POST', body: '{}' }))).status, 415);
  for (const body of ['bad json', '{}', JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'laboratory.record' })]) {
    const result = await route.fetch(new Request('http://dsh.internal' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
    assert.equal(result.status, 400);
  }
  assert.equal(called, false);
});
test('发现旧宿主或未注册接口时给出明确诊断，不将旧构建当作就绪', async () => {
  const { api } = fixture(async () => ({ runtime: { buildId: 'old-host' } }));
  await assert.rejects(api('view'), /构建不一致/);
  await assert.rejects(api('display'), /构建不一致/);
  const missing = createLaboratoryApi({ rpc: { call: async () => { throw new Error('transport failure: HTTP 404'); } } });
  await assert.rejects(missing('view'), /托盘菜单/);
});
