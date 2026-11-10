import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readFile,readdir,access,mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
// Real production constructors: no opt-in test diagnostic history.
import {Game} from '../src/host/game.js';
import {Laboratory} from '../src/host/service.js';
import {MatchRecorder,ffmpegPath} from '../src/host/recorder.js';
import {VisualFeed} from '../src/host/vision.js';
import {PROVISIONAL_VISION} from '../src/shared/vision.js';
import {createRoomSetup,selectRoomController,freshMatchSetup} from '../src/client/room.js';
import {humanSide} from '../src/client/human-input.js';
import {MatchStats} from '../src/client/MatchStats.js';
import {LaboratoryPage} from '../src/client/GamePage.js';
import {replay} from '../src/host/replay.js';
import {RULES,type ParticipantObservation} from '../src/shared/protocol.js';
import {finishPreparation} from './support.js';
import {setTimeout as delay} from 'node:timers/promises';
const directory=()=>path.resolve('.local/recording-tests',randomUUID());

test('首次默认红方键盘在左，显式蓝方及双脚本配置保留；每局录制选择默认清空',()=>{
  const setup=createRoomSetup();assert.deepEqual(setup.room!.seats,{red:'keyboard',blue:'builtin:privileged'});assert.equal(humanSide(setup),'red');
  assert.equal(humanSide(new Game().setup),'red');
  const blue=selectRoomController(setup,'blue','keyboard'),before=structuredClone(blue);
  assert.equal(humanSide(blue),'blue');assert.deepEqual(freshMatchSetup(blue).room,blue.room);assert.deepEqual(blue,before);
  const observers=selectRoomController(blue,'blue','builtin:spinner');assert.equal(humanSide(observers),undefined);
  assert.deepEqual(freshMatchSetup(observers).room,observers.room);
  const previous={...blue,recording:true,controllerSeeds:{red:1,blue:2}};
  assert.equal(freshMatchSetup(previous).recording,false);assert.equal(freshMatchSetup(previous).controllerSeeds,undefined);
  assert.equal(freshMatchSetup(previous,true).recording,true);assert.equal(humanSide(createRoomSetup()),'red');
  const page=renderToStaticMarkup(React.createElement(LaboratoryPage,{api:async()=>{}}));
  assert.match(page,/type="checkbox"/);assert.doesNotMatch(page,/<input[^>]*type="checkbox"[^>]*checked|上一局回放|game-spin-state|顺时针旋转|逆时针旋转/);
});

test('未选择录制不积累全量历史且开始/结束/切局/卸载均不落盘，正常结算计数保留',async()=>{
  const root=directory(),lab=new Laboratory(path.join(root,'referee'));
  try{
    await lab.admin('start',{setup:{clock:'stepped',scenario:'duel',targetSpin:0,controllers:{red:'fixed',blue:'fixed'}}});
    await lab.participant('observe',{},'agent');
    finishPreparation(lab.game);for(let i=0;i<4;i++)lab.game.advance(480);
    const record=lab.game.refereeRecord();assert.equal(record.recordingEnabled,false);
    assert.deepEqual(record.actions,[]);assert.deepEqual(record.snapshots,[]);assert.deepEqual(record.events,[]);assert.deepEqual(record.humanAimAssist.events,[]);
    assert.ok(record.finalState.robots.red.shots>0);assert.ok(record.finalState.robots.blue.shots>0);
    assert.ok(record.finalState.events.every(event=>record.finalTick-event.tick<=RULES.tickHz*.4));
    await lab.admin('stop',{});await assert.rejects(lab.admin('record',{}),/未选择录制/);
    await lab.admin('start',{setup:createRoomSetup()});assert.equal(lab.recordingInfo().status,'off');
  }finally{await lab.dispose();}
  await assert.rejects(access(root),{code:'ENOENT'});
});

