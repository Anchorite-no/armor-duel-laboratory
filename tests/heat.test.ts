import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, validateAction } from '../src/shared/protocol.js';
import { CONTROL_STEPS } from '../src/shared/control.js';
import { createState, neutral, tick } from '../src/host/physics.js';
import { computerAction } from '../src/host/opponent.js';
import { stationaryMotion, traditionalSnapshot } from '../src/host/traditional-state.js';
import { replay } from '../src/host/replay.js';
import { resultDetail } from '../src/client/types.js';
import { HumanInput, type InputContext } from '../src/client/human-input.js';
import { Game as ProductionGame } from '../src/host/game.js';
import { TracedGame as Game, finishPreparation } from './support.js';

test('恰好100不扣血，连续超热只按实际发射扣血，散热速率精确且最低为零', () => {
  const state = createState({ hp: 203, damage: 1, power: 0 });
  const red = state.robots.red;
  red.turret = Math.PI;
  red.heatUnits = 90 * RULES.tickHz + 20;
  const fire = { red: { ...neutral(red), fire: true }, blue: neutral(state.robots.blue) };
  tick(state, fire);
  assert.equal(red.heatUnits, 100 * RULES.tickHz);
  assert.equal(red.hp, 203);
  tick(state, fire);
  assert.equal(red.shots, 1);
  assert.equal(red.heatUnits, 100 * RULES.tickHz - 20);
  for (let i = 0; i < 23; i++) tick(state, fire);
  assert.equal(red.shots, 3);
  assert.equal(red.heatUnits, 118 * RULES.tickHz);
  assert.equal(red.hp, 162.4);
  assert.deepEqual(state.events.filter(e => e.type === 'overheat').map(e => [e.tick, e.damage]), [[12,20.3],[24,20.3]]);
  red.ammo = 0;
  for (let i = 0; i < RULES.tickHz; i++) tick(state, fire);
  assert.equal(red.heatUnits, 98 * RULES.tickHz);
  assert.equal(red.hp, 162.4);
  assert.equal(red.shots, 3);
  for (let i = 0; i < RULES.tickHz * 5; i++) tick(state, fire);
  assert.equal(red.heatUnits, 0);
});

test('AI 以枪械冷却结束的物理步判断热量边界，实战持续开火而不超热', () => {
  const state = createState();
  const red = state.robots.red;
  red.nextShot = 3;
  red.heatUnits = 90 * RULES.tickHz + 80;
  const decide = () => computerAction(traditionalSnapshot(state, stationaryMotion(), 0, 'running'), 'red');
  assert.equal(decide().fire, true);
  red.heatUnits++;
  assert.equal(decide().fire, false);

  const game = new Game();
  game.start({ clock:'stepped', scenario:'duel', targetSpin:0, tuning:{hp:1000,damage:1,power:50},
    controllers:{red:'computer',blue:'idle'}, controllerSeeds:{red:13,blue:17} });
  finishPreparation(game);
  for (let i = 0; i < 12; i++) game.advance(480);
  const record = game.refereeRecord();
  assert.ok(record.finalState.robots.red.shots > 20);
  assert.ok(record.snapshots.every(frame => frame.state.robots.red.heatUnits! <= 100 * RULES.tickHz));
  assert.equal(record.events.some(e => e.type === 'overheat'), false);
  assert.equal(replay(record).identical, true);
});

test('准备和暂停冻结热量，纯左键仍可超热发射', () => {
  const game = new Game();
  game.start({clock:'realtime',scenario:'duel',targetSpin:0,tuning:{hp:1000,damage:1,power:1},controllers:{red:'human',blue:'idle'}});
  const input = {...neutral(),fire:true,durationMs:500};
  game.humanInput('red',input);
  finishPreparation(game);
  assert.equal(game.metadata().hud.red.heat, 0);
  assert.equal(game.metadata().hud.red.shots, 0);
  for (let i = 0; i < 2; i++) { game.humanInput('red',input); game.advance(120); }
  game.humanInput('red',input);
  game.advance(49);
  const hot = game.metadata().hud.red;
  assert.ok(hot.heat! > 100);
  assert.equal(hot.shots, 13);
  assert.equal(hot.hp, 900);
  game.pause(); game.advance(240);
  assert.deepEqual(game.metadata().hud.red, hot);
  game.resume(); game.advance(240);
  assert.equal(game.metadata().hud.red.heat, hot.heat! - 20);
  assert.equal(game.metadata().hud.red.shots, 13);
  assert.equal(replay(game.refereeRecord()).identical, true);
});

