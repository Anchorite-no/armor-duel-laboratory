import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HumanInput,canUseHumanInput,type InputContext} from '../src/client/human-input.js';
import {TracedLaboratory as Laboratory} from './support.js';
import {neutral} from '../src/host/physics.js';
import {createRoomSetup,selectRoomController} from '../src/client/room.js';
import {resultDetail,resultHeading} from '../src/client/types.js';
import {RULES,type OwnerObservation} from '../src/shared/protocol.js';
import {replay} from '../src/host/replay.js';
import {finishPreparation} from './support.js';
import {readFile} from 'node:fs/promises';

function playerContext():InputContext{return {phase:'battle',connection:'ready',setup:selectRoomController(createRoomSetup(),'blue','keyboard'),matchId:'round-one',status:'running',side:'blue',focused:true,blocked:false};}
test('观战的左右键、移动及Q/E既不点亮辅助也不产生客户端动作包',()=>{
  const player=playerContext(),input=new HumanInput();
  input.buttons(player,3);input.keyDown(player,'e');assert.equal(input.packet(player)!.aimAssist,true);
  const setup=createRoomSetup();setup.room!.seats={red:'builtin:computer',blue:'builtin:computer'};setup.controllers={red:'computer',blue:'computer'};
  const sent:unknown[]=[];
  for(const side of ['red','blue'] as const){
    const observer={...player,setup,side,matchId:'observer-round'};assert.equal(canUseHumanInput(observer),false);
    for(const buttons of [1,2,3,0]){assert.equal(input.buttons(observer,buttons),false);const packet=input.packet(observer);if(packet)sent.push(packet);}
    for(const key of ['w','a','s','d','q','e','x',' ']){input.keyDown(observer,key);input.keyUp(observer,key);const packet=input.packet(observer);if(packet)sent.push(packet);}
    input.aim(observer,.9,.1);assert.equal(input.aimAssist,false);assert.equal(input.fire,false);assert.equal(input.spin,0);assert.equal(input.keys.size,0);
  }
  assert.deepEqual(sent,[]);
});

test('human右键仍有效，按键与左右键独立；换局、换席位、暂停失焦和弹窗均清空旧输入',()=>{
  const input=new HumanInput(),context=playerContext();
  input.aim(context,.25,.75);input.buttons(context,2);input.keyDown(context,'e');
  let packet=input.packet(context)!;assert.equal(packet.aimAssist,true);assert.equal(packet.action.fire,false);assert.equal(packet.action.spin,1);
  input.keyUp(context,'e');assert.equal(input.packet(context)!.action.spin,1);
  input.buttons(context,3);input.buttons(context,1);packet=input.packet(context)!;assert.equal(packet.action.fire,true);assert.equal(packet.aimAssist,false);
  for(const update of [{focused:false},{blocked:true},{status:'paused' as const},{status:'ended' as const},{phase:'room' as const},{connection:'error'},{side:'red' as const}]){
    input.buttons(context,3);input.keyDown(context,'w');input.keyDown(context,'q');
    const denied={...context,...update};assert.equal(input.packet(denied),undefined);assert.equal(input.fire,false);assert.equal(input.aimAssist,false);assert.equal(input.spin,0);assert.equal(input.keys.size,0);
  }
  input.buttons(context,3);input.keyDown(context,'w');packet=input.packet({...context,matchId:'round-two'})!;
  assert.equal(packet.matchId,'round-two');assert.equal(packet.action.fire,false);assert.equal(packet.aimAssist,false);assert.equal(packet.action.moveY,0);
  const other=createRoomSetup();other.room!.seats={red:'keyboard',blue:'builtin:computer'};other.controllers={red:'human',blue:'computer'};
  packet=input.packet({...context,setup:other,side:'red'})!;assert.equal(packet.side,'red');assert.equal(packet.action.spin,0);assert.equal(packet.action.fire,false);
});