test('红蓝结算分栏包含独立发弹量、命中数和命中率，零发弹为0%',()=>{
  const markup=renderToStaticMarkup(React.createElement(MatchStats,{hud:{red:{hp:110,ammo:597,shots:3,hits:1},blue:{hp:0,ammo:600,shots:0,hits:0}}}));
  const red=markup.indexOf('aria-label="红方统计"'),blue=markup.indexOf('aria-label="蓝方统计"');assert.ok(red>=0&&red<blue);
  assert.match(markup.slice(red,blue),/发弹量<\/dt><dd>3/);assert.match(markup.slice(red,blue),/命中数<\/dt><dd>1/);assert.match(markup.slice(red,blue),/33\.3%/);
  assert.match(markup.slice(blue),/发弹量<\/dt><dd>0/);assert.match(markup.slice(blue),/命中率<\/dt><dd>0%/);assert.doesNotMatch(markup,/NaN|Infinity/);
});

test('参赛输出与录制使用同一 JPEG 字节和 frameId，补帧保持时轴且 MP4 可完整解码',async()=>{
  const root=directory(),lab=new Laboratory(path.join(root,'referee'));
  try{
    await lab.admin('start',{setup:{clock:'stepped',scenario:'duel',targetSpin:0,recording:true,controllers:{red:'idle',blue:'idle'}}});
    const shared = await lab.participant('observe',{},'agent') as ParticipantObservation;
    assert.equal(lab.visionMetrics().captures,1);
    const deadline=performance.now()+1000;
    while(lab.recordingInfo().jpegFrames===0&&performance.now()<deadline)await delay(5);
    const live=lab.recordingInfo();
    const indexed=(await readFile(live.indexPath!,'utf8')).trim().split('\n').slice(1).map(line=>JSON.parse(line));
    assert.equal(indexed.length,1);assert.equal(indexed[0].frameId,shared.frameId);
    assert.deepEqual(await readFile(live.sourcePath!),Buffer.from(shared.image.base64,'base64'));
    assert.equal(live.videoPath,undefined);
    // Advance multiple slots in one turn to force missed JPEGs without a wall-clock wait.
    lab.game.advance(40);
    await lab.admin('pause',{});const pausedAt=lab.game.elapsedSteps;
    await delay(50);assert.equal(lab.game.elapsedSteps,pausedAt);
    await lab.admin('resume',{});
    lab.game.advance(80);
    const stopping=await lab.admin('stop',{}) as {recording:{status:string}};
    assert.equal(stopping.recording.status,'saving');
    await lab.waitForRecording();const info=lab.recordingInfo();assert.equal(info.status,'saved',info.error);assert.ok(info.videoPath&&info.dataPath);
    const video=await readFile(info.videoPath!);assert.equal(video.toString('ascii',4,8),'ftyp');assert.ok(video.includes(Buffer.from('avc1')));
    const data=JSON.parse(await readFile(info.dataPath!,'utf8'));assert.equal(data.matchId,info.matchId);
    const stem=path.parse(info.videoPath!).name;
    assert.match(stem,/^\d{8}_\d{6}(?:_\d+)?$/);
    assert.equal(path.basename(info.videoPath!),info.recordingName);
    assert.equal(path.parse(info.dataPath!).name,stem);
    assert.equal(data.recording.schemaVersion,2);assert.equal(data.version,RULES.version);assert.equal(data.recording.fps,30);assert.equal(data.recording.width,960);assert.equal(data.recording.height,680);
    assert.equal(data.recording.mapping.length,info.frames);assert.equal(data.recording.mapping[0].step,0);assert.equal(data.recording.mapping[0].status,'countdown');assert.equal(data.recording.mapping.at(-1).step,data.finalStep);
    assert.equal(data.finalStep,120);assert.equal(data.finalStats.red.shots,0);assert.ok(data.setup.controllerSeeds);assert.equal(replay(data).identical,true);
    assert.equal(info.frames,46);assert.equal(data.recording.endHoldFrames,30);assert.ok(data.recording.gapHoldFrames>0);
    assert.deepEqual(data.recording.mapping.slice(0,15).map((entry:{step:number})=>entry.step),Array.from({length:15},(_,i)=>i*8));
    assert.equal(data.recording.jpegIndex.length,lab.visionMetrics().completed);
    assert.equal(data.recording.jpegIndex.at(-1).status,'stopped');
    assert.equal(data.recording.jpegIndex.some((entry:{status:string})=>entry.status==='paused'),false);
    const decoded=spawnSync(ffmpegPath(),['-v','error','-i',info.videoPath!,'-progress','pipe:1','-nostats','-f','null','-'],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(decoded.status,0,decoded.stderr);const frames=[...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1);assert.equal(Number(frames?.[1]),info.frames);
    const frame=await lab.participant('observe',{},'agent') as ParticipantObservation;assert.deepEqual(Object.keys(frame).sort(),['frameId','image']);
    for(const method of ['record','recordingOpen','recordingInfo','replayFrame'])await assert.rejects(lab.participant(method,{},'script'),{message:'Participant request failed.'});
    assert.ok((await readdir(path.dirname(info.videoPath!))).every(filename=>!filename.endsWith('.partial')));
    await mkdir('.local/diagnostics',{recursive:true});await writeFile('.local/diagnostics/recording-verification.json',JSON.stringify({info,decode:decoded.stdout,measurement:data.recording.measurement,videoDurationMs:data.recording.videoDurationMs},null,2));
  }finally{await lab.dispose();}
});

test('录像磁盘队列有界，拥塞失败会保留已拥有的源文件和索引',async()=>{
  const root=directory(),recorder=new MatchRecorder(root),game=new Game();game.start({clock:'stepped',scenario:'duel',targetSpin:0,recording:true,controllers:{red:'idle',blue:'idle'}});
  try{
    await recorder.start(game.matchId,PROVISIONAL_VISION);
    for(let i=0;i<34;i++)recorder.capture({matchId:game.matchId,frameId:i+1,bytes:Buffer.alloc(128),step:i*8,tick:0,gameTimeMs:0,countdownMs:5000,status:'countdown'});
    assert.equal(recorder.info().status,'error');assert.ok(recorder.info().maxPendingFrames!<=32);
    await recorder.finish(game.refereeRecord());const info=recorder.info();assert.equal(info.status,'error');assert.ok(info.error);assert.ok(info.dataPath);assert.equal(info.videoPath,undefined);
    const data=JSON.parse(await readFile(info.dataPath!,'utf8'));assert.equal(data.recording.status,'error');assert.equal(data.recording.videoFile,null);
    await access(info.sourcePath!);await access(info.indexPath!);
    assert.ok((await readdir(root)).every(filename=>!filename.endsWith('.mp4.partial')));
  }finally{await recorder.dispose();}
});

test('转码失败保留实际 JPEG 和索引，录像目录不可写时比赛仍能推进和供图',async()=>{
  const root=directory(),game=new Game(),feed=new VisualFeed();
  const recorder=new MatchRecorder(root,path.join(root,'missing-ffmpeg.exe'));
  game.start({clock:'stepped',scenario:'duel',targetSpin:0,recording:true,controllers:{red:'idle',blue:'idle'}});
  try {
    await recorder.start(game.matchId,PROVISIONAL_VISION);
    feed.subscribeRecording(game.matchId,frame=>recorder.capture(frame));
    await feed.captureInitial(game.display());
    game.advance(8);game.stop();
    await feed.captureFinal(game.display(),game.elapsedSteps);
    await recorder.finish(game.refereeRecord());
    const info=recorder.info();assert.equal(info.status,'error');assert.match(info.error!,/MP4 转码失败/);
    assert.equal(info.videoPath,undefined);assert.ok(info.sourceBytes!>0);
    const data=JSON.parse(await readFile(info.dataPath!,'utf8'));
    assert.equal(data.recording.jpegIndex.length,2);assert.equal(replay(data).identical,true);
    assert.equal((await readFile(info.sourcePath!)).length,info.sourceBytes);
    await access(info.indexPath!);
  } finally {await feed.dispose();await recorder.dispose();}
  const blocked=directory();await mkdir(blocked,{recursive:true});await writeFile(path.join(blocked,'recordings'),'occupied');
  const lab=new Laboratory(path.join(blocked,'referee'));
  try {
    await lab.admin('start',{setup:{clock:'stepped',scenario:'duel',targetSpin:0,recording:true,controllers:{red:'idle',blue:'idle'}}});
    assert.equal(lab.recordingInfo().status,'error');
    lab.game.advance(8);assert.equal(lab.game.elapsedSteps,8);
    assert.equal((await lab.participant('observe',{},'agent') as ParticipantObservation).image.mimeType,'image/jpeg');
    await lab.admin('stop',{});assert.equal(await readFile(path.join(blocked,'recordings'),'utf8'),'occupied');
  } finally {await lab.dispose();}
});

test('实时录像在没有参赛取图请求时启动共享采样，切局完成保存并回收旧编码器',async()=>{
  const root=directory(),lab=new Laboratory(path.join(root,'referee'));
  try {
    await lab.admin('start',{setup:{...createRoomSetup(),recording:true}});
    const pid=lab.visionMetrics().encoderPid!;assert.ok(pid);
    const deadline=performance.now()+2000;
    while((lab.recordingInfo().jpegFrames??0)<3&&performance.now()<deadline)await delay(15);
    assert.ok(lab.recordingInfo().jpegFrames!>=3);assert.equal(lab.visionMetrics().cacheHits,0);
    const previous=lab.game.matchId;
    await assert.rejects(lab.admin('start',{setup:createRoomSetup()}),/上一局正在生成视频/);
    await lab.waitForRecording();
    const saved=lab.recordingInfo();
    assert.equal(saved.status,'saved',saved.error);
    assert.equal(saved.matchId,previous);
    assert.ok(saved.videoPath&&saved.dataPath);
    await lab.admin('start',{setup:createRoomSetup()});
    assert.notEqual(lab.game.matchId,previous);assert.equal(lab.recordingInfo().status,'off');
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    assert.deepEqual((await readdir(path.join(root,'recordings'))).sort(),[path.basename(saved.dataPath),path.basename(saved.videoPath)].sort());
  } finally {await lab.dispose();}
});

test('从准备期到实际结算的完整录制有阶段映射，未选择的下一局不会继续录制',async()=>{
  const root=directory(),lab=new Laboratory(path.join(root,'referee'));
  try{
    await lab.admin('start',{setup:{clock:'stepped',scenario:'duel',targetSpin:0,recording:true,tuning:{hp:50,damage:25,power:1},controllers:{red:'fixed',blue:'fixed'}}});
    while(['countdown','running'].includes(lab.game.status)){lab.game.advance(8);await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(lab.game.status,'ended');await lab.admin('stop',{});await lab.waitForRecording();const info=lab.recordingInfo();assert.equal(info.status,'saved',info.error);
    const data=JSON.parse(await readFile(info.dataPath!,'utf8'));const stages=new Set(data.recording.mapping.map((entry:{status:string})=>entry.status));
    for(const status of ['countdown','running','ended'])assert.ok(stages.has(status));
    assert.ok(data.finalStats.red.shots>0&&data.finalStats.blue.shots>0);assert.equal(replay(data).identical,true);
    const decoded=spawnSync(ffmpegPath(),['-v','error','-i',info.videoPath!,'-progress','pipe:1','-nostats','-f','null','-'],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(decoded.status,0,decoded.stderr);
    assert.equal(Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]),info.frames);
    const files=await readdir(path.join(root,'recordings'));
    await lab.admin('start',{setup:{clock:'stepped',scenario:'duel',targetSpin:0,controllers:{red:'idle',blue:'idle'}}});lab.game.advance(24);await lab.admin('stop',{});
    assert.equal(lab.recordingInfo().status,'off');assert.deepEqual(await readdir(path.join(root,'recordings')),files);assert.deepEqual(lab.game.refereeRecord().actions,[]);
    await mkdir('.local/diagnostics',{recursive:true});await writeFile('.local/diagnostics/recording-full-round.json',JSON.stringify({info,decode:decoded.stdout,measurement:data.recording.measurement,videoDurationMs:data.recording.videoDurationMs,stages:[...stages],stats:data.finalStats},null,2));
  }finally{await lab.dispose();}
});

test('对局数据历史有硬内存预算，耗尽只让录制失败而不停止玩法',()=>{
  const game=new Game();game.start({clock:'stepped',scenario:'duel',targetSpin:0,recording:true,controllers:{red:'agent',blue:'idle'}});
  let error='';game.setCapture(undefined,message=>{error=message;});
  for(let i=0;i<100002;i++)game.cancel('red','agent');
  assert.match(error,/100000/);const record=game.refereeRecord();assert.equal(record.actions.length,100000);assert.ok(record.recordingError);
  game.advance(1);assert.equal(game.status,'countdown');assert.equal(game.elapsedSteps,1);assert.throws(()=>replay(record),/记录不完整/);
});
