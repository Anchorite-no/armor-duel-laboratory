import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { neutral } from '../src/host/physics.js';
import { Game as ProductionGame } from '../src/host/game.js';
import { replay } from '../src/host/replay.js';
import { RULES } from '../src/shared/protocol.js';
import { finishPreparation, neutralMotion, startReady, TracedGame as Game, TracedLaboratory as Laboratory } from './support.js';

const setup = {clock:'stepped',scenario:'duel',targetSpin:0,controllers:{red:'agent',blue:'idle'}} as const;

test('owner fire rate accepts fractional shots per second and rounds up in physics ticks', () => {
  const game=new Game();
  for(const fireRateHz of [0,-1,NaN,Infinity,'19.5']) {
    assert.throws(()=>game.start({...setup,fireRateHz}),/射速必须为正有限数/);
  }
  startReady(game,{...setup,fireRateHz:19.5});
  assert.equal(game.fire('red','agent'),true);
  game.advance(12);
  assert.equal(game.fire('red','agent'),false);
  game.advance(1);
  assert.equal(game.fire('red','agent'),true);
  game.advance(1);
  const record=game.refereeRecord();
  assert.equal(record.rules.fireRateHz,19.5);
  assert.deepEqual(record.events.filter(e=>e.type==='shot').map(e=>e.tick),[0,13]);
  assert.equal(replay(JSON.parse(JSON.stringify(record))).identical,true);
});

test('fixed shooter survives a full default round, resumes after cooling and replays exactly', () => {
  const game=new Game();
  game.start({...setup,scenario:'shooter',controllers:{red:'fixed',blue:'idle'}});
  game.action('blue',{...neutral(),spin:.1,durationMs:500},'idle');
  finishPreparation(game);
  assert.equal(game.elapsedSteps,5*RULES.tickHz);
  assert.equal(game.tickCount,0);
  const battleTicks=60*RULES.tickHz;
  while (game.tickCount<battleTicks-1) {
    assert.equal(game.status,'running');
    game.advance(Math.min(480,battleTicks-1-game.tickCount));
  }
  assert.equal(game.status,'running');
  game.advance(1);
  assert.equal(game.status,'ended');
  assert.equal(game.metadata().timestampMs,60_000);
  const record=game.refereeRecord(), shooter=record.finalState.robots.red;
  const shots=record.events.filter(e=>e.type==='shot'&&e.side==='red');
  assert.equal(record.finalTick,battleTicks);
  assert.equal(record.finalStep,65*RULES.tickHz);
  assert.equal(shooter.hp,RULES.hp);
  assert.equal(record.events.some(e=>e.type==='overheat'),false);
  assert.equal(record.finalState.robots.blue.shots,0);
  assert.deepEqual([shooter.x,shooter.y,shooter.turret],[210,300,0]);
  assert.deepEqual(shots.slice(0,3).map(e=>e.tick),[0,12,24]);
  assert.ok(shots.length>100 && shots.at(-1)!.tick>battleTicks-RULES.tickHz);
  assert.equal(replay(JSON.parse(JSON.stringify(record))).identical,true);
});

test('0.7.7 preserves legacy fixed-shooter overheat and explicit single-shot replay', () => {
  const game=new ProductionGame(true,false,true,{version:'0.7.7',bulletSpeed:1000,fireHz:20,humanFireHz:10,legacyActionTicks:false,heatEnabled:true});
  game.start({...setup,scenario:'shooter',controllers:{red:'fixed',blue:'agent'}});
  game.action('blue',{...neutral(),spin:.1,durationMs:500},'agent',120);
  finishPreparation(game);
  assert.equal(game.fire('blue','agent'),true);
  game.advance(480);
  const record=game.refereeRecord();
  assert.equal(record.finalState.robots.blue.shots,1);
  assert.equal(record.finalState.robots.red.hp,0);
  assert.deepEqual(record.finalState.overheatDeaths,['red']);
  assert.equal(replay(JSON.parse(JSON.stringify(record))).identical,true);
});

