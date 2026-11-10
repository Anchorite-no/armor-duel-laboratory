import { startReady, finishPreparation } from './support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TracedLaboratory as Laboratory } from './support.js';
import { TracedGame as Game } from './support.js';
import { FrameBuffer, interpolateFrames } from '../src/client/display.js';
import { neutral } from '../src/host/physics.js';
import { renderPixels } from '../src/host/render.js';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { RoomPanel } from '../src/client/RoomPanel.js';
import { createRoomSetup } from '../src/client/room.js';
import { paintScene, type Painter } from '../src/shared/scene.js';
import { canvasPainter } from '../src/client/canvas.js';
import { RULES } from '../src/shared/protocol.js';
const setup={clock:'stepped' as const,scenario:'duel' as const,targetSpin:0,controllers:{blue:'agent' as const,red:'idle' as const}};
test('页面显示通道不编码PNG、不推进按步时间，参赛接口拒绝显示真值',async()=>{
  const lab=new Laboratory(path.resolve('.local/display-tests/referee'));
  try{
    startReady(lab.game,setup);lab.game.observe=()=>{throw Error('PNG must not be generated');};
    const response=await lab.admin('display',{}) as {frame:ReturnType<Game['display']>;observation:object};
    assert.equal(response.frame.timestampMs,0);assert.ok(!('image'in response.observation));
    assert.ok(JSON.stringify(response).length<5000);
    await assert.rejects(lab.participant('display',{},'script'),/Participant request failed/);
    await assert.rejects(lab.participant('display',{},'agent'),/Participant request failed/);
    response.frame.scene.robots.red.hp=1;assert.equal(lab.game.refereeRecord().finalState.robots.red.hp,200);
  }finally{await lab.dispose();}
});
test('显示帧与裁判状态使用同一几何绘制，帧率不改变权威状态',()=>{
  const g=new Game();startReady(g,setup);g.action('blue',{...neutral(),moveX:1,spin:0.5,durationMs:500},'agent');g.advance(60);
  const record=g.refereeRecord(),frame=g.display();
  assert.deepEqual(renderPixels(frame.scene,frame.status),renderPixels(record.finalState,g.status));
  for(let i=0;i<120;i++)g.display();assert.deepEqual(g.refereeRecord().finalState,record.finalState);
});
test('快照之间插值有真实中间位置、角度走短弧；实体出现消失不凭空预测',()=>{
  const g=new Game();startReady(g,setup);const a=g.display();const b=structuredClone(a);b.timestampMs=100;b.scene.tick=24;
  b.scene.robots.blue.x+=17;a.scene.robots.blue.angle=Math.PI-0.1;b.scene.robots.blue.angle=-Math.PI+0.1;
  a.scene.bullets=[{id:1,owner:'blue',x:100,y:200,vx:420,vy:0}];b.scene.bullets=[];
  const m=interpolateFrames(a,b,50);assert.equal(m.scene.robots.blue.x,a.scene.robots.blue.x+8.5);
  assert.ok(Math.abs(m.scene.robots.blue.angle-Math.PI)<1e-12);assert.equal(m.scene.bullets[0].x,100);
  assert.equal(interpolateFrames(a,b,100).scene.bullets.length,0);
  assert.deepEqual(interpolateFrames(a,b,1000),b);
  const delayed={...b,timestampMs:1000};assert.equal(interpolateFrames(a,delayed,500),delayed);
});
test('33ms插值缓冲、断流不外推，暂停与换局直接切换；30Hz数据可产生60Hz不同位置',()=>{
  const g=new Game();startReady(g,setup);const seed=g.display(),buffer=new FrameBuffer();
  let updates=0;const xs:number[]=[];
  for(let i=0;i<120;i++){
    const now=i*1000/60;
    if(i%2===0){const f=structuredClone(seed);f.timestampMs=now;f.scene.robots.blue.x+=now*0.17;buffer.push(f,now);updates++;}
    const f=buffer.sample(now);if(i>10)xs.push(f!.scene.robots.blue.x);
  }
  assert.equal(updates,60);assert.ok(new Set(xs).size>100);
  const last=buffer.sample(10000)!;assert.ok(last.timestampMs<=118*1000/60);
  const paused={...last,status:'paused' as const};buffer.push(paused,11000);assert.equal(buffer.sample(12000)?.status,'paused');
  const next={...seed,matchId:'next',timestampMs:0};buffer.push(next,13000);assert.equal(buffer.sample(13000)?.matchId,'next');
});
test('房间按红方、设置、蓝方排序，绑定保留且预览炮管平行反向',async()=>{
  const lab=new Laboratory(path.resolve('.local/display-tests/referee'));
  try{
    const setup=createRoomSetup();setup.room!.seats={blue:'keyboard',red:'builtin:spinner'};
    const original=structuredClone(setup);
    const markup=renderToStaticMarkup(React.createElement(RoomPanel,{setup,scripts:await lab.library.list(),playerSide:'blue',connection:'ready',connectionError:'',busy:false,change(){},selectSide(){},enter(){},retry(){},continueMatch(){}}));
    const blue=markup.indexOf('class="room-seat blue'),center=markup.indexOf('class="room-options'),red=markup.indexOf('class="room-seat red');
    assert.ok(red>=0&&red<center&&center<blue);
    const redCard=markup.slice(red,center),blueCard=markup.slice(blue);
    assert.match(redCard,/>红方<\/span>/);assert.match(redCard,/aria-label="红方控制者"/);
    assert.match(redCard,/<option value="builtin:privileged" selected=""/);
    assert.match(blueCard,/>蓝方<\/span>/);assert.match(blueCard,/aria-label="蓝方控制者"/);
    assert.match(blueCard,/<option value="keyboard" selected=""/);
    for (const card of [redCard,blueCard]) for (const angle of [45,135,225,315]) {
      assert.ok(card.includes(`transform="rotate(${angle})"`));
    }
    assert.match(redCard,/class="robot-barrel" transform="rotate\(180 120 90\)"/);
    assert.match(blueCard,/class="robot-barrel" transform="rotate\(0 120 90\)"/);
    assert.equal((markup.match(/d="M120 90L77 65"/g)??[]).length,4);
    assert.deepEqual(setup,original);
    assert.equal((markup.match(/class="robot-body" cx="120" cy="90" r="34.5"/g)??[]).length,2);
    assert.ok(!markup.includes('cy="95"'));assert.equal((markup.match(/width="4" height="12"/g)??[]).length,8);
    assert.doesNotMatch(markup,/功率上限（%）|功率 25%|100% 为当前基准/);
  }finally{await lab.dispose();}
});
test('共享绘制与Canvas中底盘、轮缘、轮毂同心，插值不引入偏移外圈',()=>{
  const g=new Game();startReady(g,setup);
  for(const angle of [0,Math.PI/7,Math.PI/2]){
    const a=g.display(),b=structuredClone(a);b.timestampMs=100;
    a.scene.robots.blue.angle=angle;b.scene.robots.blue.angle=angle+0.1;
    b.scene.robots.blue.x+=11.5;b.scene.robots.blue.y+=5.5;
    const frame=interpolateFrames(a,b,50),circles:{x:number;y:number;r:number}[]=[],texts:string[]=[];
    const recorder:Painter={circle(x,y,r){circles.push({x,y,r});},pixel(){},line(){},rect(){},text(s){texts.push(s);}};
    paintScene(frame,recorder);
    assert.ok(texts.some(t=>t.startsWith('弹药 ')));assert.ok(!texts.some(t=>t.includes('功率')));
    for(const side of ['blue','red']as const){
      const r=frame.scene.robots[side],local=circles.filter(c=>Math.hypot(c.x-r.x,c.y-(r.y+80))<40&&c.r>=8);
      assert.deepEqual(local.map(c=>c.r),[RULES.bodyRadius,RULES.bodyRadius,11,8]);
      for(const c of local){assert.equal(c.x,r.x);assert.equal(c.y,r.y+80);}
    }
    const arcs:{x:number;y:number;r:number}[]=[];
    const fake={beginPath(){},arc(x:number,y:number,r:number){arcs.push({x,y,r});},fill(){},stroke(){},fillRect(){},moveTo(){},lineTo(){}} as unknown as CanvasRenderingContext2D;
    paintScene(frame,canvasPainter(fake));
    for(const side of ['blue','red']as const){const r=frame.scene.robots[side];const body=arcs.filter(c=>c.r===RULES.bodyRadius||c.r===RULES.bodyRadius-.75);assert.equal(body.filter(c=>c.x===r.x&&c.y===r.y+80).length,2);}
  }
});
test('PNG去掉偏移的大黑投影，实体轮廓外不留假机身',()=>{
  const g=new Game();startReady(g,setup);const f=g.display(),pixels=renderPixels(f.scene,f.status);
  for(const side of ['blue','red']as const){const r=f.scene.robots[side];for(const dy of [-24,24]){
    const i=((r.y+80+dy)*pixels.width+r.x+10)*3;assert.ok(pixels.data[i]>=40,'outside body disk and armor must show floor, not offset black shadow');
  }}
});
