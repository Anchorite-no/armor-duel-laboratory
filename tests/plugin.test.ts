import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject } from '../src/host/index.js';
import { LAB_METHODS } from '../src/shared/transport.js';
interface Tool { name: string; description: string; parameters: unknown; output: { schema: unknown; render(args: unknown, value: unknown): unknown[] }; execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown> }
test('游戏核心只等待通信，Agent 和附件服务缺失不会阻塞注册', async () => {
  assert.deepEqual(inject, ['connection']);
  const routes: string[] = [], disposers: (() => void | Promise<void>)[] = [];
  apply({
    effect: fn => { disposers.push(fn()); },
    connection: { fetch: { register: route => { routes.push(route.path); } } },
    inject: dependencies => { assert.deepEqual(dependencies, ['tools', 'attachments']); },
  });
  try { assert.equal(routes.length, LAB_METHODS.length); assert.ok(routes.includes('/api/laboratory.view')); }
  finally { for (const dispose of disposers.reverse()) await dispose(); }
});
test('DSH 注册使用原始 schema 子集，图像通过持久附件投影', async () => {
  const tools = new Map<string, Tool>();
  const disposers: (() => void | Promise<void>)[] = [];
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
  const check = (node: unknown) => {
    assert.ok(node && typeof node === 'object');
    const schema = node as Record<string, unknown>;
    for (const key of Object.keys(schema)) assert.ok(allowed.has(key), `0.2.2-rc.1 不支持 ${key}`);
    if (schema.type) assert.ok(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'].includes(schema.type as string));
    if (schema.properties) for (const child of Object.values(schema.properties)) check(child);
    if (schema.items) check(schema.items);
    if (schema.required) assert.ok(Array.isArray(schema.required));
  };
  apply({
    effect: fn => { disposers.push(fn()); },
    connection: { fetch: { register: () => {} } },
    inject: (_dependencies, callback) => callback({
      attachments: { saveImage: async input => { assert.equal(input.mediaType,'image/jpeg');assert.equal(input.data[0],255);assert.equal(input.data[1],216);return { attachmentId: 'test-jpeg', mediaType: input.mediaType, bytes: input.data.byteLength, width: 960, height: 680 };} },
      tools: { register: definition => { const t = definition as Tool; check(t.parameters); check(t.output.schema); tools.set(t.name, t); } },
    }),
  });
  try {
    assert.deepEqual([...tools.keys()], ['lab_observe', 'lab_act', 'lab_fire', 'lab_cancel']);
    const participantDocs=JSON.stringify([...tools.values()].map(({name,description,parameters})=>({name,description,parameters})));
    assert.doesNotMatch(participantDocs,/功率|底盘|装甲|血量|伤害|弹速|射速|准备期|炮塔|旋转优先|平方|960|680|525|800|240|rad\/s|autoAim|aimAssist/);
    const observe = tools.get('lab_observe')!;
    const value = await observe.execute({}, { signal: new AbortController().signal });
    const rendered = observe.output.render({}, value) as { type: string; text?: string; attachment?: { attachmentId: string } }[];
    assert.equal(rendered[1].type, 'image'); assert.equal(rendered[1].attachment?.attachmentId, 'test-jpeg');
    assert.ok(!rendered[0].text?.includes('base64')); assert.ok(!rendered[0].text?.includes('angle'));
    await assert.rejects(tools.get('lab_act')!.execute({ side: 'blue', action: {} }, { signal: new AbortController().signal }));
  } finally { for (const dispose of disposers.reverse()) await dispose(); }
});
