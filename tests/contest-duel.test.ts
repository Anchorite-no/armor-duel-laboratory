import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { verifyContestRuntime } from '../src/host/program.js';
import { duelRequest } from '../src/host/contest-duel-transport.js';

const source=(name:string)=>['--import','tsx',`src/host/${name}.ts`];
const neutralScript=`const image=await lab.observe(); await lab.log(lab.side+':'+image.image.mimeType);`;
const overheats=`${neutralScript} await lab.sleep(5000); for(let i=0;i<85;i++){await lab.fire();await lab.sleep(55);}`;

function connect(seat:object) {
  const child=spawn(process.execPath,[...source('contest-mcp'),'--duel'],{stdio:['pipe','pipe','inherit'],windowsHide:true,
    env:{...process.env,LAB_DUEL_SEAT:JSON.stringify(seat)}});
  const closed=once(child,'close');
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let id=0;
  return {
    async send(method:string,params?:object) {
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++id,method,params})+'\n');
      const {value}=await lines.next();
      assert.ok(value);const reply=JSON.parse(value);assert.equal(reply.id,id);return reply.result;
    },
    async close(){child.stdin.end();assert.equal((await closed)[0],0);},
  };
}

test('shared MCP duel draws, saves common evidence, then stops on the first blue win',{timeout:115_000},async()=>{
  verifyContestRuntime();
  const parent=path.resolve('.local/contest-tests');
  await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(path.join(parent,'duel-'));
  const descriptor=path.join(directory,'session.json');
  const host=spawn(process.execPath,[...source('contest-duel-main'),'serve',descriptor,'test-red','test-blue'],{
    stdio:['ignore','pipe','inherit'],windowsHide:true,env:{...process.env,LAB_PARTICIPANT_DIRECTORY:path.join(directory,'participants')}});
  const closed=once(host,'close');
  const lines=createInterface({input:host.stdout});
  const clients:ReturnType<typeof connect>[]=[];
  let stop:(()=>Promise<unknown>)|undefined;
  try {
    const [startup]=await once(lines,'line');
    assert.equal(JSON.parse(startup).phase,'waiting');
    const keys=JSON.parse(await readFile(descriptor,'utf8'));
    const red=connect({endpoint:keys.endpoint,side:'red',key:keys.red});
    const blue=connect({endpoint:keys.endpoint,side:'blue',key:keys.blue});
    const mismatch=connect({endpoint:keys.endpoint,side:'blue',key:keys.red});
    clients.push(red,blue,mismatch);
    const owner=(command:string,key=keys.owner)=>duelRequest(keys.endpoint,'owner',key,{command},AbortSignal.timeout(30_000));
    stop=()=>owner('stop');
    const call=(client:typeof red,name:string,args:object={})=>client.send('tools/call',{name,arguments:args});
    const data=async(client:typeof red,name:string,args:object={})=>{
      const reply=await call(client,name,args);assert.ok(!reply.isError,reply.content[0].text);return JSON.parse(reply.content[0].text);
    };
    const ready=(client:typeof red)=>data(client,'lab_ready',{mode:'script'});
    const write=(client:typeof red,file:string,content:string)=>data(client,'lab_workspace_write',{file,content});
    const wait=async(check:()=>Promise<boolean>,timeout:number)=>{
      const deadline=Date.now()+timeout;
      while (!await check()) {assert.ok(Date.now()<deadline,'Timed out waiting for duel state');await delay(100);}
    };
    for (const [client,side] of [[red,'red'],[blue,'blue'],[mismatch,'blue']] as const) {
      assert.match((await client.send('initialize')).instructions,new RegExp(`席位是 ${side}`));
      const {tools}=await client.send('tools/list');
      assert.ok(tools.some((tool:{name:string})=>tool.name==='lab_ready'));
      assert.ok(!tools.some((tool:{name:string})=>tool.name==='lab_retry'));
    }
    assert.equal((await call(mismatch,'lab_workspace_read',{file:'notebook.md'})).isError,true);
    assert.equal((await owner('start',keys.blue)).status,403);
    assert.equal((await owner('start')).status,400);
    const preview=await call(red,'lab_observe');
    assert.deepEqual(preview.content[0],{type:'text',text:'{"frameId":0}'});
    assert.equal(preview.content[1].mimeType,'image/jpeg');
    assert.deepEqual((await call(blue,'lab_observe')).content,preview.content);
    assert.equal((await owner('status')).value.round,0);
    assert.equal((await owner('status')).value.phase,'waiting');
    assert.deepEqual(await data(blue,'lab_recordings'),{recordings:[],saving:false});
    assert.equal((await call(blue,'lab_fire')).isError,true);
    await write(red,'notebook.md','红方私有');
    assert.equal((await data(blue,'lab_workspace_read',{file:'notebook.md'})).content,'');
    assert.equal((await call(blue,'lab_workspace_read',{file:'notebook.md',side:'red'})).isError,true);
    await Promise.all([write(red,'bot.js',neutralScript),write(blue,'bot.js',neutralScript)]);
    await Promise.all([ready(red),ready(blue)]);
    await write(red,'bot.js',neutralScript);
    assert.equal((await owner('start')).status,400);
    await ready(red);
    const first=(await owner('start')).value;
    assert.equal(first.phase,'playing');
    await wait(async()=>{
      const [redFrame,blueFrame]=await Promise.all([call(red,'lab_observe'),call(blue,'lab_observe')]);
      assert.equal(redFrame.content[1].mimeType,'image/jpeg');
      assert.equal(blueFrame.content[1].mimeType,'image/jpeg');
      if (redFrame.content[0].text!==blueFrame.content[0].text) return false;
      assert.deepEqual(redFrame.content,blueFrame.content);
      return true;
    },4000);
    await wait(async()=>{
      const [redLog,blueLog]=await Promise.all([data(red,'lab_script_log'),data(blue,'lab_script_log')]);
      assert.doesNotMatch(redLog.output,/blue:/);
      assert.doesNotMatch(blueLog.output,/red:/);
      return redLog.output.includes('red:image/jpeg') && blueLog.output.includes('blue:image/jpeg');
    },5000);
    await wait(async()=>{
      const {value}=await owner('status');
      assert.notEqual(value.phase,'error',value.detail);
      return value.phase==='review' && value.winner==='draw';
    },78_000);
    const shared=await data(red,'lab_recordings');
    assert.deepEqual((await call(blue,'lab_observe')).content,preview.content);
    assert.deepEqual(await data(blue,'lab_recordings'),shared);
    assert.equal(shared.recordings.length,1);
    const imageArgs={recordingName:shared.recordings[0].recordingName,timestampMs:0};
    const [reviewed,blueReview]=await Promise.all([call(red,'lab_recording_frame',imageArgs),call(blue,'lab_recording_frame',imageArgs)]);
    assert.equal(reviewed.content[1].mimeType,'image/jpeg');
    assert.deepEqual(blueReview.content,reviewed.content);
    assert.equal((await owner('start')).status,400);
    await write(red,'bot.js',overheats);
    await Promise.all([ready(red),ready(blue)]);
    const second=(await owner('start')).value;
    assert.notEqual(first.matchId,second.matchId);
    await wait(async()=>{
      const {value}=await owner('status');
      assert.notEqual(value.phase,'error',value.detail);
      return value.phase==='complete' && value.winner==='blue';
    },24_000);
    assert.equal((await call(blue,'lab_ready',{mode:'script'})).isError,true);
    assert.equal((await owner('start')).status,400);
    const rounds=path.join(directory,'session.json.rounds');
    const saved=await Promise.all((await readdir(rounds)).filter(name=>/^\d+-/.test(name)).sort().map(async name=>{
      const result=JSON.parse(await readFile(path.join(rounds,name,'result.json'),'utf8'));
      await Promise.all([access(result.recording.videoPath),access(result.recording.dataPath),access(path.join(rounds,name,'tools.ndjson'))]);
      assert.equal(result.replayIdentical,true);
      return result;
    }));
    assert.deepEqual(saved.map(result=>result.winner),['draw','blue']);
    assert.deepEqual([saved[0].finalTick,saved[0].finalStep],[14_400,15_600]);
  } finally {
    await Promise.allSettled(clients.map(client=>client.close()));
    if (stop) await stop().catch(()=>host.kill()); else host.kill();
    await closed;
    assert.equal(path.dirname(directory),parent);
    assert.ok(path.basename(directory).startsWith('duel-'));
    await rm(directory,{recursive:true,force:true});
  }
});

