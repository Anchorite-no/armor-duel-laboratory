import { DEFAULT_AI, PRIVILEGED_AI } from '../src/shared/privileged-ai.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { COMPUTER,TRADITIONAL_POLICY,computerAction,interceptTime,aimingSolution,behaviorProfile } from '../src/host/opponent.js';
import { traditionalSnapshot,stationaryMotion,robotPoses,observedMotion } from '../src/host/traditional-state.js';
import { createState,tick,neutral,velocity } from '../src/host/physics.js';
import { validateAction,RULES } from '../src/shared/protocol.js';
import { TracedGame as Game } from './support.js';
import { TracedLaboratory as Laboratory } from './support.js';
import { createRoomSetup } from '../src/client/room.js';
import { replay } from '../src/host/replay.js';
test('特权快照包含双方完整机器人状态及已发生运动，只读且排除指令、程序、会话和环境日志',()=>{
  const state=createState(),before=robotPoses(state.robots);state.robots.blue.x=RULES.width-34;before.blue.x=state.robots.blue.x;
  tick(state,{blue:{...neutral(state.robots.blue),moveX:1,spin:.5,fire:true},red:neutral(state.robots.red)});
  const motion=observedMotion(before,state.robots),snapshot=traditionalSnapshot(state,motion,100,'running');
  assert.equal(snapshot.robots.blue.vx,0);assert.ok(Math.abs(snapshot.robots.blue.omega-4/Math.hypot(1,.5))<1e-9);assert.equal(snapshot.robots.blue.ammo,599);assert.ok(snapshot.robots.blue.cooldownMs>0);
  assert.equal(snapshot.robots.blue.armor.length,4);assert.equal(snapshot.robots.blue.armor[0].length,12);assert.equal(snapshot.geometry.bodyRadius,23);
  assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.robots.red)&&Object.isFrozen(snapshot.robots.blue.armor[0].normal));
  assert.throws(()=>{(snapshot.robots.blue as unknown as {hp:number}).hp=1;},TypeError);assert.equal(state.robots.blue.hp,200);assert.ok(!Object.isFrozen(state.robots.blue));
  assert.doesNotMatch(JSON.stringify(snapshot),/"(?:leases|actions|programs|sessions|bullets|events)":/);
});
test('固定提前量解算只用当前速度，横移目标有前导，无可达解时不保证开火',()=>{
  assert.equal(interceptTime(420,0,0,0,420,2),1);assert.equal(interceptTime(420,0,-420,0,420,2),.5);assert.equal(interceptTime(420,0,500,0,420,2),null);
  const state=createState();state.robots.blue.turret=0;state.robots.red.x=600;state.robots.red.angle=0;const motion=stationaryMotion();motion.red.vy=100;
  let snapshot=traditionalSnapshot(state,motion,0,'running'),aim=aimingSolution(snapshot,'blue');assert.equal(aim.feasible,true);assert.ok(aim.y>state.robots.red.y);assert.notEqual(aim.plate,null);
  assert.equal(computerAction(snapshot,'blue').fire,false,'turret is not aligned yet');
  state.robots.blue.turret=Math.atan2(aim.y-state.robots.blue.y,aim.x-state.robots.blue.x);snapshot=traditionalSnapshot(state,motion,0,'running');assert.equal(computerAction(snapshot,'blue').fire,true);
  motion.red.vx=-1600;assert.equal(aimingSolution(traditionalSnapshot(state,motion,0,'running'),'blue').feasible,false);
});
test('固定规则按距离和血量控距，墙边回避、周期横移、旋转防御，输出遵守统一动作和功率',()=>{
  const state=createState();state.robots.blue.x=300;state.robots.red.x=600;const motion=stationaryMotion();
  let action=computerAction(traditionalSnapshot(state,motion,0,'running'),'blue');assert.equal(action.moveX,0);assert.equal(action.moveY,.5);assert.ok(action.spin>=.35&&action.spin<=.55);
  assert.equal(computerAction(traditionalSnapshot(state,motion,((1-behaviorProfile(0).strafePhase)*behaviorProfile(0).strafePeriod+.01)*1000,'running'),'blue').moveY,-.5);
  state.robots.blue.hp=20;action=computerAction(traditionalSnapshot(state,motion,0,'running'),'blue');assert.equal(action.moveX,-.7);assert.equal(action.spin,.7);
  state.robots.blue.x=34;action=computerAction(traditionalSnapshot(state,motion,0,'running'),'blue');assert.ok(action.moveX>0,'pushes away from left wall');
  for(const side of ['blue','red']as const){const a=validateAction(computerAction(traditionalSnapshot(state,motion,1000,'running'),side)),v=velocity(a);assert.ok((v.x*v.x+v.y*v.y)/RULES.maxSpeed**2+(v.omega/RULES.maxSpin)**2<=1+1e-12);}
  state.robots.blue.ammo=0;assert.equal(computerAction(traditionalSnapshot(state,motion,0,'running'),'blue').fire,false);
  state.robots.blue.ammo=600;state.robots.blue.nextShot=100;assert.equal(computerAction(traditionalSnapshot(state,motion,0,'running'),'blue').fire,false);
});
test('全状态陪练仍按60Hz决策，准备期门控、有限枪械和确定性回放有效',()=>{
  const g=new Game();g.start({clock:'stepped',scenario:'duel',targetSpin:0,controllers:{blue:'idle',red:'computer'}});g.observe=()=>{throw Error('no participant image needed by privileged policy');};
  g.advance(240);let commands=g.refereeRecord().actions.filter(a=>a.source==='computer');assert.equal(commands.length,60);assert.ok(commands.every(a=>a.action!.moveX===0&&a.action!.moveY===0&&!a.action!.fire));
  g.advance(480);g.advance(480);g.advance(240);commands=g.refereeRecord().actions.filter(a=>a.source==='computer'&&a.step>=1200);assert.equal(commands.length,60);assert.ok(g.refereeRecord().finalState.robots.red.shots>0);assert.ok(g.refereeRecord().finalState.robots.red.shots<=10);assert.equal(replay(g.refereeRecord()).identical,true);
});
test('兼容原内置选择，名称和记录明确标记全状态特权及冻结策略版本',async()=>{
  const lab=new Laboratory(path.resolve('.local/opponent-tests',randomUUID(),'referee'));
  try{
    const selected=await lab.library.get('builtin:computer');assert.equal(selected.name,'全知传统 AI');assert.match(selected.description,/特权/);assert.equal(selected.implementation,'omniscient-traditional-v5');
    assert.deepEqual((await lab.library.list()).filter(s=>s.kind==='builtin').map(s=>s.id),[PRIVILEGED_AI.id]);
    await lab.admin('start',{setup:createRoomSetup()});const record=lab.game.refereeRecord();assert.equal(record.setup.scriptBindings?.[0].name,PRIVILEGED_AI.name);assert.equal(record.setup.scriptBindings?.[0].implementation,PRIVILEGED_AI.implementation);
    assert.deepEqual(record.controllerImplementations.blue,{...PRIVILEGED_AI,input:'robot-full-state',config:{...DEFAULT_AI}});assert.throws(()=>replay({...record,version:'0.5.2'}),/记录版本不支持/);
    const observation=await lab.participant('observe',{},'script');assert.deepEqual(Object.keys(observation as object).sort(),['frameId','image']);
    for(const method of ['centers','state','snapshot','configureVision']){await assert.rejects(lab.participant(method,{},'script'));await assert.rejects(lab.participant(method,{},'agent'));}
  }finally{await lab.dispose();}
});
