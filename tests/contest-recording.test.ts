import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { MatchRecorder, ffmpegPath, recordingStem } from '../src/host/recorder.js';
import { PROVISIONAL_VISION } from '../src/shared/vision.js';
import { paintScene, type Painter } from '../src/shared/scene.js';
import { Game } from '../src/host/game.js';
import { RULES } from '../src/shared/protocol.js';

test('Beijing naming is fixed at start and reserves same-second suffixes without overwriting', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'lab-recording-name-'));
  const existing=path.join(dir,'20240102_000102.mp4');
  const a=new MatchRecorder(dir),b=new MatchRecorder(dir);
  try {
    await writeFile(existing,'preserve');
    const start=new Date('2024-01-01T16:01:02.900Z');
    assert.equal(recordingStem(start),'20240102_000102');
    await Promise.all([a.start('a',PROVISIONAL_VISION,start),b.start('b',PROVISIONAL_VISION,start)]);
    assert.deepEqual([a.info().recordingName,b.info().recordingName].sort(),['20240102_000102_2.mp4','20240102_000102_3.mp4']);
    assert.equal(await readFile(existing,'utf8'),'preserve');
    assert.equal(a.info().startedAt,start.toISOString());
  } finally {await Promise.all([a.dispose(),b.dispose()]);await rm(dir,{recursive:true,force:true});}
});

test('shared painter renders 5 to 1 and removes the large count at battle start',()=>{
  const game=new Game();
  game.start({clock:'stepped',scenario:'duel',targetSpin:0,controllers:{red:'idle',blue:'idle'}});
  const numbers:string[]=[];
  const painter:Painter={pixel(){},rect(){},circle(){},line(){},text(s,x,y,_c,size){
    if(size==='countdown'){assert.ok(x>400&&x<480&&y>250&&y<330);numbers.push(s);}
  }};
  for(let second=0;second<5;second++){paintScene(game.display(),painter);game.advance(RULES.tickHz);}
  paintScene(game.display(),painter);
  assert.deepEqual(numbers,['5','4','3','2','1']);
});

// The subprocess uses the real MCP transport and recorder. The test only
// shortens combat by selecting a configuration in which one hit is lethal.
const service=pathToFileURL(path.resolve('src/host/service.ts')).href;
const bootstrap=`data:text/javascript,${encodeURIComponent(`
  import {Laboratory} from ${JSON.stringify(service)};
  const original=Laboratory.prototype.prepareRoom;
  Laboratory.prototype.prepareRoom=async function(setup) {
    return original.call(this,{...setup,tuning:{hp:50,damage:100,power:50}});
  };
`)}`;
const execute=promisify(execFile);
const sleep=(ms:number)=>delay(ms);

function connect(directory:string) {
  const child=spawn(process.execPath,['--import','tsx','--import',bootstrap,'src/host/contest-mcp.ts',
    '--opponent=privileged','--opponent-movement=still','--opponent-rotation=still','--opponent-shooting=off'],
    {windowsHide:true,stdio:['pipe','pipe','inherit'],env:{...process.env,LAB_CONTEST_DIRECTORY:directory}});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let sequence=0;
  const request=async(method:string,params?:object)=>{
    const id=++sequence;
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    const {value}=await lines.next(),reply=JSON.parse(value!);
    assert.equal(reply.id,id);return reply.result;
  };
  return {request,call:(name:string,args:object={})=>request('tools/call',{name,arguments:args}),
    async close(){child.stdin.end();assert.equal((await closed)[0],0);}};
}

