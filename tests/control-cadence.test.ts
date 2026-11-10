import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {TracedGame as Game,TracedLaboratory as Laboratory,finishPreparation,neutralMotion} from './support.js';
import {Game as ProductionGame} from '../src/host/game.js';
import {neutral} from '../src/host/physics.js';
import {RULES,validateAction,type Side} from '../src/shared/protocol.js';
import {CONTROL_HZ,CONTROL_STEPS} from '../src/shared/control.js';
import {traditionalSnapshot} from '../src/host/traditional-state.js';
import {computerAction,TRADITIONAL_POLICY} from '../src/host/opponent.js';
import {replay} from '../src/host/replay.js';
import {HumanInput,type InputContext} from '../src/client/human-input.js';
import {createRoomSetup} from '../src/client/room.js';
const base={clock:'realtime' as const,scenario:'duel' as const,targetSpin:0,controllers:{blue:'agent' as const,red:'idle' as const}};

test('240个物理步恰好60个控制边界，双方AI从同一时刻快照决策，分批推进无漂移',()=>{
  assert.equal(CONTROL_STEPS,4);assert.equal(CONTROL_HZ,60);
  const setup={...base,controllers:{blue:'computer' as const,red:'computer' as const},controllerSeeds:{red:19,blue:89}};
  const a=new Game(),b=new Game();a.start(setup);b.start(setup);finishPreparation(a);finishPreparation(b);
  const start=a.elapsedSteps;
  for(let boundary=0;boundary<60;boundary++){
    const record=a.refereeRecord(),input=traditionalSnapshot(record.finalState,record.finalMotion,a.elapsedSteps*1000/RULES.tickHz,a.status,RULES.tickHz/TRADITIONAL_POLICY.fireHz);
    const expected=Object.fromEntries((['blue','red'] as Side[]).map(side=>[side,computerAction(input,side,setup.controllerSeeds[side])]));
    a.advance(4);
    const pair=a.refereeRecord().actions.filter(entry=>entry.step===start+boundary*4&&entry.source==='computer');
    assert.equal(pair.length,2);for(const entry of pair){assert.deepEqual(entry.action,expected[entry.side!]);assert.equal(entry.effectiveTicks,4);}
  }
  for(let i=0;i<240;i++)b.advance(1);
  assert.equal(a.tickCount,240);assert.deepEqual(a.refereeRecord().finalState,b.refereeRecord().finalState);
  assert.equal(a.refereeRecord().actions.filter(entry=>entry.source==='computer'&&entry.step>=start).length,120);
  assert.equal(replay(a.refereeRecord()).identical,true);
});

test('human/Agent/script统一等待控制边界，17ms是4步而非5步，最新动作覆盖且租约后中立',()=>{
  for(const source of ['human','agent','script'] as const){
    const g=new Game();g.start({...base,controllers:{blue:source,red:'idle'}});finishPreparation(g);g.advance(1);
    const x=g.refereeRecord().finalState.robots.blue.x;
    g.action('blue',{...neutral(),moveX:-1,durationMs:17},source);
    const wait=g.action('blue',{...neutral(),moveY:1,durationMs:17},source);assert.equal(wait,7);
    g.advance(3);assert.equal(g.refereeRecord().actions.length,0);assert.equal(g.refereeRecord().finalState.robots.blue.x,x);
    g.advance(4);const r=g.refereeRecord();assert.equal(r.actions.length,1);assert.equal(r.actions[0].step,1204);assert.equal(r.actions[0].effectiveTicks,4);
    assert.equal(r.finalState.robots.blue.x,x);assert.ok(r.finalState.robots.blue.y>300);
    const y=r.finalState.robots.blue.y;g.advance(240);assert.equal(g.refereeRecord().finalState.robots.blue.y,y);
    g.stop();assert.equal(replay(g.refereeRecord()).identical,true);
  }
});

