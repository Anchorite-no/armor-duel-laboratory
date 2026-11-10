import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TracedGame as Game } from './support.js';
import { TracedLaboratory as Laboratory } from './support.js';
import { neutral } from '../src/host/physics.js';
import { aimingSolution, computerAction, COMPUTER } from '../src/host/opponent.js';
import { traditionalSnapshot } from '../src/host/traditional-state.js';
import { replay } from '../src/host/replay.js';
import { RULES } from '../src/shared/protocol.js';
import { mouseButtons } from '../src/client/controls.js';
import { finishPreparation } from './support.js';
const setup={clock:'realtime' as const,scenario:'duel' as const,targetSpin:0,controllers:{blue:'human' as const,red:'agent' as const}};
const snapshot=(g:Game)=>{const r=g.refereeRecord();return traditionalSnapshot(r.finalState,r.finalMotion,g.elapsedSteps*1000/RULES.tickHz,g.status);};

test('玩家自瞄复用AI装甲预测与60Hz边界，保留手动移动旋转射击，实际瞄准可回放',()=>{
  const g=new Game();g.start(setup);finishPreparation(g);
  g.action('red',{...neutral(),moveY:.5,spin:.65,durationMs:500},'agent');g.advance(12);
  const expected=computerAction(snapshot(g),'blue');
  const manual={...neutral(),moveX:.25,moveY:-.2,spin:.6,aimX:.1,aimY:.9,fire:false,durationMs:500};
  const start=g.elapsedSteps,turret=g.refereeRecord().finalState.robots.blue.turret;
  g.humanInput('blue',manual,true);assert.equal(g.refereeRecord().humanAimAssist.used,false);
  g.advance(1);
  const first=g.refereeRecord().actions.find(a=>a.source==='human'&&a.action)!.action!;
  const initialAim=g.refereeRecord().actions.filter(a=>a.aim).at(-1)!;
  assert.deepEqual(initialAim.aim,{aimX:expected.aimX,aimY:expected.aimY});
  assert.equal(first.moveX,manual.moveX);assert.equal(first.moveY,manual.moveY);assert.equal(first.spin,manual.spin);assert.equal(first.fire,false);
  assert.ok(Math.abs(g.refereeRecord().finalState.robots.blue.turret-turret)<=RULES.turretSpeed/RULES.tickHz+1e-12);
  g.advance(3);assert.equal(g.refereeRecord().actions.filter(a=>a.aim).length,1);
  const next=aimingSolution(snapshot(g),'blue');g.advance(1);
  const update=g.refereeRecord().actions.filter(a=>a.aim).at(-1)!;
  assert.equal(update.step-start,4);assert.deepEqual(update.aim,{aimX:next.x/RULES.width,aimY:next.y/RULES.height});
  assert.equal(g.refereeRecord().finalState.robots.blue.shots,0);
  g.humanInput('blue',{...manual,fire:true},true);g.advance(4);assert.equal(g.refereeRecord().finalState.robots.blue.shots,1);
  g.humanInput('blue',{...manual,fire:true},false);g.advance(4);
  const resumed=g.refereeRecord().actions.filter(a=>a.action&&a.source==='human').at(-1)!.action!;
  assert.equal(resumed.aimX,manual.aimX);assert.equal(resumed.aimY,manual.aimY);assert.equal(resumed.fire,true);
  const count=g.refereeRecord().actions.filter(a=>a.aim).length;g.advance(30);assert.equal(g.refereeRecord().actions.filter(a=>a.aim).length,count);
  g.stop();const record=g.refereeRecord();assert.equal(record.humanAimAssist.used,true);assert.equal(record.humanAimAssist.implementation,COMPUTER.implementation);
  assert.deepEqual(record.humanAimAssist.events.map(e=>e.enabled),[true,false]);assert.equal(replay(record).identical,true);
});

test('无可行提前量时同样回退目标中心，右键自身不开火；左右键独立释放',()=>{
  const g=new Game();g.start({...setup,tuning:{hp:200,damage:10,power:300}});finishPreparation(g);
  // Near the wall, extrapolating the target's current movement takes it out of the arena.
  g.action('red',{...neutral(),moveY:-1,durationMs:500},'agent');g.advance(92);
  const s=snapshot(g),aim=aimingSolution(s,'blue');assert.equal(aim.feasible,false);
  g.humanInput('blue',{...neutral(),durationMs:100},true);g.advance(1);
  const actual=g.refereeRecord().actions.filter(a=>a.aim).at(-1)!.aim!;assert.equal(actual.aimX,s.robots.red.x/RULES.width);assert.equal(actual.aimY,s.robots.red.y/RULES.height);
  g.advance(1);assert.equal(g.refereeRecord().finalState.robots.blue.shots,0);
  assert.deepEqual(mouseButtons(2),{fire:false,aimAssist:true});assert.deepEqual(mouseButtons(3),{fire:true,aimAssist:true});
  assert.deepEqual(mouseButtons(1),{fire:true,aimAssist:false});assert.deepEqual(mouseButtons(0),{fire:false,aimAssist:false});
});

test('准备期可辅助瞄准但禁射，取消/暂停/停止/过期均清理辅助，开新局无残留',()=>{
  for(const clear of ['cancel','pause','stop','expire'] as const){
    const g=new Game();g.start(setup);const initial=g.refereeRecord().finalState.robots.blue;
    g.humanInput('blue',{...neutral(),moveX:1,fire:true,durationMs:100},true);g.advance(1);
    assert.equal(g.refereeRecord().finalState.robots.blue.shots,0);assert.equal(g.refereeRecord().finalState.robots.blue.x,initial.x);
    if(clear==='cancel')g.cancel('blue','human');else if(clear==='pause')g.pause();else if(clear==='stop')g.stop();else g.advance(24);
    assert.equal(g.refereeRecord().humanAimAssist.events.at(-1)!.enabled,false);
    const count=g.refereeRecord().actions.filter(a=>a.aim).length;
    if(clear==='pause')g.resume();if(clear!=='stop')g.advance(24);
    assert.equal(g.refereeRecord().actions.filter(a=>a.aim).length,count);
    g.start(setup);assert.equal(g.refereeRecord().humanAimAssist.used,false);
  }
});

test('特权仅供房主键鼠入口，模型和脚本不能启用自瞄、读预测真值或从错误获得规则',async()=>{
  const lab=new Laboratory(path.resolve('.local/aim-tests',randomUUID(),'referee'));
  try{
    await lab.admin('start',{setup});
    await assert.rejects(lab.admin('input',{matchId:lab.game.matchId,side:'red',action:neutral(),aimAssist:true}),/本机键鼠/);
    await lab.admin('input',{matchId:lab.game.matchId,side:'blue',action:neutral(),aimAssist:true});
    for(const source of ['agent','script'] as const)for(const [method,payload] of [
      ['input',{side:'blue',action:neutral(),aimAssist:true}],
      ['aimingSolution',{}],
      ['act',{side:'red',action:neutral(),aimAssist:true}],
      ['act',{side:'red',action:{...neutral(),autoAim:true}}],
      ['act',{side:'blue',action:neutral()}],
      ['act',{side:'red',action:{...neutral(),spin:100}}],
    ] as const)await assert.rejects(lab.participant(method,payload,source),{message:'Participant request failed.'});
    const frame=await lab.participant('observe',{},'agent');assert.deepEqual(Object.keys(frame as object).sort(),['frameId','image']);
  }finally{await lab.dispose();}
});
