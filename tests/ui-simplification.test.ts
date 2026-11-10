import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RoomPanel } from '../src/client/RoomPanel.js';
import { HelpDialog } from '../src/client/HelpDialog.js';
import { BattleCanvas } from '../src/client/BattleCanvas.js';
import { createRoomSetup } from '../src/client/room.js';
import { resultHeading } from '../src/client/types.js';
import { ScriptLibrary } from '../src/host/library.js';
import { TracedGame as Game } from './support.js';
import { Game as ProductionGame } from '../src/host/game.js';
import { createState, neutral } from '../src/host/physics.js';
import { replay } from '../src/host/replay.js';
import { paintScene, type Painter } from '../src/shared/scene.js';
import { hudWidth, paintHudText } from '../src/shared/hud-font.js';
import { behaviorProfile } from '../src/host/opponent.js';
import { finishPreparation } from './support.js';

test('房间只显示控制者与性能输入，说明集中帮助，错误就地显示且不依赖后端就绪',async()=>{
  const scripts=await new ScriptLibrary(path.resolve('.local/ui-tests',randomUUID(),'scripts.json')).list();
  const setup=createRoomSetup(),props={setup,scripts,playerSide:'blue' as const,connection:'connecting' as const,connectionError:'',busy:false,change(){},selectSide(){},enter(){},retry(){},continueMatch(){}};
  const room=renderToStaticMarkup(React.createElement(RoomPanel,props));
  assert.match(room,/机器人性能参数/);assert.match(room,/特权 AI/);assert.doesNotMatch(room,/管理脚本/);
  assert.doesNotMatch(room,/键盘已绑定|使用键盘|P \/ 键盘|E \/ 脚本|· P|· E|PVE|EVE|共享性能|同时应用|纯移动上限|纯旋转上限|弹速|轮速平方|浮点|固定 5 秒/);
  const help=renderToStaticMarkup(React.createElement(HelpDialog,{tuning:setup.tuning,close(){}}));
  for(const term of ['当前纯移动上限','当前纯旋转上限','弹速','默认生命值 200'])assert.ok(help.includes(term));
  assert.match(help,/role="dialog" aria-modal="true"/);assert.match(help,/关闭帮助/);
  const invalid=renderToStaticMarkup(React.createElement(RoomPanel,{...props,setup:{...setup,tuning:{hp:200,damage:10,power:-1}}}));
  assert.match(invalid,/aria-label="功率" aria-invalid="true" aria-describedby="room-power-error"/);
  assert.ok(invalid.indexOf('功率必须是有限的非负数')<invalid.indexOf('room-connection connecting'));
});

test('新比赛红左蓝右且HUD使用真实阵营数据，结算仅显示获胜方或平局',()=>{
  const g=new Game(),frame=g.display();assert.equal(frame.scene.robots.red.x,210);assert.equal(frame.scene.robots.blue.x,750);
  frame.scene.robots.red.hp=137;frame.scene.robots.blue.hp=45.9;
  const text:{s:string;x:number}[]=[],painter:Painter={pixel(){},rect(){},circle(){},line(){},text(s,x){text.push({s,x});}};
  paintScene(frame,painter);
  assert.deepEqual(text.filter(t=>/^(红方|蓝方) /.test(t.s)),[{s:'蓝方 45.9',x:626},{s:'红方 137',x:26}]);
  assert.equal(resultHeading('red'),'红方胜利');assert.equal(resultHeading('blue'),'蓝方胜利');assert.equal(resultHeading('draw'),'平局');assert.equal(resultHeading(null),'');
});

