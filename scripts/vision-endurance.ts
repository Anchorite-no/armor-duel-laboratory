// Wall-clock headless run of the normal host, native JPEG pipe, runner and MP4 recorder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Laboratory } from '../src/host/service.js';
import { ffmpegPath } from '../src/host/recorder.js';
import { RULES, type ParticipantObservation } from '../src/shared/protocol.js';
import { PROVISIONAL_VISION, jpegQscale } from '../src/shared/vision.js';
import { replay, type RecordInput } from '../src/host/replay.js';

const script = `
  let calls=0, repeats=0, last=-1, started=performance.now(), logged=started;
  const decodeBins = Array(201).fill(0);
  while (true) {
    const o=await lab.act({moveX:0,moveY:0,spin:.65,aimX:.5,aimY:.5,durationMs:17});
    calls++;
    if (o.frameId === last) repeats++;
    else {
      last=o.frameId;
      const start=performance.now();lab.pixels(o);
      decodeBins[Math.min(200,Math.floor(performance.now()-start))]++;
    }
    if(performance.now()-logged>=1000) {
      logged=performance.now();await lab.log(JSON.stringify({calls,repeats,decodeBins,wallMs:logged-started}));
    }
  }
`;
type ScriptSample = {calls:number;repeats:number;decodeBins:number[];wallMs:number};
const percentile = (values: number[]) => {
  const sorted = values.toSorted((a,b)=>a-b);
  return {samples:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)};
};
const directory = path.resolve('.local/vision-endurance',randomUUID());
const lab = new Laboratory(path.join(directory,'referee'));
const roundMs=RULES.preparationMs+RULES.durationMs;
const delivery: number[] = [], frameAge: number[] = [], authorityAge: number[] = [], render: number[] = [], encode: number[] = [], intervals: number[] = [];
const scriptSamples: ScriptSample[] = [];
let lastScript: ScriptSample | undefined;
let lastId = -1, lastCompleted = 0, calls = 0, repeats = 0, skipped = 0, pauseMs = 0;
let pauseStep = 0, firstFrameMs = 0;
let imageSample: { id: number; bytes: Buffer } | undefined;
const pids = new Set<number>();
const readScript = () => {
  const line = lab.programs.blue.info().output.trim().split('\n').at(-1);
  if (line) {
    try { lastScript = JSON.parse(line) as ScriptSample; } catch {}
  }
};
const collectScript = () => { readScript(); if(lastScript)scriptSamples.push(lastScript);lastScript=undefined; };
const confirmExit = (pid: number) => assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
try {
  await lab.admin('start',{setup:{clock:'realtime',scenario:'duel',targetSpin:0,recording:true,
    controllers:{red:'computer',blue:'script'},controllerSeeds:{red:17,blue:19},tuning:{hp:1000,damage:1,power:1}}});
  const start = performance.now();
  await lab.participant('observe',{},'agent');
  firstFrameMs = performance.now()-start;
  await lab.admin('program',{side:'blue',code:script});
  const deadline = start+roundMs+20_000;
  while (lab.game.status === 'countdown' || lab.game.status === 'running') {
    assert.ok(performance.now()<deadline,'realtime match stalled');
    assert.notEqual(lab.programs.blue.info().status,'error',lab.programs.blue.info().output);
    let observation: ParticipantObservation;
    try { observation = await lab.participant('observe',{},'agent') as ParticipantObservation; }
    catch (error) { if ((lab.game.status as string)==='ended') break; throw error; }
    const timings = lab.visionMetrics();
    if (timings.encoderPid) pids.add(timings.encoderPid);
    const f = timings.lastFrame;
    calls++;
    if (observation.frameId === lastId) repeats++;
    if (f && f.frameId === observation.frameId) {
      if (!imageSample && lab.game.tickCount >= 2400 && lab.game.display().scene.bullets.length > 0) {
        imageSample = { id: f.frameId, bytes: Buffer.from(observation.image.base64, 'base64') };
      }
      frameAge.push(performance.now()-f.capturedAt);
      authorityAge.push((lab.game.elapsedSteps-f.step)*1000/RULES.tickHz);
      if (f.frameId !== lastId) {
        if (lastId>=0) skipped += Math.max(0,f.frameId-lastId-1);
        if (lastCompleted) intervals.push(f.completedAt-lastCompleted);
        lastCompleted=f.completedAt;
        delivery.push(f.completedAt-f.capturedAt);
        render.push(f.renderMs);
        encode.push(f.encodeMs);
      }
    }
    lastId=observation.frameId;
    readScript();
    if (!pauseStep && lab.game.elapsedSteps >= 60 * RULES.tickHz && lab.game.status === 'running') {
      const oldPid=timings.encoderPid;
      assert.ok(oldPid);
      const pauseStarted=performance.now();
      await lab.admin('pause',{});
      pauseStep=lab.game.elapsedSteps;
      collectScript();
      confirmExit(oldPid);
      await delay(400);
      assert.equal(lab.game.elapsedSteps,pauseStep);
      assert.equal(lab.visionMetrics().encoderPid,undefined);
      await lab.admin('resume',{});
      pauseMs=performance.now()-pauseStarted;
      lastCompleted=0;
      await lab.admin('program',{side:'blue',code:script});
    }
    await delay(5);
  }
  const wallMs=performance.now()-start;
  collectScript();
  assert.equal(lab.game.status,'ended');
  assert.equal(lab.game.elapsedSteps,roundMs*RULES.tickHz/1000);
  assert.equal(lab.game.tickCount,RULES.durationMs*RULES.tickHz/1000);
  assert.ok(pauseStep);
  await lab.admin('stop',{});
  await lab.waitForRecording();
  const metrics=lab.visionMetrics();
  for(const pid of pids)confirmExit(pid);
  const recording=lab.recordingInfo();
  assert.equal(recording.status,'saved',recording.error);
  const record=JSON.parse(await readFile(recording.dataPath!,'utf8')) as RecordInput & {recording:{mapping:{hold:boolean;frameId:number;repeat?:string}[];fps:number;jpegIndex:unknown[];videoDurationMs:number}};
  assert.equal(replay(record).identical,true);
  assert.equal(record.recording.jpegIndex.length,metrics.completed);
  // Pausing may invalidate the one in-flight request before publication.
  assert.ok(metrics.captures >= metrics.completed && metrics.captures - metrics.completed <= 2);
  assert.equal(record.recording.mapping.length,Math.ceil(roundMs*record.recording.fps/1000)+1+record.recording.fps);
  const decoded=spawnSync(ffmpegPath(),['-v','error','-i',recording.videoPath!,'-progress','pipe:1','-nostats','-f','null','-'],{windowsHide:true,encoding:'utf8',timeout:30000});
  assert.equal(decoded.status,0,decoded.stderr);
  assert.equal(Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]),record.recording.mapping.length);
  await mkdir('.local/diagnostics',{recursive:true});
  const sampleFrame = record.recording.mapping.findIndex(f=>f.frameId===imageSample?.id && !f.hold);
  if (imageSample && sampleFrame>=0) {
    await writeFile('.local/diagnostics/shared-recording-source.jpg',imageSample.bytes);
    const sample=spawnSync(ffmpegPath(),['-y','-v','error','-i',recording.videoPath!,'-vf',`select=eq(n\\,${sampleFrame})`,'-frames:v','1','.local/diagnostics/shared-recording-mp4.png'],{windowsHide:true,encoding:'utf8',timeout:30000});
    assert.equal(sample.status,0,sample.stderr);
  }
  const activeSeconds=(wallMs-pauseMs)/1000;
  const decodeTimes=scriptSamples.flatMap(s=>s.decodeBins.flatMap((n,i)=>Array(n).fill(i)));
  const scriptCalls=scriptSamples.reduce((n,s)=>n+s.calls,0);
  const scriptWallMs=scriptSamples.reduce((n,s)=>n+s.wallMs,0);
  const report={version:RULES.version,config:PROVISIONAL_VISION,qscale:jpegQscale(PROVISIONAL_VISION.quality),
    conditions:`Local Windows headless, ${RULES.preparationMs/1000}s preparation + ${RULES.durationMs/1000}s battle, rotating runner and AI, shared JPEG spool, H.264 after match, one pause/resume, no DSH transport or model`,
    wallMs,pauseMs,pauseStep,firstFrameMs,physicalSteps:lab.game.elapsedSteps,physicsHz:lab.game.elapsedSteps/activeSeconds,
    controlBoundaries:lab.game.elapsedSteps/4,controlHz:lab.game.elapsedSteps/4/activeSeconds,
    encodeRequests:metrics.captures,publishedFrames:metrics.completed,newJpegHz:metrics.completed/activeSeconds,droppedSlots:metrics.droppedSlots,
    observer:{calls,repeats,repeatRatio:repeats/calls,unobservedFrameIds:skipped,frameAgeMs:percentile(frameAge),authorityAgeMs:percentile(authorityAge)},
    jpeg:{captureToPublishMs:percentile(delivery),intervalMs:percentile(intervals),renderMs:percentile(render),pipeAndEncodeMs:percentile(encode),
      encoderStarts:metrics.encoderStarts,failures:metrics.failures,maxPending:metrics.maxPending,maxQueued:metrics.maxQueued,cleanupConfirmed:true},
    runner:{actualAppliedActions:record.actions.filter(a=>a.action&&a.source==='script').length,
      actualAppliedHz:record.actions.filter(a=>a.action&&a.source==='script').length/activeSeconds,
      sampledCalls:scriptCalls,sampledWallMs:scriptWallMs,sampledActionHz:scriptCalls*1000/scriptWallMs,
      repeatRatio:scriptSamples.reduce((n,s)=>n+s.repeats,0)/scriptCalls,decodeMsFloorBinned:percentile(decodeTimes)},
    recording:{...recording,videoDurationMs:record.recording.videoDurationMs,gapHoldFrames:record.recording.mapping.filter(f=>f.repeat==='gap').length,
      nonHoldFrames:record.recording.mapping.filter(f=>!f.hold).length,replayIdentical:true,fullyDecoded:true,sampleFrame}};
  await writeFile('.local/diagnostics/vision-endurance-shared-recording.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await lab.dispose(); }
