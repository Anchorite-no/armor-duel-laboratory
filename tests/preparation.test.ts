import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TracedGame as Game, neutralMotion } from './support.js';
import { TracedLaboratory as Laboratory } from './support.js';
import { createState, neutral, tick } from '../src/host/physics.js';
import { replay } from '../src/host/replay.js';
import { RULES } from '../src/shared/protocol.js';
import { KEYBOARD, keyboardSide, validateRoom } from '../src/shared/room.js';
import { createRoomSetup, selectRoomController } from '../src/client/room.js';
import { RoomPanel } from '../src/client/RoomPanel.js';
import { displayTime, interpolateFrames } from '../src/client/display.js';
const directory=()=>path.resolve('.local/preparation-tests',randomUUID(),'referee');
test('弹丸横穿外伸炮管继续飞行，随后碰到前板或裸底盘仍正确消弹',()=>{
  const s=createState(),r=s.robots.red;r.turret=0;
  s.bullets=[{id:1,owner:'blue',x:r.x+36,y:r.y-45,vx:0,vy:21600}];
  tick(s,{blue:neutral(s.robots.blue),red:neutral(r)});assert.equal(s.bullets.length,1);assert.equal(r.hp,RULES.hp);assert.equal(s.events.length,0);
  for(const [angle,hp,event]of [[0,RULES.hp-RULES.damage,'hit'],[Math.PI/4,RULES.hp,'block']]as const){
    const s=createState(),r=s.robots.red;r.angle=angle;r.turret=0;
    s.bullets=[{id:1,owner:'blue',x:r.x+80,y:r.y,vx:-50000,vy:0}];
    tick(s,{blue:neutral(s.robots.blue),red:neutral(r)});assert.equal(s.bullets.length,0);assert.equal(r.hp,hp);assert.equal(s.events[0].type,event);
  }
});
test('键盘、脚本与Agent准备期同等门控，动作按准备时间过期且跨开战不积压',()=>{
  for(const source of ['human','script','agent']as const){
    const g=new Game();g.start({clock:'realtime',scenario:'duel',targetSpin:0,controllers:{blue:source,red:'idle'}});
    const original=g.refereeRecord().finalState.robots.blue;
    g.action('blue',{...neutral(),moveX:1,moveY:1,spin:.5,aimX:0,aimY:0,fire:true,durationMs:100},source);
    if(source!=='human') assert.equal(g.fire('blue',source),false);
    g.advance(24);const posed=g.refereeRecord().finalState.robots.blue;
    assert.notEqual(posed.angle,original.angle);assert.notEqual(posed.turret,original.turret);assert.equal(posed.x,original.x);assert.equal(posed.y,original.y);assert.equal(posed.shots,0);assert.equal(posed.ammo,600);
    g.advance(24);assert.equal(g.refereeRecord().finalState.robots.blue.angle,posed.angle,'lease must expire while battle tick remains zero');
    g.advance(480);g.advance(480);g.advance(191);assert.equal(g.elapsedSteps,1199);assert.equal(g.status,'countdown');assert.equal(g.tickCount,0);
    g.action('blue',{...neutral(),moveX:1,fire:true,spin:.25,durationMs:500},source);g.advance(1);assert.equal(g.status,'running');assert.equal(g.tickCount,0);const ready=g.refereeRecord().finalState.robots.blue;
    g.advance(24);const started=g.refereeRecord().finalState.robots.blue;assert.equal(started.x,ready.x);assert.equal(started.angle,ready.angle);assert.equal(started.shots,0);assert.equal(g.tickCount,24);
    const prepActions=g.refereeRecord().actions.filter(a=>a.action&&a.step<1200);assert.ok(prepActions.every(a=>a.action!.moveX===0&&a.action!.moveY===0&&!a.action!.fire));
    g.action('blue',{...neutral(),moveX:1,fire:source==='human',durationMs:100},source);
    if(source!=='human') assert.equal(g.fire('blue',source),true);
    g.advance(1);assert.ok(g.refereeRecord().finalState.robots.blue.x>original.x);assert.equal(g.refereeRecord().finalState.robots.blue.shots,1);
    g.stop();assert.equal(replay(g.refereeRecord()).identical,true);
  }
});
test('键盘管理入口与按步工具入口在准备期实际接受旋转并屏蔽移动射击',async()=>{
  const lab=new Laboratory(directory());
  try{
    await lab.admin('start',{setup:createRoomSetup()});const initial=lab.game.refereeRecord().finalState.robots.red;
    const result=await lab.admin('input',{matchId:lab.game.matchId,side:'red',action:{...neutral(),spin:.5,moveX:1,fire:true,durationMs:500}}) as {accepted:boolean};
    assert.equal(result.accepted,true);lab.game.advance(24);const posed=lab.game.refereeRecord().finalState.robots.red;assert.notEqual(posed.angle,initial.angle);assert.equal(posed.x,initial.x);assert.equal(posed.shots,0);
    await lab.admin('stop',{});
    await lab.admin('start',{setup:{clock:'stepped',scenario:'duel',targetSpin:0,controllers:{blue:'agent',red:'idle'}}});
    await lab.participant('act',{side:'blue',action:{...neutralMotion(),spin:.5,moveX:1,durationMs:500}},'agent');
    const o=await lab.participant('fire',{side:'blue'},'agent') as {frameId:number;image:{mimeType:string}};
    assert.equal(o.image.mimeType,'image/jpeg');assert.deepEqual(Object.keys(o).sort(),['frameId','image']);assert.equal(lab.game.countdownMs,4500);assert.equal(lab.game.refereeRecord().finalState.robots.blue.x,750);assert.equal(lab.game.observe().hud.blue.ammo,600);
  }finally{await lab.dispose();}
});
test('双方命名脚本在五秒准备期启动并完成观察与动作，停止清理且可重放',async()=>{
  const lab=new Laboratory(directory());
  const code=`let o=await lab.observe();await lab.log('keys:'+Object.keys(o).sort().join(','));await lab.act({moveX:1,moveY:1,spin:.5,aimX:.5,aimY:0,durationMs:100});o=await lab.fire();await lab.log('after:'+o.image.mimeType);await lab.sleep(10000);`;
  try{
    const blue=await lab.library.save('蓝方准备',code),red=await lab.library.save('红方准备',code),setup=createRoomSetup();setup.room!.seats={blue:blue.id,red:red.id};
    // Stale controller/mode caches cannot override the selected seats.
    setup.controllers={blue:'human',red:'human'};await lab.admin('start',{setup});lab.startClock();
    const deadline=Date.now()+2500;
    while(Date.now()<deadline&&!['blue','red'].every(side=>lab.programs[side as 'blue'|'red'].info().output.includes('after:image/jpeg')))await new Promise(r=>setTimeout(r,20));
    assert.equal(lab.game.status,'countdown');assert.deepEqual(lab.game.setup.controllers,{blue:'script',red:'script'});
    for(const side of ['blue','red']as const){assert.match(lab.programs[side].info().output,/keys:frameId,image/);assert.match(lab.programs[side].info().output,/after:image\/jpeg/);assert.equal(lab.game.observe().hud[side].ammo,600);}
    assert.equal(lab.game.tickCount,0);assert.equal(lab.game.refereeRecord().finalState.bullets.length,0);
    await lab.admin('stop',{});assert.equal(lab.programs.blue.info().status,'stopped');assert.equal(lab.programs.red.info().status,'stopped');assert.equal(replay(lab.game.refereeRecord()).identical,true);
  }finally{await lab.dispose();}
});
test('控制者选择唯一决定房间，转移单套键盘、派生观战并兼容旧房间',async()=>{
  const lab=new Laboratory(directory());
  try{
    const scripts=await lab.library.list(),setup=selectRoomController(createRoomSetup(),'blue',KEYBOARD);
    const redKeyboard=selectRoomController(setup,'red',KEYBOARD);assert.deepEqual(redKeyboard.room?.seats,{blue:'builtin:privileged',red:KEYBOARD});assert.equal(keyboardSide(redKeyboard.room),'red');assert.equal(setup.room?.seats.blue,KEYBOARD);
    const eve=selectRoomController(redKeyboard,'red','builtin:spinner');assert.equal(keyboardSide(eve.room),undefined);
    await lab.admin('start',{setup:eve});assert.deepEqual(lab.game.setup.controllers,{blue:'privileged',red:'privileged'});
    assert.deepEqual(Object.keys(lab.game.setup.room!),['seats']);
    assert.throws(()=>validateRoom({seats:{blue:KEYBOARD,red:KEYBOARD}},scripts),/一套键鼠/);
    await assert.rejects(lab.admin('start',{setup:{...setup,room:{seats:{blue:KEYBOARD,red:KEYBOARD}}}}),/一套键鼠/);
    const legacy={...setup,countdownMs:0,room:{mode:'pve',playerSide:'red',scripts:{blue:'builtin:spinner',red:'builtin:computer'}}};
    await lab.admin('start',{setup:legacy});assert.deepEqual(lab.game.setup.room,{seats:{blue:'builtin:privileged',red:KEYBOARD}});assert.equal(lab.game.setup.countdownMs,5000);
    const markup=renderToStaticMarkup(React.createElement(RoomPanel,{setup:eve,scripts,playerSide:'blue',connection:'ready',connectionError:'',busy:false,change(){},selectSide(){},enter(){},retry(){},continueMatch(){}}));
    assert.match(markup,/蓝方控制者/);assert.match(markup,/红方控制者/);assert.doesNotMatch(markup,/PVE|EVE|P \/ 键盘|E \/ 脚本/);assert.doesNotMatch(markup,/固定 5 秒准备/);assert.doesNotMatch(markup,/对局模式|开局准备|3 秒倒计时|直接开始|PVE或EVE模式/);
  }finally{await lab.dispose();}
});
test('准备期旋转可插值显示，暂停与提前停止的准备动作可精确回放',()=>{
  const g=new Game();g.start({clock:'stepped',scenario:'duel',targetSpin:0,controllers:{blue:'agent',red:'idle'}});
  g.action('blue',{...neutral(),spin:1,aimX:0,aimY:0,durationMs:500},'agent');g.advance(4);const a=g.display();g.advance(4);const b=g.display();
  const m=interpolateFrames(a,b,(displayTime(a)+displayTime(b))/2);assert.equal(m.timestampMs,0);assert.ok(m.countdownMs<a.countdownMs&&m.countdownMs>b.countdownMs);assert.ok(m.scene.robots.blue.angle>a.scene.robots.blue.angle&&m.scene.robots.blue.angle<b.scene.robots.blue.angle);
  g.advance(112);g.pause();g.resume();g.advance(120);g.stop();const record=g.refereeRecord();assert.equal(record.finalTick,0);assert.equal(record.finalStep,240);assert.equal(replay(record).identical,true);
  const frame=g.refereeFrame(1);assert.equal(frame.status,'countdown');assert.equal(frame.countdownMs,4500);assert.equal(frame.timestampMs,0);
  assert.equal(record.rules.preparationMs,RULES.preparationMs);
});
