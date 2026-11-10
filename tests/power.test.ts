import { startReady, finishPreparation } from './support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RULES as R, validateTuning, validateSimulationPower, type TuningInput } from '../src/shared/protocol.js';
import { motionCaps } from '../src/shared/motion.js';
import { createState, neutral, tick, velocity, DT, wrap } from '../src/host/physics.js';
import { TracedGame as Game } from './support.js';
import { Game as ProductionGame } from '../src/host/game.js';
import { TracedLaboratory as Laboratory } from './support.js';
import { replay } from '../src/host/replay.js';
import { createRoomSetup, switchRoomSeat, validateRoomSetup } from '../src/client/room.js';
import { RoomPanel } from '../src/client/RoomPanel.js';
import { HelpDialog } from '../src/client/HelpDialog.js';
import { numericInput } from '../src/client/controls.js';
import { SimulationNumericsError } from '../src/shared/numerics.js';
test('缺省采用200血量50功率，显式历史配置保留',()=>{
  assert.deepEqual(validateTuning({hp:200,damage:31}),{hp:200,damage:31,power:50});
  assert.equal(validateTuning().power,50);assert.equal(createRoomSetup().tuning?.power,50);
  assert.equal(validateTuning().hp,200);assert.deepEqual(createRoomSetup().tuning,{hp:200,damage:10,power:50});
  assert.deepEqual(validateTuning({hp:100,damage:10,power:100}),{hp:100,damage:10,power:100});
  for(const spin of [-1,-0.8,-0.5,0,0.5,0.8,1]){
    const a={...neutral(),moveX:1,moveY:1,spin},v=velocity(a),demand=Math.hypot(1,spin);
    assert.deepEqual(v,velocity(a,50));assert.ok(Math.abs(Math.hypot(v.x,v.y)-184/demand)<1e-12);assert.ok(Math.abs(v.omega-spin*8/demand)<1e-12);
  }
});

test('历史功率可继续模拟，零功率仅冻结底盘',()=>{
  assert.ok(Number.isNaN(numericInput('')));assert.ok(Number.isNaN(numericInput('   ')));
  assert.equal(numericInput('0'),0);assert.equal(numericInput('0.125'),.125);
  for(const power of [0,.125,24.5,401,625,10000,Number.MIN_VALUE]) {
    assert.equal(validateSimulationPower(power),power);
    const state=createState({hp:200,damage:10,power}),before=structuredClone(state.robots.blue);
    tick(state,{blue:{...neutral(),moveX:1,spin:1,aimX:0,aimY:0,fire:true},red:neutral(state.robots.red)});
    for(const r of Object.values(state.robots))for(const value of Object.values(r))if(typeof value==='number')assert.ok(Number.isFinite(value));
    if(power===0){assert.equal(state.robots.blue.x,before.x);assert.equal(state.robots.blue.angle,before.angle);}
    assert.notEqual(state.robots.blue.turret,before.turret);assert.equal(state.robots.blue.shots,1);
  }
});

