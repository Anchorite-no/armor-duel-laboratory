import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { TracedLaboratory as Laboratory } from './support.js';
import { Program } from '../src/host/program.js';
import { neutral } from '../src/host/physics.js';
import { createRoomSetup } from '../src/client/room.js';
import { PROVISIONAL_VISION, validateVision, jpegQscale } from '../src/shared/vision.js';
import type { ParticipantObservation } from '../src/shared/protocol.js';
import { VisualFeed } from '../src/host/vision.js';
import { NativeJpegEncoder } from '../src/host/native-jpeg.js';
import { JpegStream } from '../src/host/jpeg-stream.js';
import { ffmpegPath } from '../src/host/recorder.js';
import { TracedGame as Game,finishPreparation,neutralMotion } from './support.js';
import {setTimeout as delay} from 'node:timers/promises';
const dir=()=>path.resolve('.local/vision-tests',randomUUID(),'referee');

test('30Hz供图按完整控制帧复用，编码忙时返回上一帧而不排队',async()=>{
  const game=new Game();game.start({clock:'stepped',scenario:'duel',targetSpin:0,controllers:{blue:'agent',red:'idle'}});finishPreparation(game);
  const feed=new VisualFeed();
  try{
    const first=await feed.observe(()=>game.participantFrame());await delay(35);game.advance(3);
    const same=await feed.observe(()=>game.participantFrame());assert.equal(same.frameId,first.frameId);assert.equal(feed.metrics.captures,1);
    game.advance(1);const previous=await feed.observe(()=>game.participantFrame());assert.equal(previous.frameId,first.frameId);
    const pendingReturns=feed.metrics.pendingReturns;
    const repeated=await Promise.all(Array.from({length:100},()=>feed.observe(()=>game.participantFrame())));
    assert.ok(repeated.every(frame=>frame.frameId===first.frameId));assert.equal(feed.metrics.captures,2);assert.equal(feed.metrics.pendingReturns-pendingReturns,100);
    const deadline=performance.now()+3000;while(feed.metrics.completed<2&&performance.now()<deadline)await delay(5);
    const current=await feed.observe(()=>game.participantFrame());assert.ok(current.frameId>first.frameId);assert.equal(feed.metrics.captures,2);assert.equal(feed.metrics.maxPending,1);
    assert.ok(feed.metrics.renderMs>0);assert.ok(feed.metrics.encodeMs>0);assert.equal(feed.metrics.encoderStarts,1);
    assert.equal(game.tickCount,4);
  }finally{await feed.dispose();}
});

test('原生 JPEG 流正确处理拆包、粘包、段内假终止和大小超限',()=>{
  const frame=Buffer.from([0xff,0xd8,0xff,0xfe,0,6,1,0xff,0xd9,2,0xff,0xda,0,2,5,0xff,0,0xd9,0xff,0xd0,0,0xff,0xd9]);
  const received:Buffer[]=[];
  const stream=new JpegStream(data=>received.push(data));
  for (const byte of frame.subarray(0,-1)) stream.push(Buffer.from([byte]));
  assert.equal(received.length,0);
  stream.push(Buffer.concat([frame.subarray(-1),frame]));
  assert.deepEqual(received,[frame,frame]);
  assert.throws(()=>new JpegStream(()=>assert.fail('超限帧不能发布'),frame.length-1).push(frame),/大小上限/);
});

test('供图首帧激活后独立于调用，暂停、换局和卸载回收 FFmpeg',async()=>{
  const lab=new Laboratory(dir());
  const setup={clock:'realtime',scenario:'duel',targetSpin:0,controllers:{blue:'agent',red:'idle'}};
  try {
    await lab.admin('start',{setup});
    const first=await lab.participant('observe',{},'agent') as ParticipantObservation;
    const pid=lab.visionMetrics().encoderPid!;assert.ok(pid);
    const deadline=performance.now()+2000;
    while(lab.visionMetrics().completed<3&&performance.now()<deadline)await delay(15);
    assert.ok(lab.visionMetrics().completed>=3);
    assert.equal(lab.visionMetrics().encoderPid,pid);
    assert.equal(lab.visionMetrics().maxQueued,0);
    await lab.admin('pause',{});
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    await lab.admin('resume',{});
    const resumed=await lab.participant('observe',{},'script') as ParticipantObservation;
    assert.ok(resumed.frameId>first.frameId);
    const resumedPid=lab.visionMetrics().encoderPid!;
    await lab.admin('start',{setup});
    assert.throws(()=>process.kill(resumedPid,0),{code:'ESRCH'});
    const next=await lab.participant('observe',{},'agent') as ParticipantObservation;
    assert.ok(next.frameId>resumed.frameId);
    const nextPid=lab.visionMetrics().encoderPid!;
    await lab.dispose();
    assert.throws(()=>process.kill(nextPid,0),{code:'ESRCH'});
  } finally {await lab.dispose();}
});