test('宿主拒绝观战控制来源且旧局输入/释放不影响下一局或产生human记录',async()=>{
  const lab=new Laboratory(path.resolve('.local/spectator-tests',randomUUID(),'referee'));
  try{
    const player=selectRoomController(createRoomSetup(),'blue','keyboard');await lab.admin('start',{setup:player});const oldId=lab.game.matchId;
    await lab.admin('input',{matchId:oldId,side:'blue',action:neutral(),aimAssist:true});
    const spectator=createRoomSetup();spectator.room!.seats={red:'builtin:computer',blue:'builtin:computer'};
    await lab.admin('start',{setup:spectator});
    assert.deepEqual(await lab.admin('input',{matchId:oldId,side:'blue',action:{...neutral(),moveX:1,spin:.6,fire:true},aimAssist:true}),{accepted:false});
    assert.deepEqual(await lab.admin('release',{matchId:oldId,side:'blue'}),{cancelled:false});
    for(const side of ['red','blue'])await assert.rejects(lab.admin('input',{matchId:lab.game.matchId,side,action:{...neutral(),fire:true},aimAssist:true}),/本机键鼠/);
    let record=lab.game.refereeRecord();assert.equal(record.humanAimAssist.used,false);assert.ok(!record.actions.some(action=>action.source==='human'||action.cancel));
    await lab.admin('start',{setup:player});const currentId=lab.game.matchId;
    await lab.admin('input',{matchId:currentId,side:'blue',action:{...neutral(),spin:.6,durationMs:100},aimAssist:true});
    lab.game.advance(4);const count=lab.game.refereeRecord().actions.filter(action=>action.source==='human').length;
    assert.deepEqual(await lab.admin('release',{matchId:oldId,side:'blue'}),{cancelled:false});
    assert.deepEqual(await lab.admin('input',{matchId:oldId,side:'blue',action:neutral(),aimAssist:false}),{accepted:false});
    record=lab.game.refereeRecord();assert.equal(record.actions.filter(action=>action.source==='human').length,count);assert.equal(record.humanAimAssist.events.at(-1)!.enabled,true);
  }finally{await lab.dispose();}
});

test('结算标题保留获胜方，小字只说明败方或真实结束原因',()=>{
  const result=(winner:OwnerObservation['winner'],red:number,blue:number,status:OwnerObservation['status']='ended',timestampMs:number=RULES.durationMs)=>({winner,status,timestampMs,hud:{red:{hp:red,ammo:0,shots:0,hits:0},blue:{hp:blue,ammo:0,shots:0,hits:0}}});
  assert.equal(resultHeading('red'),'红方胜利');assert.equal(resultDetail(result('red',10,0)),'蓝方机体被击毁');
  assert.equal(resultDetail(result('blue',0,10)),'红方机体被击毁');
  assert.equal(resultDetail(result('red',20,10)),'时间到，蓝方剩余血量较少');assert.equal(resultDetail(result('blue',10,20)),'时间到，红方剩余血量较少');
  assert.equal(resultDetail(result('draw',0,0)),'两台机体同时被击毁');assert.equal(resultDetail(result('draw',20,20)),'时间到，剩余血量相同');
  assert.equal(resultDetail(result(null,20,20,'stopped',1000)),'对局已停止');assert.equal(resultDetail(result('red',20,10,'ended',1000)),'本轮结束');
});

test('结束后回放入口使用的记录、快照与完整JSON仍可读取，参赛者不能旁路访问',async()=>{
  const lab=new Laboratory(path.resolve('.local/replay-ui-tests',randomUUID(),'referee'));
  try{
    await lab.admin('start',{setup:{clock:'stepped',scenario:'duel',targetSpin:0,controllers:{red:'idle',blue:'agent'}}});
    await assert.rejects(lab.admin('record',{}),/结束比赛/);
    finishPreparation(lab.game);lab.game.action('blue',{...neutral(),moveX:-1,durationMs:100},'agent');lab.game.advance(24);
    await lab.admin('stop',{});
    const saved=await lab.admin('record',{}) as {path:string;record:ReturnType<typeof lab.game.refereeRecord>};
    assert.deepEqual(JSON.parse(await readFile(saved.path,'utf8')),saved.record);
    assert.ok(saved.record.snapshots.length>0);assert.equal(replay(saved.record).identical,true);
    const frame=await lab.admin('replayFrame',{index:0}) as {image:{mimeType:string;base64:string};status:string};
    assert.equal(frame.image.mimeType,'image/png');assert.equal(frame.status,'countdown');assert.ok(frame.image.base64.length>0);
    await assert.rejects(lab.participant('record',{},'agent'),{message:'Participant request failed.'});
  }finally{await lab.dispose();}
});
