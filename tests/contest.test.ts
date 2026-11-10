import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ContestAttempt } from '../src/host/contest.js';
import { Laboratory } from '../src/host/service.js';
import { verifyContestRuntime } from '../src/host/program.js';
import { RULES } from '../src/shared/protocol.js';

const root = () => path.resolve('.local/contest-tests',randomUUID());
const signal = () => new AbortController().signal;

test('stdio MCP negotiates twelve tools and fire returns only a JPEG and frame ID', {timeout:15000}, async () => {
  const child = spawn(process.execPath,['--import','tsx','src/host/contest-mcp.ts','--side=blue'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const closed = once(child,'close');
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let id = 0;
  async function send(method: string, params?: object) {
    const requestId = ++id;
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');
    const line = await lines.next();
    assert.equal(line.done,false);
    const response = JSON.parse(line.value!);
    assert.equal(response.id,requestId);
    return response;
  }
  try {
    const init = await send('initialize',{protocolVersion:'2025-06-18'});
    assert.deepEqual(init.result.capabilities,{tools:{}});
    assert.match(init.result.instructions,/blue/);
    const tools = (await send('tools/list')).result.tools as {name:string;description:string}[];
    assert.deepEqual(tools.map(tool=>tool.name),
      ['lab_observe','lab_act','lab_fire','lab_cancel','lab_run_script','lab_stop_script','lab_script_log','lab_retry','lab_recordings','lab_recording_frame','lab_workspace_read','lab_workspace_write']);
    const descriptions = Object.fromEntries(tools.map(({name,description})=>[name,description]));
    for (const tool of ['lab_act','lab_run_script']) {
      const description = descriptions[tool];
      assert.match(description,/moveX、moveY.*\[-1,1\].*spin.*\[-1,1\]/);
      assert.match(description,/aimX、aimY.*\[0,1\].*场地.*HUD/);
      assert.match(description,/durationMs.*\[1,500\].*毫秒/);
    }
    assert.match(descriptions.lab_fire,/每次最多发一颗.*直接丢弃/);
    assert.match(descriptions.lab_run_script,/\{frameId, image: \{mimeType: "image\/jpeg", width, height, base64\}\}/);
    assert.match(descriptions.lab_run_script,/channels: 3, data: Uint8Array.*逐行.*R、G、B/);
    assert.equal((await send('resources/list')).error.code,-32601);
    assert.equal((await send('tools/call',{name:'lab_observe',arguments:{side:'red'}})).result.isError,true);
    assert.equal((await send('tools/call',{name:'lab_retry'})).result.isError,true);
    assert.equal((await send('tools/call',{name:'lab_fire',arguments:{minFireIntervalMs:1}})).result.isError,true);
    const {result} = await send('tools/call',{name:'lab_fire'});
    assert.equal(result.content.length,2);
    const [metadata,image] = result.content;
    assert.deepEqual(Object.keys(JSON.parse(metadata.text)),['frameId']);
    assert.equal(image.type,'image');
    assert.equal(image.mimeType,'image/jpeg');
    assert.deepEqual(Buffer.from(image.data,'base64').subarray(0,2),Buffer.from([255,216]));
  } finally {
    child.stdin.end();
    assert.equal((await closed)[0],0);
  }
});

test('retry saves the old referee evidence and starts a distinct round on the same settings', {timeout:30000}, async t => {
  const startClock = Laboratory.prototype.startClock;
  const labs = new Set<Laboratory>();
  t.mock.method(Laboratory.prototype,'startClock',function(this: Laboratory) {
    labs.add(this);
    return startClock.call(this);
  });
  const directory=root();
  const attempt = new ContestAttempt({directory,participantsDirectory:path.join(directory,'participants'),side:'red',opponent:'fixed',modelLabel:'example-model',reasoningEffortLabel:'example-effort'});
  let retry: ContestAttempt | undefined;
  try {
    await attempt.workspace!.write('notebook.md','跨局笔记');
    await attempt.workspace!.write('bot.js','await lab.log("saved");');
    await attempt.call('lab_observe',{});
    await assert.rejects(attempt.retry(signal()),/Participant request failed/);
    const [lab] = labs;
    lab.pump(performance.now()+RULES.preparationMs+RULES.durationMs+1000);
    retry = await attempt.retry(signal());
    assert.equal((await retry.workspace!.read('notebook.md')).content,'跨局笔记');
    assert.equal((await retry.workspace!.read('bot.js')).content,'await lab.log("saved");');
    const previous = JSON.parse(await readFile(path.join(attempt.directory,'result.json'),'utf8'));
    assert.ok(previous.matchId);
    assert.equal(previous.requestedModel,'example-model');
    assert.equal(previous.requestedReasoningEffort,'example-effort');
    assert.equal(previous.modelAttested,false);
    assert.equal(previous.usage,null);
    assert.equal(previous.setup.controllers.blue,'privileged');
    assert.deepEqual(previous.setup.privilegedAI.blue,{movement:'still',rotation:'still',shooting:'center'});
    assert.equal(previous.replayIdentical,true);
    await Promise.all([access(previous.recording.videoPath),access(previous.recording.dataPath)]);
    await retry.call('lab_observe',{});
    await retry.close();
    const next = JSON.parse(await readFile(path.join(retry.directory,'result.json'),'utf8'));
    assert.notEqual(next.matchId,previous.matchId);
    assert.deepEqual(next.setup,previous.setup);
    assert.equal(next.requestedReasoningEffort,'example-effort');
  } finally {
    try {await attempt.close();await retry?.close();}
    finally {await rm(directory,{recursive:true,force:true});}
  }
});

test('contest scripts decode JPEG, deny external resources and report clean errors', {timeout:20000}, async t => {
  try { verifyContestRuntime(); } catch { t.skip('Project-local Deno 2 is not installed'); return; }
  const directory = root();
  const marker = path.join(directory,'outside.mjs');
  await mkdir(directory,{recursive:true});
  await writeFile(marker,'export const marker = 1;');
  const attempt = new ContestAttempt({directory,participantsDirectory:path.join(directory,'participants'),modelId:'test-script',side:'red',opponent:'spinner'});
  async function run(code: string|undefined, status: 'error'|'ended') {
    await attempt.call('lab_run_script',code===undefined?{}:{code});
    for (let i=0;i<100;i++) {
      const result = await attempt.call('lab_script_log',{});
      assert.ok('value' in result);
      const info = result.value as {status:string;output:string};
      if (info.status!=='running') {
        assert.equal(info.status,status,info.output);
        return info.output;
      }
      await delay(30);
    }
    assert.fail('Script did not finish');
  }
  try {
    assert.match(await run('const = ;','error'),/SyntaxError: .+/);
    const runtimeError = await run(`throw new TypeError(${JSON.stringify(`probe ${marker}\ninternal stack`)});`,'error');
    assert.match(runtimeError,/TypeError: probe \[path\]/);
    assert.doesNotMatch(runtimeError,/outside|internal stack|runner\.mjs/);
    const output = await run(`
      const o = await lab.observe();
      const pixels = lab.pixels(o);
      await lab.log(JSON.stringify([Object.keys(o),pixels.width,pixels.height,pixels.channels]));
      const denied = [];
      for (const [kind,probe] of Object.entries({
        read:()=>Deno.readTextFile(${JSON.stringify(marker)}),
        write:()=>Deno.writeTextFile('probe.txt','probe'),
        net:()=>Deno.connect({hostname:'127.0.0.1',port:9}),
        run:()=>new Deno.Command('cmd.exe',{args:['/c','exit']}).output(),
        env:()=>Deno.env.get('PATH'),
        import:()=>import(${JSON.stringify(new URL(`file:///${marker.replaceAll('\\','/')}`).href)}),
      })) {
        try { await probe(); throw Error('Permission unexpectedly granted: '+kind); }
        catch (e) { if (!/permission|access|dynamically import/i.test(String(e))) throw e; denied.push(kind); }
      }
      await lab.log(denied.join(','));
    `,'ended');
    assert.match(output,/\[\["frameId","image"\],960,680,3\]/);
    assert.match(output,/read,write,net,run,env,import/);
    assert.match((await attempt.workspace!.read('bot.js')).content!,/lab\.pixels/);
    await attempt.workspace!.write('bot.js','await lab.log("saved bot");');
    assert.match(await run(undefined,'ended'),/saved bot/);
  } finally {try {await attempt.close();} finally {await rm(directory,{recursive:true,force:true});}}
});
