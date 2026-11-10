// Exercise the REAL installed Cordis lifecycle, without booting DSH, a GUI,
// credentials, models, profiles, or a listening network server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { read, list } from './installed-archive.mjs';
import {spawnSync} from 'node:child_process';
const project = fileURLToPath(new URL('..', import.meta.url));
const cache = path.join(project, '.local/sdk-lifecycle/node_modules/@deepseek-ai');
for (const pkg of ['cordis', 'cosmokit']) {
  const source = '/dsh/node_modules/@deepseek-ai/' + pkg;
  const destination = path.join(cache, pkg);
  function extract(entry, relative = '') {
    for (const name of list(entry)) {
      const at = entry + '/' + name, suffix = path.join(relative, name);
      if (list(at).length) extract(at, suffix);
      else if (/\.(?:js|json|mjs|cjs)$/.test(name)) {
        const output = path.join(destination, suffix);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, read(at));
      }
    }
  }
  extract(source);
}
const { Context } = await import(pathToFileURL(path.join(cache, 'cordis/lib/index.js')).href);
const plugin = await import(new URL('../bundle/index.js', import.meta.url).href);
assert.deepEqual(plugin.inject, ['connection'], '游戏后端不能等待 Agent / 附件服务');
const ctx = new Context(), routes = new Map(), tools = [];
ctx.provide('connection', { fetch: { register(route) { assert.ok(route.path.startsWith('/api/')); routes.set(route.path, route); } } });
let fiber;
try {
  fiber = await ctx.plugin(plugin);
  assert.equal(routes.size, 16, '只提供 connection 时，必须立即注册游戏接口');
  const route = routes.get('/api/laboratory.view');
  const response = await route.fetch(new Request('http://dsh.internal/api/laboratory.view', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'lifecycle-test', method: 'laboratory.view', payload: {} }),
  }));
  assert.equal(response.status, 200);
  const message = await response.json(); assert.equal(message.result.ok, true); assert.equal(message.result.value.observation.status, 'ready');
  const display = await routes.get('/api/laboratory.display').fetch(new Request('http://dsh.internal/api/laboratory.display', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'client-request',rpcId:'display-test',method:'laboratory.display',payload:{}}),
  }));
  assert.equal(display.status,200);const frame=await display.json();assert.equal(frame.result.ok,true);
  assert.equal(frame.result.value.frame.scene.robots.blue.hp,200);assert.equal(frame.result.value.frame.scene.tuning.power,50);assert.ok(!('image' in frame.result.value.observation));
  assert.equal(frame.result.value.frame.scene.robots.red.x,210);assert.equal(frame.result.value.frame.scene.robots.blue.x,750);
  ctx.provide('tools', { register(tool) { tools.push(tool); } });
  ctx.provide('attachments', { saveImage: async () => ({ attachmentId: 'test' }) });
  for (let i = 0; i < 10 && tools.length !== 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(tools.map(tool => tool.name), ['lab_observe', 'lab_act', 'lab_fire', 'lab_cancel']);
  assert.doesNotMatch(JSON.stringify(tools.map(({description,parameters})=>({description,parameters}))),/功率|装甲|弹速|准备期|炮塔|旋转优先|960|680|525|800|240|rad\/s|aimAssist|autoAim/);
  const observation=await tools.find(tool=>tool.name==='lab_observe').execute({}, {signal:new AbortController().signal});
  assert.equal(observation.image.mimeType,'image/jpeg');assert.deepEqual(Object.keys(observation).sort(),['attachment','frameId','image']);
  const bytes=Buffer.from(observation.image.base64,'base64');assert.equal(bytes[0],255);assert.equal(bytes[1],216);
  const owner=async(method,payload)=>{
    const endpoint='laboratory.'+method;
    const response=await routes.get('/api/'+endpoint).fetch(new Request('http://dsh.internal/api/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'recording-check',method:endpoint,payload})}));
    const result=await response.json();assert.equal(result.result.ok,true,result.result.error?.message);return result.result.value;
  };
  await owner('start',{setup:{clock:'stepped',scenario:'duel',targetSpin:0,recording:true,controllers:{red:'idle',blue:'agent'}}});
  await tools.find(tool=>tool.name==='lab_act').execute({side:'blue',action:{moveX:0,moveY:0,spin:0,aimX:.5,aimY:.5,durationMs:100}},{signal:new AbortController().signal});
  const fireFrame=await tools.find(tool=>tool.name==='lab_fire').execute({side:'blue'},{signal:new AbortController().signal});
  assert.equal(fireFrame.image.mimeType,'image/jpeg');assert.deepEqual(Object.keys(fireFrame).sort(),['attachment','frameId','image']);
  let stopped=await owner('stop',{});
  const deadline=Date.now()+10000;
  while(stopped.recording.status==='saving'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,25));stopped=await owner('view',{});}
  assert.equal(stopped.recording.status,'saved',stopped.recording.error);
  const movie=fs.readFileSync(stopped.recording.videoPath);assert.equal(movie.toString('ascii',4,8),'ftyp');
  const decoded=spawnSync(path.join(project,'bundle/ffmpeg.exe'),['-v','error','-i',stopped.recording.videoPath,'-f','null','-'],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(decoded.status,0,decoded.stderr);
  assert.equal(routes.size, 16, '可选服务到达时不能重置游戏或重复注册接口');
  console.log('Installed Cordis lifecycle: 16 owner routes; view/display HTTP 200; 4 optional tools; shared JPEG and MP4 verified, MP4 fully decoded. No app opened.');
} finally { if (fiber) await fiber.dispose(); await ctx.fiber.dispose(); }