test('single fire preserves the movement lease, enforces 49/50 ms and never drains a queue', () => {
  const game = new Game(), movementOnly = new Game();
  for (const g of [game,movementOnly]) {
    startReady(g,setup);
    g.action('red',{...neutral(),moveY:1,aimX:0,fire:true,durationMs:500},'agent');
    g.advance(4);
  }
  assert.equal(movementOnly.metadata().hud.red.shots,0);
  assert.equal(game.fire('red','agent'),true);
  assert.equal(game.fire('red','agent'),false);
  const earlyTicks = Math.floor(49*RULES.tickHz/1000);
  for (let i=0;i<earlyTicks;i++) {
    game.advance(1);
    assert.equal(game.fire('red','agent'),false);
  }
  const first = game.metadata().hud.red;
  assert.equal(first.shots,1);
  assert.equal(first.ammo,RULES.ammo-1);
  assert.ok(first.heat!<=RULES.heat.perShot);
  game.advance(1);
  assert.equal(game.fire('red','agent'),true);
  game.advance(1);
  game.advance(100);
  movementOnly.advance(earlyTicks+102);
  const {y,turret} = movementOnly.refereeRecord().finalState.robots.red;
  const fired = game.refereeRecord();
  assert.deepEqual([fired.finalState.robots.red.y,fired.finalState.robots.red.turret],[y,turret]);
  assert.ok(y>RULES.height/2);
  assert.deepEqual(fired.events.filter(e=>e.type==='shot').map(e=>e.tick),[4,16]);
  assert.equal(fired.actions.filter(e=>e.fire).length,2);
  assert.equal(replay(fired).identical,true);
});

test('owner interval rounds up to a physics step and a new round clears pending fire and cooldown', () => {
  const game = new Game();
  for (const invalid of [0,-1,NaN,Infinity,1.5,'50',Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>game.start({...setup,minFireIntervalMs:invalid}),/最小出弹间隔/);
  }
  startReady(game,{...setup,minFireIntervalMs:51});
  assert.equal(game.fire('red','agent'),true);
  game.advance(12);
  assert.equal(game.fire('red','agent'),false);
  game.advance(1);
  assert.equal(game.fire('red','agent'),true);
  game.advance(13);
  assert.equal(game.fire('red','agent'),true);
  const record = game.refereeRecord();
  assert.equal(record.setup.minFireIntervalMs,51);
  assert.equal(record.rules.minFireIntervalMs,51);
  assert.equal(replay(record).identical,true);
  assert.throws(()=>replay({...record,rules:{...record.rules,minFireIntervalMs:50}}),/最小出弹间隔/);
  game.start(setup);
  assert.equal(game.fire('red','agent'),false);
  finishPreparation(game);
  game.advance(1);
  assert.equal(game.metadata().hud.red.shots,0);
  assert.equal(game.fire('red','agent'),true);
  game.advance(1);
  assert.equal(game.metadata().hud.red.shots,1);
  game.stop();
  assert.equal(game.fire('red','agent'),false);
});

test('public action rejects the old fire flag and scripts consume one fire request through JPEG-only RPC', async () => {
  const lab = new Laboratory();
  try {
    await lab.admin('start',{setup});
    finishPreparation(lab.game);
    await assert.rejects(lab.participant('act',{side:'red',action:{...neutralMotion(),fire:true,durationMs:500}},'agent'),/Participant request failed/);
    await assert.rejects(lab.participant('fire',{side:'red',minFireIntervalMs:1},'agent'),/Participant request failed/);
    const frame = await lab.participant('fire',{side:'red'},'agent') as {image:{mimeType:string}};
    assert.deepEqual(Object.keys(frame).sort(),['frameId','image']);
    assert.equal(frame.image.mimeType,'image/jpeg');
    assert.equal(lab.game.metadata().hud.red.shots,1);
    await lab.admin('start',{setup:{...setup,controllers:{red:'script',blue:'idle'}}});
    finishPreparation(lab.game);
    await lab.admin('program',{side:'red',code:`const frame=await lab.fire(); await lab.log(Object.keys(frame).sort().join(',')+' '+frame.image.mimeType);`});
    for (let i=0;i<100 && lab.programs.red.info().status==='running';i++) await delay(20);
    assert.equal(lab.programs.red.info().status,'ended',lab.programs.red.info().output);
    assert.match(lab.programs.red.info().output,/frameId,image image\/jpeg/);
    lab.game.advance(120);
    assert.equal(lab.game.metadata().hud.red.shots,1);
  } finally { await lab.dispose(); }
});

test('a shorter owner interval preserves keyboard and traditional AI cadence', () => {
  const game = new Game();
  startReady(game,{...setup,clock:'realtime',minFireIntervalMs:1,controllers:{red:'human',blue:'computer'},tuning:{hp:1000,damage:1,power:1}});
  for (let i=0;i<2;i++) {
    game.humanInput('red',{...neutral(),aimX:0,fire:true,durationMs:500});
    game.advance(120);
  }
  const record = game.refereeRecord();
  for (const side of ['red','blue']) {
    const shots=record.events.filter(e=>e.type==='shot'&&e.side===side);
    assert.ok(shots.length>1);
    assert.ok(shots.slice(1).every((shot,i)=>shot.tick-shots[i].tick>=24));
  }
  assert.equal(replay(record).identical,true);
});