test('过热可致死，单边与同时过热结算均不增加装甲命中', () => {
  const state = createState({ hp: 203, damage: 1, power: 0 });
  for (const robot of Object.values(state.robots)) {
    robot.hp = 4;
    robot.heatUnits = 100 * RULES.tickHz;
  }
  tick(state, {red:{...neutral(state.robots.red),fire:true},blue:{...neutral(state.robots.blue),fire:true}});
  assert.equal(state.winner, 'draw');
  assert.deepEqual(state.overheatDeaths, ['blue','red']);
  assert.equal(state.robots.red.hp, 0);
  assert.equal(state.robots.blue.hp, 0);
  assert.equal(state.robots.red.hits + state.robots.blue.hits, 0);
  assert.equal(resultDetail({status:'ended',winner:'draw',timestampMs:10,hud:state.robots,overheatDeaths:state.overheatDeaths}), '两台机体同时因过热损毁');

  const game = new Game();
  game.start({clock:'realtime',scenario:'duel',targetSpin:0,controllers:{red:'human',blue:'idle'}});
  const input = {...neutral(),aimX:0,fire:true,durationMs:500};
  game.humanInput('red',input);
  finishPreparation(game);
  for (let i = 0; i < 5; i++) { game.humanInput('red',input); game.advance(120); }
  const result = game.metadata();
  assert.equal(result.winner, 'blue');
  assert.deepEqual(result.overheatDeaths, ['red']);
  assert.equal(result.hud.red.hp, 0);
  assert.equal(result.hud.red.shots, 22);
  assert.equal(result.hud.red.hits + result.hud.blue.hits, 0);
  assert.equal(resultDetail(result), '红方因过热损毁');
  assert.equal(replay(game.refereeRecord()).identical, true);
});

test('键鼠和全知AI均按100ms发射，参赛Agent和脚本仍可按50ms发射', () => {
  for (const source of ['computer','agent','script'] as const) {
    const game = new Game();
    game.start({clock:'realtime',scenario:'duel',targetSpin:0,tuning:{hp:1000,damage:1,power:1},controllers:{red:'human',blue:source}});
    const away = {...neutral(),aimX:0,fire:true,durationMs:500};
    game.humanInput('red',away);
    finishPreparation(game);
    const blocks = source === 'computer' ? 3 : 2;
    for (let i = 0; i < blocks; i++) {
      game.humanInput('red',away);
      if (source === 'computer') game.advance(120);
      else for (let j=0;j<10;j++) { game.fire('blue',source); game.advance(12); }
    }
    const record = game.refereeRecord();
    const shots = (side: 'red' | 'blue') => record.events.filter(e => e.type === 'shot' && e.side === side).map(e => e.tick);
    assert.deepEqual(shots('red'), Array.from({length:blocks*5},(_,i)=>i*24));
    const blue = shots('blue');
    if (source === 'computer') {
      // The first 12 shots all have enough heat headroom and a clear static target.
      assert.deepEqual(blue.slice(0,12), Array.from({length:12},(_,i)=>i*24));
      assert.ok(blue.slice(1).every((tick,i)=>tick-blue[i]>=24));
    } else assert.deepEqual(blue, Array.from({length:20},(_,i)=>i*12));
    assert.equal(record.rules.humanFireHz, 10);
    assert.equal(replay(record).identical, true);
  }
});

test('全知AI在无热量干扰、持续可开火的10秒内保持100ms策略间隔', () => {
  const state = createState({hp:1000,damage:1,power:0}, false);
  const ballistics = {...RULES,heatEnabled:false};
  const motion = stationaryMotion();
  while (state.tick < RULES.tickHz * 10) {
    const input = traditionalSnapshot(state,motion,state.tick*1000/RULES.tickHz,'running');
    const actions = {red:computerAction(input,'red'),blue:neutral(state.robots.blue)};
    for (let i = 0; i < CONTROL_STEPS; i++) tick(state,actions,ballistics);
  }
  const shots = state.events.filter(e=>e.type==='shot'&&e.side==='red').map(e=>e.tick);
  assert.deepEqual(shots,Array.from({length:100},(_,i)=>i*24));
});