test('completed MP4 has dynamic preparation and MCP frames stay private across connections and retry', {timeout:35000}, async()=>{
  const parent=path.resolve('.local/recording-validation');
  await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(path.join(parent,'contest-'));
  const client=connect(directory), other=connect(directory);
  try {
    for(const connection of [client,other]) await connection.request('initialize',{protocolVersion:'2025-06-18'});
    const list=async(connection=client)=>JSON.parse((await connection.call('lab_recordings')).content[0].text);
    assert.deepEqual(await list(),{recordings:[],saving:false});
    assert.equal((await client.call('lab_recording_frame',{recordingName:'../secret.mp4',timestampMs:0})).isError,true);
    assert.equal((await other.call('lab_retry')).isError,true);
    assert.deepEqual(await readdir(directory),[]);
    const offset=RULES.radius*Math.SQRT1_2;
    const action={moveX:0,moveY:0,spin:.5,aimX:(750-offset)/RULES.width,aimY:(300-offset)/RULES.height,durationMs:500};
    assert.equal((await client.call('lab_act',{action})).content[1].mimeType,'image/jpeg');
    assert.deepEqual((await list()).recordings,[]);
    await sleep(5100);
    await client.call('lab_fire');
    let info:{recordingName:string;durationMs:number}|undefined;
    for(let i=0;i<140&&!info;i++){[info]=(await list()).recordings;if(!info)await sleep(50);}
    assert.ok(info,'No completed recording was announced');
    const {recordingName,durationMs}=info;
    assert.match(recordingName,/^\d{8}_\d{6}(?:_\d+)?\.mp4$/);
    assert.ok(durationMs>6000 && durationMs<9000);
    assert.deepEqual((await list(other)).recordings,[]);
    for (const [connection,args] of [[other,{recordingName,timestampMs:0}],
      [client,{recordingName,timestampMs:-1}],[client,{recordingName,timestampMs:durationMs}],
      [client,{recordingName,timestampMs:'100'}],[client,{recordingName,timestampMs:NaN}],
      [client,{recordingName,timestampMs:0,path:'ignored'}]] as const) {
      const result=await connection.call('lab_recording_frame',args);
      assert.deepEqual(result,{isError:true,content:[{type:'text',text:'Participant request failed.'}]});
    }
    assert.deepEqual(JSON.parse((await client.call('lab_retry')).content[0].text),{ready:true});
    assert.deepEqual((await list()).recordings,[info]);
    const added=await readdir(directory);
    assert.equal(added.length,1);
    const sample=path.join(directory,added[0]);
    const movie=path.join(sample,'recordings',recordingName);
    const record=JSON.parse(await readFile(movie.replace(/\.mp4$/,'.json'),'utf8'));
    assert.equal(recordingStem(new Date(record.recording.startedAt))+'.mp4',recordingName);
    assert.ok(record.recording.jpegIndex.filter((f:{status:string})=>f.status==='countdown').length>100);
    assert.notEqual(record.snapshots[0].state.robots.red.angle,record.snapshots[1].state.robots.red.angle);
    const frames=new Set<string>();
    for(const ms of [0,1100,2100,3100,4100,5100]){
      const content=(await client.call('lab_recording_frame',{recordingName,timestampMs:ms})).content;
      assert.deepEqual(JSON.parse(content[0].text),{timestampMs:ms});
      assert.equal(content[1].mimeType,'image/jpeg');
      const reference=await execute(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-threads','1','-i',movie,
        '-map','0:v:0','-an','-sn','-vf',`select=eq(n\\,${ms*30/1000})`,'-frames:v','1','-threads','1','-c:v','mjpeg','-q:v','2','-f','image2pipe','pipe:1'],{encoding:'buffer'});
      assert.deepEqual(Buffer.from(content[1].data,'base64'),reference.stdout);
      frames.add(content[1].data);
      if (process.env.LAB_KEEP_RECORDING_SAMPLE==='1') await writeFile(path.join(sample,`frame-${ms}.jpg`),reference.stdout);
    }
    assert.equal(frames.size,6);
    const at=async(timestampMs:number)=>JSON.parse((await client.call('lab_recording_frame',{recordingName,timestampMs})).content[0].text).timestampMs;
    assert.equal(await at(7*1000/30-.001),6*1000/30);
    assert.equal(await at(7*1000/30),7*1000/30);
    assert.equal((await readdir(directory)).length,1);
    if (process.env.LAB_KEEP_RECORDING_SAMPLE==='1') console.log('Recording sample: '+sample);
  } finally {
    try {await Promise.all([client.close(),other.close()]);}
    finally {if (process.env.LAB_KEEP_RECORDING_SAMPLE!=='1' && path.dirname(directory)===parent) await rm(directory,{recursive:true,force:true});}
  }
});