test('极端功率按实际浮点精度拒绝，困难旋转碰撞按计算预算明确失败并回滚整步',()=>{
  assert.throws(()=>validateSimulationPower(Number.MAX_VALUE),/浮点碰撞精度/);
  const state=createState({hp:200,damage:10,power:1e12}),r=state.robots.red;
  state.bullets=[{id:1,owner:'blue',x:r.x+31.2,y:r.y,vx:0,vy:0}];
  const before=structuredClone(state);
  assert.throws(()=>tick(state,{blue:{...neutral(),fire:true,moveX:.1},red:{...neutral(r),spin:1}}),SimulationNumericsError);
  assert.deepEqual(state,before);
});
test('功率平方根缩放移动和旋转能力，归一化速度平方和受预算约束',()=>{
  for(const power of [25,50,100,200,400]){
    const caps=motionCaps(power);assert.ok(Math.abs(caps.maxSpeed-184*Math.sqrt(power/50))<1e-12);assert.ok(Math.abs(caps.maxSpin-8*Math.sqrt(power/50))<1e-12);
    for(const spin of [-1,-0.8,-0.5,0,0.5,0.8,1])for(const [moveX,moveY]of [[1,0],[-1,0],[1,1],[-1,-1],[0.3,0.4],[0,0]]){
      const v=velocity({...neutral(),moveX,moveY,spin},power);
      const used=(v.x*v.x+v.y*v.y)/184**2+(v.omega/8)**2;
      const expected=Math.min(1,Math.min(1,moveX*moveX+moveY*moveY)+spin*spin)*power/50;
      assert.ok(Math.abs(used-expected)<1e-12);assert.ok(used<=power/50+1e-12);
    }
  }
  assert.equal(velocity({...neutral(),moveX:1},50).x,184);
  assert.ok(Math.abs(velocity({...neutral(),moveX:1},200).x-368)<1e-12);
  assert.ok(Math.abs(velocity({...neutral(),spin:1},200).omega-16)<1e-12);
});
test('宿主tick实际应用所选功率，双方运动一致，射击伤害和弹速独立',()=>{
  for(const power of [25,100,400]){
    const s=createState({hp:200,damage:37,power}),b=s.robots.blue,r=s.robots.red;
    const bx=b.x,rx=r.x,ba=b.angle,ra=r.angle;
    const a={blue:{...neutral(b),moveX:1,spin:0.8},red:{...neutral(r),moveX:-1,spin:0.8}};
    const demand=Math.hypot(1,.8),expected=motionCaps(power).maxSpeed/demand;
    for(let i=0;i<24;i++)tick(s,a);
    assert.ok(Math.abs(b.x-bx-expected*24*DT)<1e-9);assert.ok(Math.abs(rx-r.x-expected*24*DT)<1e-9);
    assert.ok(Math.abs(wrap(b.angle-ba)-motionCaps(power).maxSpin*.8/demand*24*DT)<1e-9);
    assert.ok(Math.abs(wrap(r.angle-ra)-wrap(b.angle-ba))<1e-9);
    const shot=createState({hp:200,damage:37,power});
    shot.robots.red.angle=0;
    shot.bullets=[{id:1,owner:'blue',x:shot.robots.red.x-80,y:shot.robots.red.y+8,vx:50000,vy:0}];
    tick(shot,{blue:neutral(shot.robots.blue),red:neutral(shot.robots.red)});assert.equal(shot.robots.red.hp,163);
    const gun=createState({hp:200,damage:37,power});tick(gun,{blue:{...neutral(gun.robots.blue),fire:true},red:neutral(gun.robots.red)});
    assert.equal(gun.robots.blue.shots,1);assert.equal(Math.hypot(gun.bullets[0].vx,gun.bullets[0].vy),R.bulletSpeed);
  }
});
test('房间和宿主共用三个整数闭区间，旧配置越界时保留原值并阻止新局',async()=>{
  const lab=new Laboratory(path.resolve('.local/power-tests/referee'));
  try{
    const setup=createRoomSetup();setup.countdownMs=0;await lab.admin('start',{setup});const match=lab.game.matchId,scripts=await lab.library.list();
    const markup = (draft:typeof setup) => renderToStaticMarkup(React.createElement(RoomPanel,{setup:draft,scripts,playerSide:'blue',connection:'ready',connectionError:'',busy:false,change(){},selectSide(){},enter(){},retry(){},continueMatch(){}}));
    for (const [field,label,min,max] of [['hp','生命值',50,1000],['damage','攻击力',1,100],['power','功率',1,300]] as const) {
      const message = `${label}：请输入 [${min}, ${max}] 范围内的整数`;
      const inputLabel = field==='hp'?'血量':label;
      assert.match(markup(setup),new RegExp(`aria-label="${inputLabel}"[^>]+min="${min}" max="${max}" step="1"`));
      for (const value of [min-1,max+1,min+.5,NaN,Infinity,null,String(min),'']) {
        const tuning={...setup.tuning!,[field]:value};
        assert.throws(()=>validateTuning(tuning),{message});
        const invalid={...setup,tuning:tuning as TuningInput};
        assert.deepEqual(validateRoomSetup(invalid,scripts),[message]);
        await assert.rejects(lab.admin('start',{setup:invalid}),{message});
        assert.equal(lab.game.matchId,match);
        const html=markup(invalid);
        assert.match(html,/data-testid="enter-match" disabled/);
        assert.ok(html.includes(message));
        if (typeof value === 'number' && Number.isFinite(value)) assert.ok(html.includes(`value="${value}"`));
      }
    }
    for (const tuning of [{hp:50,damage:1,power:1},{hp:1000,damage:100,power:300}]) {
      const accepted={...setup,tuning};
      assert.deepEqual(validateRoomSetup(accepted,scripts),[]);
      await lab.admin('start',{setup:accepted});
      assert.deepEqual(lab.game.setup.tuning,tuning);
    }
  }finally{await lab.dispose();}
});
test('功率在房间选择、停止返回、重开、观测和记录中保留，回放应用同一参数',async()=>{
  const lab=new Laboratory(path.resolve('.local/power-tests/referee'));
  try{
    const room=createRoomSetup();room.tuning={hp:180,damage:17,power:225};room.countdownMs=0;
    const switched=switchRoomSeat(room,'blue','red');assert.equal(switched.tuning?.power,225);
    await lab.admin('start',{setup:switched});assert.equal(lab.game.observe().rules.power,225);
    await lab.admin('stop',{});const returned=lab.game.setup;assert.equal(returned.tuning?.power,225);
    await lab.admin('start',{setup:returned});assert.equal(lab.game.setup.tuning?.power,225);
  }finally{await lab.dispose();}
  for(const power of [25,225,300]){
    const g=new Game();startReady(g,{clock:'stepped',scenario:'duel',targetSpin:0,tuning:{hp:180,damage:17,power},controllers:{blue:'agent',red:'idle'}});
    g.action('blue',{...neutral(),moveX:1,spin:.5,durationMs:500},'agent');g.advance(120);g.stop();
    const record=g.refereeRecord();assert.equal(record.rules.power,power);assert.equal(record.setup.tuning?.power,power);assert.equal(record.finalState.tuning.power,power);
    assert.equal(g.display().scene.tuning.power,power);assert.equal(replay(record).identical,true);
    assert.throws(()=>replay({...record,setup:{...record.setup,tuning:{hp:180,damage:17,power:100}}}),/初始快照与记录配置不一致/);
  }
});
test('旧录像保留低生命值、零功率、小数和超过新上限的功率',()=>{
  for (const power of [0,.125,401]) {
    const game = new ProductionGame(true,false,false,{version:'0.7.3',bulletSpeed:1000,fireHz:20,legacyActionTicks:false,heatEnabled:true,humanFireHz:10});
    const tuning={hp:37,damage:10,power};
    game.start({clock:'realtime',scenario:'duel',targetSpin:0,tuning,controllers:{red:'human',blue:'idle'}});
    finishPreparation(game);
    game.action('red',{...neutral(),spin:.6,moveY:.1,fire:true,durationMs:500},'human',120,true);
    game.advance(120);
    const record=game.refereeRecord();
    const restored=replay(record);
    assert.equal(restored.identical,true);
    assert.deepEqual(restored.actual.setup.tuning,tuning);
    assert.deepEqual(restored.actual.finalState.tuning,tuning);
    assert.equal(restored.actual.finalState.robots.red.shots,5);
    assert.equal(restored.actual.actions[0].heatProtection,true);
  }
});
test('0.7.8 replay retains rotation priority in the preparation and battle phases',()=>{
  const game=new ProductionGame(true,false,true,{version:'0.7.8',bulletSpeed:1000,fireHz:20,humanFireHz:10,legacyActionTicks:false,heatEnabled:true});
  game.start({clock:'stepped',scenario:'duel',targetSpin:0,controllers:{red:'agent',blue:'idle'}});
  game.action('red',{...neutral(),moveX:1,spin:.6,durationMs:100},'agent',24);
  game.advance(24);
  const angle=game.refereeRecord().finalState.robots.red.angle;
  assert.ok(Math.abs(angle-.96*Math.sqrt(.5))<1e-12);
  finishPreparation(game);
  game.action('red',{...neutral(),moveX:1,spin:.6,durationMs:100},'agent',24);
  game.advance(24);
  const record=game.refereeRecord();
  assert.ok(Math.abs(record.finalState.robots.red.x-210-368*Math.sqrt(.5)*.8/10)<1e-9);
  assert.equal(replay(JSON.parse(JSON.stringify(record))).identical,true);
});
test('0.7.9 replay retains its 3 m/s proportional motion calibration',()=>{
  const game=new ProductionGame(true,false,true,{version:'0.7.9',bulletSpeed:1000,fireHz:20,humanFireHz:10,legacyActionTicks:false,heatEnabled:true});
  startReady(game,{clock:'stepped',scenario:'duel',targetSpin:0,controllers:{red:'agent',blue:'idle'}});
  game.action('red',{...neutral(),moveX:1,spin:1,durationMs:100},'agent',24);
  game.advance(24);
  const record=game.refereeRecord();
  assert.equal(record.rules.maxSpeed,138);
  assert.ok(Math.abs(record.finalState.robots.red.x-210-13.8/Math.SQRT2)<1e-9);
  assert.equal(replay(JSON.parse(JSON.stringify(record))).identical,true);
});
test('帮助按有效功率预览速度并显示整数范围',async()=>{
  const lab=new Laboratory(path.resolve('.local/power-tests/referee'));
  try{
    const scripts=await lab.library.list();
    for(const [power,speed,spin]of [[1,'0.57','1.13'],[25,'2.83','5.66'],[50,'4.00','8.00'],[100,'5.66','11.31'],[300,'9.80','19.60']]as const){
      const setup=createRoomSetup();setup.tuning={hp:100,damage:10,power};
      const markup=renderToStaticMarkup(React.createElement(RoomPanel,{setup,scripts,playerSide:'blue',connection:'ready',connectionError:'',busy:false,change(){},selectSide(){},enter(){},retry(){},continueMatch(){}}));
      assert.match(markup,/aria-label="功率"/);assert.doesNotMatch(markup,/纯移动上限|纯旋转上限|弹速/);
      const help=renderToStaticMarkup(React.createElement(HelpDialog,{tuning:setup.tuning,close(){}}));assert.ok(help.includes(speed+' m/s'));assert.ok(help.includes(spin+' rad/s'));
      assert.match(help,/生命值 \[50, 1000\]、攻击力 \[1, 100\]、功率 \[1, 300\]，均为整数/);
    }
  }finally{await lab.dispose();}
});