test('右键加左键持续保护，冷却到恰好100自动续射，松右键立即恢复无保护', () => {
  const game = new Game();
  game.start({clock:'realtime',scenario:'duel',targetSpin:0,tuning:{hp:1000,damage:1,power:1},controllers:{red:'human',blue:'idle'}});
  const input = new HumanInput();
  const context: InputContext = {phase:'battle',connection:'ready',setup:game.setup,matchId:game.matchId,status:'countdown',side:'red',focused:true,blocked:false};
  const sample = () => {
    const packet = input.packet(context)!;
    game.humanInput(packet.side, packet.action, packet.aimAssist);
    input.acknowledge(packet);
  };
  input.buttons(context,3); sample(); finishPreparation(game);
  assert.equal(game.metadata().hud.red.shots, 0);
  context.status = 'running';
  input.buttons(context,2); sample(); game.advance(24);
  assert.equal(game.metadata().hud.red.shots, 0);
  const start = game.tickCount;
  input.buttons(context,3);
  for (let i = 0; i < 15; i++) { sample(); game.advance(24); }
  const blocked = game.refereeRecord().finalState.robots.red;
  assert.equal(blocked.shots, 12);
  assert.equal(blocked.ammo, RULES.ammo-12);
  assert.equal(blocked.nextShot, start+288);
  assert.equal(blocked.heatUnits, 90 * RULES.tickHz + 20);
  assert.equal(blocked.hp, 1000);
  sample(); game.advance(1);
  const resumed = game.refereeRecord().finalState.robots.red;
  assert.equal(resumed.shots, 13);
  assert.equal(resumed.heatUnits, 100 * RULES.tickHz);
  assert.equal(resumed.hp, 1000);
  game.advance(23);
  input.buttons(context,1); sample(); game.advance(1);
  assert.equal(game.metadata().hud.red.shots, 14);
  assert.equal(game.metadata().hud.red.hp, 900);
  const record = game.refereeRecord();
  assert.equal(record.actions.filter(a=>a.action&&a.source==='human').at(-1)?.heatProtection, undefined);
  assert.ok(record.actions.some(a=>a.action?.fire&&a.heatProtection));
  assert.equal(replay(record).identical, true);
});

test('空格沿用右键保护，零弹药时照常散热且不启动发射冷却', () => {
  const game = new Game();
  game.start({clock:'realtime',scenario:'duel',targetSpin:0,controllers:{red:'human',blue:'idle'}});
  const input = new HumanInput();
  const context: InputContext = {phase:'battle',connection:'ready',setup:game.setup,matchId:game.matchId,status:'running',side:'red',focused:true,blocked:false};
  input.buttons(context,2); input.keyDown(context,' ');
  const packet = input.packet(context)!;
  assert.equal(packet.action.fire, true);
  assert.equal(packet.aimAssist, true);
  assert.throws(()=>validateAction({...packet.action,heatProtection:true}), /未知字段/);
  const state = createState();
  const red = state.robots.red;
  red.ammo = 0;
  red.heatUnits = 90 * RULES.tickHz + 20;
  tick(state, {red:packet.action,blue:neutral()}, RULES, false, {side:'red',fireHz:10,heatProtection:packet.aimAssist});
  assert.equal(red.heatUnits, 90 * RULES.tickHz);
  assert.equal(red.nextShot, 0);
  assert.equal(red.shots, 0);
  assert.equal(red.ammo, 0);
});

test('0.7.2 的键鼠录像按20发每秒和无右键热量保护重放', () => {
  const game = new ProductionGame(true,false,false,{version:'0.7.2',bulletSpeed:1000,fireHz:20,legacyActionTicks:false,heatEnabled:true});
  game.start({clock:'realtime',scenario:'duel',targetSpin:0,tuning:{hp:1000,damage:1,power:0},controllers:{red:'human',blue:'idle'}});
  finishPreparation(game);
  const fire = {...neutral(),fire:true,durationMs:500};
  for (let i = 0; i < 2; i++) {
    game.action('red',fire,'human'); game.retargetHuman('red',{aimX:.8,aimY:.5}); game.advance(120);
  }
  const record = game.refereeRecord();
  assert.equal(record.finalState.robots.red.shots, 20);
  assert.ok(record.events.some(e=>e.type==='overheat'));
  assert.equal(replay(record).identical, true);
});