test('玩家辅助每秒实际更新60次，续租不重置控制相位，取消与切局丢弃待应用动作',()=>{
  const g=new Game();g.start({...base,controllers:{blue:'human',red:'idle'}});finishPreparation(g);
  for(let half=0;half<2;half++){g.humanInput('blue',{...neutral(),durationMs:500},true);g.advance(120);}
  const aims=g.refereeRecord().actions.filter(entry=>entry.aim);assert.equal(aims.length,60);
  assert.ok(aims.every((entry,i)=>entry.step===1200+i*4));
  g.advance(1);assert.equal(g.refereeRecord().humanAimAssist.events.at(-1)!.reason,'input-expired');
  g.humanInput('blue',{...neutral(),moveX:-1,fire:true,durationMs:500},true);g.cancel('blue','human');g.advance(4);
  const before=g.refereeRecord().finalState.robots.blue;assert.equal(before.shots,0);
  g.humanInput('blue',{...neutral(),moveX:-1,fire:true,durationMs:500},true);g.start({...base,controllers:{blue:'human',red:'idle'}});finishPreparation(g);g.advance(4);
  assert.equal(g.refereeRecord().humanAimAssist.used,false);assert.equal(g.refereeRecord().finalState.robots.blue.shots,0);
});

test('短按发射在采样前松开仍只触发一个控制周期，安全释放立即清空',()=>{
  const g=new Game();g.start({...base,controllers:{blue:'human',red:'idle'}});finishPreparation(g);g.advance(1);
  g.humanInput('blue',{...neutral(),fire:true,durationMs:500},false);
  g.humanInput('blue',{...neutral(),fire:false,durationMs:500},false);g.advance(120);
  assert.equal(g.refereeRecord().finalState.robots.blue.shots,1);g.stop();assert.equal(replay(g.refereeRecord()).identical,true);
  g.start({...base,controllers:{blue:'human',red:'idle'}});finishPreparation(g);g.advance(1);
  g.humanInput('blue',{...neutral(),fire:true,durationMs:500},false);g.cancel('blue','human');g.advance(120);assert.equal(g.refereeRecord().finalState.robots.blue.shots,0);
});

test('客户端在途期间的短按和Q/E边沿保留，确认旧包不会清除更新的短按',()=>{
  const input=new HumanInput(),context:InputContext={phase:'battle',connection:'ready',setup:createRoomSetup(),matchId:'one',status:'running',side:'red',focused:true,blocked:false};
  input.keyDown(context,'d');const old=input.packet(context)!;input.keyUp(context,'d');input.buttons(context,1);input.buttons(context,0);input.keyDown(context,'e');input.keyUp(context,'e');
  input.keyDown(context,'d');input.keyUp(context,'d');input.acknowledge(old);
  const next=input.packet(context)!;assert.equal(next.action.moveX,.8);assert.equal(next.action.fire,true);assert.equal(next.action.spin,.6);
  input.acknowledge(next);const released=input.packet(context)!;assert.equal(released.action.moveX,0);assert.equal(released.action.fire,false);assert.equal(released.action.spin,1);
  input.reset();assert.equal(input.packet(context)!.action.spin,0);
});

