// Headless diagnostics: no DSH, browser, listener, paid model or account access.
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createState,tick,prepareTick,neutral} from '../src/host/physics.js';
import {computerAction} from '../src/host/opponent.js';
import {stationaryMotion,robotPoses,observedMotion,traditionalSnapshot} from '../src/host/traditional-state.js';
import {RULES} from '../src/shared/protocol.js';
import {CONTROL_STEPS} from '../src/shared/control.js';
import {Laboratory} from '../src/host/service.js';
const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {p50:sorted[Math.floor(sorted.length*.5)]??0,p95:sorted[Math.floor(sorted.length*.95)]??0,max:sorted.at(-1)??0};};
function rotatingTarget(controlHz:number,seed:number){
  const state=createState({hp:1000,damage:1,power:50}),period=RULES.tickHz/controlHz;
  let motion=stationaryMotion(),action=neutral(state.robots.red);const decisionMs:number[]=[];
  const started=performance.now();
  for(let step=0;step<1200+240*20;step++){
    const status=step<1200?'countdown':'running',before=robotPoses(state.robots);
    if(step%period===0){const start=performance.now();action=computerAction(traditionalSnapshot(state,motion,step*1000/RULES.tickHz,status),'red',seed);decisionMs.push(performance.now()-start);}
    // Sample movement at the requested comparison rate, but keep the live
    // four-step fire lease so the 10 Hz comparison cannot fire twice per decision.
    const actions={red:{...action,fire:action.fire&&step%period<CONTROL_STEPS},blue:{...neutral(state.robots.blue),spin:.65}};
    if(status==='countdown')prepareTick(state,actions);else tick(state,actions);
    motion=observedMotion(before,state.robots);
    // Same bounded effects window as the authority, excluding journal/IO.
    state.events=state.events.filter(e=>state.tick-e.tick<=RULES.tickHz*.4);
  }
  const r=state.robots.red;
  return {controlHz,seed,battleSeconds:20,decisions:decisionMs.length,shots:r.shots,hits:r.hits,hitRate:r.shots?r.hits/r.shots:0,simulationCpuMs:performance.now()-started,decisionIncludingSnapshotMs:stats(decisionMs)};
}
async function visualScript(fps:number,decode=true){
  const lab=new Laboratory(path.resolve('.local/control-benchmark/referee'),{fps,width:960,quality:85});
  const waits:number[]=[],timer=setInterval(()=>{waits.push(performance.now());},8);
  try{
    await lab.admin('start',{setup:{clock:'realtime',scenario:'duel',targetSpin:0,controllers:{blue:'script',red:'computer'},controllerSeeds:{red:41,blue:9},tuning:{hp:1000,damage:1,power:50}}});
    while(lab.game.status==='countdown')lab.game.advance(Math.min(480,Math.round(lab.game.countdownMs*240/1000)));
    await lab.participant('observe',{},'script');
    lab.pump();waits.length=0;lab.startClock();const before=lab.visionMetrics(),startTick=lab.game.tickCount,start=performance.now();
    await lab.admin('program',{side:'blue',code:`
      const started=performance.now();let loops=0,frames=0,last=-1,decodeMs=0,decoded=0;
      while(performance.now()-started<3000){
        const o=await lab.act({moveX:0,moveY:0,spin:.6,aimX:.5,aimY:.5,durationMs:17});loops++;
        if(o.frameId!==last){last=o.frameId;frames++;if(${decode}){const t=performance.now();lab.pixels(o);decodeMs+=performance.now()-t;decoded++;}}
      }
      await lab.log(JSON.stringify({loops,uniqueObservedFrames:frames,uniqueDecodedFrames:decoded,decodeCpuMs:decodeMs,scriptWallMs:performance.now()-started}));
    `});
    const deadline=performance.now()+8000;while(lab.programs.blue.info().status==='running'&&performance.now()<deadline)await delay(10);
    lab.pump();const wallMs=performance.now()-start,after=lab.visionMetrics(),program=lab.programs.blue.info();
    if(program.status!=='ended')throw Error('Benchmark script failed: '+program.output);
    const script=JSON.parse(program.output.trim().split('\n').at(-1)!);
    const simulationSeconds=(lab.game.tickCount-startTick)/240;
    return {configuredFps:fps,decodeEnabled:decode,width:960,height:680,quality:85,wallMs,simulationSeconds,physicsSteps:lab.game.tickCount-startTick,physicsStepsPerWallSecond:(lab.game.tickCount-startTick)*1000/wallMs,encodedFrames:after.completed-before.completed,encodedFramesPerWallSecond:(after.completed-before.completed)*1000/wallMs,encoderRenderMs:after.renderMs-before.renderMs,encoderJpegMs:after.encodeMs-before.encodeMs,maxPendingFrames:after.maxPending,heartbeatGapMs:stats(waits.slice(1).map((t,i)=>t-waits[i])),...script};
  }finally{clearInterval(timer);await lab.dispose();}
}
const report={version:RULES.version,node:process.version,platform:process.platform,bulletSpeed:RULES.bulletSpeed,
  conditions:'Offscreen Node 24. 20s stationary rotating target, spin .65, power50, hp1000, damage1; identical policy/fire gate and seed, only decision cadence differs. Live 3s script loops (with/without decoding): integer duration17, JPEG960x680 quality85, shared cache, decode in restricted subprocess, opponent AI60Hz. Timers/serialization/child startup included; no recording.',
  rotatingTarget:[41,19,89].flatMap(seed=>[10,60].map(hz=>rotatingTarget(hz,seed))),visualScripts:[] as Awaited<ReturnType<typeof visualScript>>[],
  excluded:'No DSH IPC, browser Canvas raster/GPU, screen FPS, user input latency, paid model, full-round script endurance or OS CPU utilization measured. Timing instrumentation adds overhead. Hit-rate samples diagnose cadence only; not a performance metric or general accuracy guarantee.'};
for(const fps of [10,30])report.visualScripts.push(await visualScript(fps));
report.visualScripts.push(await visualScript(30,false));
await mkdir('.local/diagnostics',{recursive:true});await writeFile('.local/diagnostics/control-benchmark.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