test('比赛画布无常驻技术诊断和功率，JPG仍保留可观察的结束结果',()=>{
  const canvas=renderToStaticMarkup(React.createElement(BattleCanvas,{api:async()=>{},onStatus(){},onError(){}}));
  assert.doesNotMatch(canvas,/FPS|RTT|game-fps|功率|POWER|参数待定|研究/);
  const frame=new Game().display();frame.scene.winner='red';frame.status='ended';
  const texts:string[]=[],painter:Painter={pixel(){},rect(){},circle(){},line(){},text(s){texts.push(s);}};
  paintScene(frame,painter,false);assert.ok(!texts.some(text=>text.includes('胜利')||text.includes('功率')));
  texts.length=0;paintScene(frame,painter);assert.ok(texts.includes('红方胜利'));
  frame.scene.winner='draw';frame.scene.overheatDeaths=['red','blue'];
  texts.length=0;paintScene(frame,painter);assert.ok(texts.includes('平局')&&texts.includes('双方过热损毁'));
});

test('战场中文标签拥有可见字形且按实际字宽排版',()=>{
  for(const [label,size] of [['红方 200','score'],['弹药 600','label'],['热量 100','label'],['红方胜利','result'],['双方过热损毁','label'],['准备：仅可旋转和瞄准','label'],['已暂停已结束已停止回合','label']] as const) {
    for(const character of label.replaceAll(' ','')) {
      let right=0;
      paintHudText(character,0,0,size,(x,_,width)=>{right=Math.max(right,x+width);});
      assert.ok(right>0&&right<=hudWidth(character,size),character);
    }
    assert.equal(hudWidth(label,size),[...label].reduce((sum,character)=>sum+hudWidth(character,size),0));
  }
});

test('AI各侧独立种子打破强制镜像，同种子确定复现，换局可变且回放只重放实际动作',()=>{
  const setup={clock:'realtime' as const,scenario:'duel' as const,targetSpin:0,controllers:{blue:'computer' as const,red:'computer' as const},controllerSeeds:{red:12345,blue:98765}};
  const run=()=>{const g=new Game();g.start(setup);finishPreparation(g);g.advance(240);return g.refereeRecord();};
  const a=run(),b=run();assert.deepEqual(a.finalState,b.finalState);assert.deepEqual(a.actions,b.actions);
  assert.deepEqual(a.setup.controllerSeeds,setup.controllerSeeds);assert.equal(replay(a).identical,true);
  const r=a.finalState.robots;assert.ok(Math.abs(r.red.x+r.blue.x-960)>1e-5||Math.abs(r.red.y+r.blue.y-600)>1e-5);
  assert.notDeepEqual(behaviorProfile(12345),behaviorProfile(98765));
  for(let seed=0;seed<30;seed++){const p=behaviorProfile(seed);assert.ok(Math.abs(p.rangeOffset)<=18);assert.ok(p.strafePeriod>=2.34&&p.strafePeriod<=2.86);}
  const g=new Game();const fresh={...setup,controllerSeeds:undefined};g.start(fresh);const first=g.setup.controllerSeeds;g.start(fresh);assert.notDeepEqual(g.setup.controllerSeeds,first);
});

test('0.6.2记录从初始快照恢复蓝左红右，历史参数与坐标不被当前出生侧重解释',()=>{
  const initial=createState({hp:200,damage:10,power:50},false);
  initial.robots.blue.x=210;initial.robots.blue.angle=initial.robots.blue.turret=0;
  initial.robots.red.x=750;initial.robots.red.angle=initial.robots.red.turret=Math.PI;
  const g=new ProductionGame(true,true,false,{version:'0.6.2',bulletSpeed:525,fireHz:5,legacyActionTicks:true,heatEnabled:false});
  g.start({clock:'stepped',scenario:'duel',targetSpin:0,tuning:initial.tuning,controllers:{blue:'agent',red:'idle'}},initial);finishPreparation(g);
  g.action('blue',{...neutral(),moveX:1,durationMs:100},'agent');g.advance(24);g.stop();
  const record=g.refereeRecord(),before=JSON.stringify(record);
  const result=replay(record);assert.equal(result.identical,true);assert.equal(result.actual.snapshots[0].state.robots.blue.x,210);
  assert.equal(result.actual.finalState.robots.blue.x,record.finalState.robots.blue.x);assert.equal(JSON.stringify(record),before);
  assert.throws(()=>replay({...record,snapshots:undefined}),/缺少初始快照/);
});