test('独立脚本慢计算不拖停实时物理，超时动作不补发；切局中的直接动作被取消',async()=>{
  const lab=new Laboratory(path.resolve('.local/cadence-tests',randomUUID(),'referee'),{fps:30,width:480,quality:50});
  try{
    await lab.admin('start',{setup:{...base,controllers:{blue:'script',red:'idle'}}});finishPreparation(lab.game);lab.startClock();
    await lab.admin('program',{side:'blue',code:`await lab.act({moveX:-1,moveY:0,spin:0,aimX:.5,aimY:.5,durationMs:17});const end=Date.now()+250;while(Date.now()<end){};await lab.sleep(500);`});
    const deadline=performance.now()+2000;while(!lab.game.refereeRecord().actions.some(a=>a.source==='script')&&performance.now()<deadline)await delay(10);
    const tick=lab.game.tickCount;await delay(160);assert.ok(lab.game.tickCount>tick+12);
    const x=lab.game.refereeRecord().finalState.robots.blue.x;await delay(100);assert.equal(lab.game.refereeRecord().finalState.robots.blue.x,x);
    assert.equal(lab.game.refereeRecord().actions.filter(a=>a.source==='script').length,1);assert.equal(lab.game.status,'running');
    await lab.admin('start',{setup:base});finishPreparation(lab.game);
    const pending=lab.participant('act',{side:'blue',action:{...neutralMotion(),moveX:-1,durationMs:500}},'agent');const rejected=assert.rejects(pending);
    await lab.admin('start',{setup:base});await rejected;finishPreparation(lab.game);lab.game.advance(240);
    assert.equal(lab.game.refereeRecord().finalState.robots.blue.x,750);
  }finally{await lab.dispose();}
});

test('实时act应用后即返回，500ms保持租约不限制下一次决策，租约到期仍停止',async()=>{
  const lab=new Laboratory(path.resolve('.local/cadence-tests',randomUUID(),'referee'),{fps:.25,width:480,quality:50});
  try{
    await lab.admin('start',{setup:base});finishPreparation(lab.game);await lab.participant('observe',{},'agent');
    await lab.participant('act',{side:'blue',action:{...neutralMotion(),moveX:-1,durationMs:500}},'agent');
    const first=lab.game.refereeRecord().actions.find(entry=>entry.action)!;
    assert.equal(first.effectiveTicks,120);assert.ok(lab.game.elapsedSteps<first.step+120);
    await lab.participant('act',{side:'blue',action:{...neutralMotion(),moveY:1,durationMs:100}},'agent');
    const second=lab.game.refereeRecord().actions.filter(entry=>entry.action).at(-1)!;
    assert.ok(second.step<first.step+120);assert.equal(second.step%4,0);assert.equal(second.effectiveTicks,24);
    lab.game.advance(120);const stopped=lab.game.refereeRecord().finalState.robots.blue;
    lab.game.advance(120);assert.equal(lab.game.refereeRecord().finalState.robots.blue.y,stopped.y);
  }finally{await lab.dispose();}
});

test('旧版按原弹速、射速和动作租约精确回放，不加入热量状态',()=>{
  for(const version of ['0.6.2','0.6.3','0.6.4','0.6.5','0.7.0','0.7.1']){
    const legacyActionTicks = version.startsWith('0.6.');
    const bulletSpeed = legacyActionTicks ? 525 : version==='0.7.0' ? 800 : 1000;
    const fireHz = version==='0.7.1' ? 20 : 5;
    const g=new ProductionGame(true,legacyActionTicks&&version!=='0.6.5',false,{version,bulletSpeed,fireHz,legacyActionTicks,heatEnabled:false});
    g.start({...base,controllers:{blue:'agent',red:'fixed'},tuning:{hp:1000,damage:1,power:50}});finishPreparation(g);
    for(let i=0;i<3;i++){g.action('blue',{...neutral(),aimX:0,aimY:.5,fire:true,durationMs:499},'agent');g.advance(120);}g.stop();
    const record={...g.refereeRecord(),version};const before=JSON.stringify(record);const result=replay(record);
    assert.equal(result.identical,true);assert.equal(result.actual.rules.bulletSpeed,bulletSpeed);assert.equal(result.actual.rules.fireHz,fireHz);assert.equal(JSON.stringify(record),before);
    assert.equal(result.actual.finalState.robots.blue.heatUnits,undefined);
    assert.throws(()=>replay({...record,rules:{bulletSpeed:bulletSpeed+1}}),/弹速与规则版本/);
    assert.throws(()=>replay({...record,rules:{fireHz:fireHz+1}}),/射速与规则版本/);
  }
  assert.equal(validateAction({...neutral(),durationMs:17}).durationMs,17);
});
