// CPU/serialization benchmark only. No DSH, browser, server or preview is started.
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Laboratory } from '../src/host/service.js';
import { paintScene, type DisplayFrame } from '../src/shared/scene.js';
import { canvasPainter } from '../src/client/canvas.js';
import { RULES } from '../src/shared/protocol.js';
const lab=new Laboratory(path.resolve('.local/benchmarks/referee'));
const samples=600,old:number[]=[],current:number[]=[],physics:number[]=[],commands:number[]=[];
let oldBytes=0,newBytes=0,callCount=0,maxCalls=0;
const count=()=>{callCount++;};
// Measures JS command submission preparation; this is NOT browser Canvas/GPU time.
const fake={fillRect:count,beginPath:count,arc:count,stroke:count,fill:count,moveTo:count,lineTo:count} as unknown as CanvasRenderingContext2D;
const painter=canvasPainter(fake);
const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return{p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)};};
try{
  lab.game.start({clock:'stepped',scenario:'duel',targetSpin:0,controllers:{blue:'fixed',red:'fixed'}});
  while(lab.game.status==='countdown')lab.game.advance(Math.min(480,Math.ceil(lab.game.countdownMs*RULES.tickHz/1000)));
  for(let i=0;i<samples+60;i++){
    const t0=performance.now();lab.game.advance(4);const t1=performance.now();
    const png=JSON.stringify(lab.game.observe());const t2=performance.now();
    const response=await lab.admin('display',{}) as {frame:DisplayFrame};const json=JSON.stringify(response);const t3=performance.now();
    callCount=0;paintScene(response.frame,painter);const t4=performance.now();
    if(i>=60){old.push(t2-t1);current.push(t3-t2);physics.push(t1-t0);commands.push(t4-t3);oldBytes+=Buffer.byteLength(png);newBytes+=Buffer.byteLength(json);maxCalls=Math.max(maxCalls,callCount);}
  }
  const report={version:RULES.version,node:process.version,platform:process.platform,scenario:'two fixed shooters, stepped 240Hz, four physics ticks per sample, 60 warmup + 600 measured samples',resolution:'960x680',samples,physicsFourTicksMs:stats(physics),pngObservationAndJsonMs:stats(old),ownerDisplayAndJsonMs:stats(current),paintCommandPreparationMs:stats(commands),maxCanvasMethodCalls:maxCalls,meanJsonBytes:{png:oldBytes/samples,display:newBytes/samples},excluded:'No live DSH transport, browser Canvas raster/GPU, monitor vsync, real FPS or user input latency measured.'};
  await mkdir('.local/diagnostics',{recursive:true});await writeFile('.local/diagnostics/render-benchmark.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await lab.dispose();}