test('原生编码进程退出后可重新启动，编码超时会回收进程',async t=>{
  const game=new Game();game.start({clock:'stepped',scenario:'duel',targetSpin:0,controllers:{blue:'agent',red:'idle'}});finishPreparation(game);
  const feed=new VisualFeed();
  try {
    const first=await feed.observe(()=>game.participantFrame());
    const pid=feed.metrics.encoderPid!;process.kill(pid);
    await delay(40);game.advance(8);
    const deadline=performance.now()+3000;
    let latest=first;
    while(latest.frameId===first.frameId&&performance.now()<deadline){
      try {latest=await feed.observe(()=>game.participantFrame());} catch {}
      await delay(10);
    }
    assert.ok(latest.frameId>first.frameId);
    assert.equal(feed.metrics.encoderStarts,2);
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  } finally {await feed.dispose();}
  const encoder=new NativeJpegEncoder(ffmpegPath(), PROVISIONAL_VISION);
  const pid=encoder.pid!;
  t.mock.timers.enable({apis:['setTimeout']});
  try {
    const rejected=assert.rejects(encoder.encode(game.participantFrame()),/编码超时/);
    t.mock.timers.tick(2000);
    await rejected;
  } finally {t.mock.timers.reset();await encoder.close();}
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
test('参赛观察仅有全图真实JPEG与序号，无结构化状态或JPEG语义元数据',async()=>{
  const lab=new Laboratory(dir(),{fps:.25,width:480,quality:70});
  try{
    const o=await lab.participant('observe',{},'agent') as ParticipantObservation;
    assert.deepEqual(Object.keys(o).sort(),['frameId','image']);assert.deepEqual(Object.keys(o.image).sort(),['base64','height','mimeType','width']);assert.equal(o.image.mimeType,'image/jpeg');
    const bytes=Buffer.from(o.image.base64,'base64');assert.equal(bytes[0],255);assert.equal(bytes[1],216);assert.equal(bytes[bytes.length-2],255);assert.equal(bytes[bytes.length-1],217);
    const decoded=jpeg.decode(bytes,{useTArray:true,formatAsRGBA:false,maxResolutionInMP:3,maxMemoryUsageInMB:64});assert.equal(decoded.width,480);assert.equal(decoded.height,340);assert.equal(decoded.data.length,480*340*3);assert.equal(decoded.comments,undefined);
    // Header may contain ordinary JFIF but no EXIF, comments or semantic payload.
    for(let at=2;at<bytes.length;){assert.equal(bytes[at],255);const marker=bytes[at+1];if(marker===0xda||marker===0xd9)break;assert.ok(!(marker>=0xe1&&marker<=0xef)&&marker!==0xfe);at+=2+bytes.readUInt16BE(at+2);}
    const red=(20*480+25)*3,blue=(20*480+330)*3;assert.ok(decoded.data[blue+2]>decoded.data[blue]);assert.ok(decoded.data[red]>decoded.data[red+2]);
    assert.doesNotMatch(JSON.stringify(o),/"(?:timestampMs|matchId|status|winner|hud|rules|controller|robots|countdownMs|vx|omega|armor|heat|heatUnits|overheatDeaths)":/);
  }finally{await lab.dispose();}
});
test('模型与脚本共享并发编码和缓存限额，额外observe/act不能换取高频或高清旁路',async()=>{
  const lab=new Laboratory(dir(),{fps:.25,width:480,quality:70});
  try{
    await lab.admin('start',{setup:{clock:'stepped',scenario:'duel',targetSpin:0,controllers:{blue:'agent',red:'idle'}}});
    const [model,script]=await Promise.all([lab.participant('observe',{},'agent'),lab.participant('observe',{width:1920,quality:100},'script')]) as ParticipantObservation[];
    assert.equal(model.frameId,script.frameId);assert.equal(model.image.base64,script.image.base64);
    const extra=await Promise.all(Array.from({length:20},()=>lab.participant('observe',{},'script'))) as ParticipantObservation[];
    assert.ok(extra.every(o=>o.frameId===model.frameId&&o.image.base64===model.image.base64));
    const acted=await lab.participant('act',{side:'blue',action:{...neutralMotion(),spin:1,durationMs:100}},'agent') as ParticipantObservation;
    assert.deepEqual(Object.keys(acted).sort(),['frameId','image']);assert.equal(acted.frameId,model.frameId);assert.equal(acted.image.width,480);
    assert.deepEqual(await lab.participant('cancel',{side:'blue'},'agent'),{cancelled:true});
    for(const method of ['view','display','record','replayFrame','state','snapshot','configureVision']){await assert.rejects(lab.participant(method,{},'agent'));await assert.rejects(lab.participant(method,{},'script'));}
  }finally{await lab.dispose();}
});
test('供图配置开局前可改、整局冻结并记入记录，不影响物理和页面显示通道',async()=>{
  const lab=new Laboratory(dir());
  try{
    assert.deepEqual(PROVISIONAL_VISION,{fps:30,width:960,quality:85});
    assert.deepEqual([10,85,100].map(jpegQscale),[31,3,2]);
    const vision={fps:2,width:720,quality:65};await lab.admin('configureVision',{vision});await lab.admin('start',{setup:createRoomSetup()});
    assert.deepEqual(lab.game.refereeRecord().setup.vision,vision);await assert.rejects(lab.admin('configureVision',{vision:{fps:60,width:1920,quality:100}}),/冻结/);
    const o=await lab.participant('observe',{},'script') as ParticipantObservation;assert.equal(o.image.width,720);assert.equal(o.image.height,510);
    const display=await lab.admin('display',{}) as {frame:unknown};assert.ok(display.frame);assert.equal(lab.game.setup.countdownMs,5000);
    await lab.admin('stop',{});await lab.admin('configureVision',{vision:{fps:5,width:480,quality:40}});
    const changed=await lab.participant('observe',{},'agent') as ParticipantObservation;assert.equal(changed.image.width,480);assert.ok(changed.frameId>o.frameId);
    for(const bad of [{fps:0,width:960,quality:80},{fps:31,width:960,quality:80},{fps:10,width:0,quality:80},{fps:10,width:960,quality:101},{fps:NaN,width:960,quality:80}])assert.throws(()=>validateVision(bad));
  }finally{await lab.dispose();}
});
test('受限运行器真实解码JPEG，拒绝PNG，且不含陪练规则实现',async()=>{
  const lab=new Laboratory(dir(),{fps:1,width:480,quality:75}),program=new Program();
  try{
    const frame=await lab.participant('observe',{},'script');
    const code=`const o=await lab.observe();await lab.log(Object.keys(o).sort().join(','));const p=lab.pixels(o);await lab.log([p.width,p.height,p.channels,p.data.length].join(','));try{lab.pixels({image:{mimeType:'image/png',base64:''}});}catch(e){await lab.log('png-blocked');}`;
    await program.run(code,'blue',async()=>({...frame as object,hud:{secret:42},robots:{secret:42},status:'running'}),()=>{});const deadline=Date.now()+5000;while(program.info().status==='running'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
    assert.equal(program.info().status,'ended',program.info().output);assert.match(program.info().output,/480,340,3,489600/);assert.match(program.info().output,/png-blocked/);assert.match(program.info().output,/frameId,image/);assert.doesNotMatch(program.info().output,/hud|robots|status/);
    const runner=readFileSync('.local/runner/runner.mjs','utf8');assert.doesNotMatch(runner,/traditional-full-state|preferredRange|aimingSolution|observedMotion/);
  }finally{await program.stop();await lab.dispose();}
});

test('脚本SDK不导出规则/配置/自瞄，宿主错误内容不会转发给脚本',async()=>{
  const program=new Program();
  try{
    await program.run(`await lab.log(Object.keys(lab).sort().join(','));try{await lab.act({});}catch(e){await lab.log(e.message);}`,'blue',async()=>{throw Error('SECRET: hp=200, power=50, bulletSpeed=525, preparation=5000');},()=>{});
    const deadline=Date.now()+5000;while(program.info().status==='running'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
    assert.equal(program.info().status,'ended',program.info().output);
    assert.match(program.info().output,/act,cancel,fire,log,observe,pixels,side,sleep/);assert.match(program.info().output,/Participant request failed/);
    assert.doesNotMatch(program.info().output,/SECRET|rules|config|autoAim|aimAssist|bulletSpeed|preparation/);
  }finally{await program.stop();}
});