test('reuses a stopped legacy endpoint and seats, and completes at the configured round limit',{timeout:55_000},async()=>{
  verifyContestRuntime();
  const parent=path.resolve('.local/contest-tests');
  await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(path.join(parent,'duel-reuse-'));
  const descriptor=path.join(directory,'session.json');
  const oldEvidence=path.join(descriptor+'.rounds','1-00000000-0000-4000-8000-000000000001');
  const evidence=path.join(directory,'extra-rounds');
  const seats={red:'example-red',blue:'example-1.2-blue'};
  const env={...process.env,LAB_PARTICIPANT_DIRECTORY:path.join(directory,'participants')};
  const argumentsFor=(red:string,blue:string,...flags:string[])=>[...source('contest-duel-main'),'serve',descriptor,red,blue,...flags];
  const flags=['--reuse-session',`--evidence-directory=${evidence}`,'--stop-on-blue-win=false','--max-rounds=2'];
  const run=promisify(execFile);
  const clients:ReturnType<typeof connect>[]=[];
  let host:ReturnType<typeof spawn>|undefined;
  let closed:Promise<unknown[]>|undefined;
  let stop:(()=>Promise<unknown>)|undefined;
  const serve=async(...args:string[])=>{
    const child=spawn(process.execPath,args,{stdio:['ignore','pipe','inherit'],windowsHide:true,env});
    host=child;
    closed=once(child,'close');
    const lines=createInterface({input:child.stdout});
    const [line]=await Promise.race([once(lines,'line'),closed.then(()=>{throw Error('Duel host exited before readiness');})]);
    assert.equal(JSON.parse(line).phase,'waiting');
  };
  try {
    await serve(...argumentsFor(seats.red,seats.blue));
    const original=JSON.parse(await readFile(descriptor,'utf8'));
    assert.deepEqual(original.seats,seats);
    const {seats:_bindings,...legacy}=original;
    const legacyContents=JSON.stringify(legacy);
    await writeFile(descriptor,legacyContents);
    await mkdir(oldEvidence,{recursive:true});
    const journal=path.join(oldEvidence,'tools.ndjson');
    const originalAudit=JSON.stringify({type:'attempt',round:1,seats})+'\n';
    await writeFile(journal,originalAudit);
    const owner=async(command:string)=>duelRequest(legacy.endpoint,'owner',legacy.owner,{command},AbortSignal.timeout(10_000));
    stop=()=>owner('stop');
    await assert.rejects(run(process.execPath,argumentsFor(seats.red,seats.blue,...flags),{env}),/original duel host is still active/);
    await assert.rejects(access(evidence));
    for (const side of ['red','blue'] as const) {
      const client=connect({endpoint:legacy.endpoint,side,key:legacy[side]});
      clients.push(client);
      await client.send('initialize');
    }
    const [red,blue]=clients;
    const call=async(client:typeof red,name:string,args:object={})=>{
      const reply=await client.send('tools/call',{name,arguments:args});
      assert.ok(!reply.isError,reply.content[0].text);
      return JSON.parse(reply.content[0].text);
    };
    await call(red,'lab_workspace_write',{file:'notebook.md',content:'red note'});
    await call(blue,'lab_workspace_write',{file:'notebook.md',content:'blue note'});
    await call(red,'lab_workspace_write',{file:'bot.js',content:overheats});
    await call(blue,'lab_workspace_write',{file:'bot.js',content:neutralScript});
    await stop();
    assert.equal((await closed!)[0],0);
    await assert.rejects(run(process.execPath,argumentsFor(seats.blue,seats.red,...flags),{env}),/keep the original seat bindings/);
    await assert.rejects(run(process.execPath,argumentsFor(seats.red,seats.blue,'--reuse-session',`--evidence-directory=${oldEvidence}`),{env}),/outside the original round directory/);
    await serve(...argumentsFor(seats.red,seats.blue,...flags));
    assert.equal(await readFile(descriptor,'utf8'),legacyContents);
    assert.equal(await readFile(journal,'utf8'),originalAudit);
    assert.equal((await call(red,'lab_workspace_read',{file:'notebook.md'})).content,'red note');
    assert.equal((await call(blue,'lab_workspace_read',{file:'notebook.md'})).content,'blue note');
    for (const phase of ['review','complete']) {
      await Promise.all(clients.map(client=>call(client,'lab_ready',{mode:'script'})));
      assert.equal((await owner('start')).status,200);
      const deadline=Date.now()+18_000;
      for (;;) {
        const {value}=await owner('status');
        assert.notEqual(value.phase,'error',value.detail);
        if (value.phase===phase) {assert.equal(value.winner,'blue');break;}
        assert.ok(Date.now()<deadline,'Timed out waiting for series to settle');
        await delay(100);
      }
    }
    assert.equal((await owner('start')).status,400);
    assert.equal((await call(blue,'lab_recordings')).recordings.length,2);
  } finally {
    await Promise.allSettled(clients.map(client=>client.close()));
    if (host && host.exitCode===null) {
      if (stop) await stop().catch(()=>host?.kill()); else host.kill();
    }
    await closed;
    assert.equal(path.dirname(directory),parent);
    assert.match(path.basename(directory),/^duel-reuse-/);
    await rm(directory,{recursive:true,force:true});
  }
});
