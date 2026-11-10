import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privilegedAction, aimingSolution, behaviorProfile, RandomWalk } from '../src/host/opponent.js';
import { createState, velocity } from '../src/host/physics.js';
import { stationaryMotion, traditionalSnapshot } from '../src/host/traditional-state.js';
import { replay } from '../src/host/replay.js';
import { DEFAULT_AI, validatePrivilegedAI } from '../src/shared/privileged-ai.js';
import { RULES } from '../src/shared/protocol.js';
import { startReady, TracedGame as Game } from './support.js';

const setup={clock:'stepped',scenario:'duel',targetSpin:0,controllers:{red:'privileged',blue:'idle'},controllerSeeds:{red:7,blue:987}} as const;
const still={movement:'still',rotation:'still',shooting:'off'} as const;

test('independent AI choices keep center aiming current and off mode quiet',()=>{
  const state=createState(),motion=stationaryMotion();
  motion.blue.vy=120;
  const snapshot=traditionalSnapshot(state,motion,0,'running',24);
  const center=privilegedAction(snapshot,'red',{...DEFAULT_AI,rotation:'still',shooting:'center'},7);
  assert.ok(Math.abs(Math.hypot(center.moveX,center.moveY)-1)<1e-12);
  assert.equal(center.spin,0);
  assert.deepEqual([center.aimX,center.aimY],[state.robots.blue.x/RULES.width,state.robots.blue.y/RULES.height]);
  const lead=aimingSolution(snapshot,'red');
  const predict=privilegedAction(snapshot,'red',{...still,shooting:'predict'},7);
  assert.equal(predict.aimY,lead.y/RULES.height);
  assert.notEqual(predict.aimY,center.aimY);
  assert.throws(()=>validatePrivilegedAI({...still,phase:1}),/选项无效/);
  const game=new Game();startReady(game,{...setup,privilegedAI:{red:still}});game.advance(480);
  const robot=game.refereeRecord().finalState.robots.red;
  assert.deepEqual([robot.x,robot.y,robot.angle,robot.shots],[210,300,RULES.spawnArmorAngle,0]);
});

test('rotation is signed, seeded, and periodic over four seconds',()=>{
  const at=(ms:number)=>traditionalSnapshot(createState(),stationaryMotion(),ms,'running');
  const spin=(ms:number,rotation:'cw'|'ccw'|'sine',seed=7)=>privilegedAction(at(ms),'red',{...still,rotation},seed).spin;
  assert.equal(spin(0,'cw'),1);
  assert.equal(spin(0,'ccw'),-1);
  assert.equal(spin(4250,'sine'),spin(250,'sine'));
  assert.ok(Math.abs(spin(2250,'sine')+spin(250,'sine'))<1e-12);
  assert.notEqual(spin(250,'sine',987),spin(250,'sine'));
});

test('random waypoints stay in the playable rectangle and change only on arrival or stall',()=>{
  const state=createState(),walk=new RandomWalk(239);
  const point=(tick:number,walker=walk)=>{
    state.tick=tick;
    return walker.waypoint(traditionalSnapshot(state,stationaryMotion(),tick*1000/RULES.tickHz,'running'),'red',2);
  };
  const first=point(0);
  assert.deepEqual(point(0,new RandomWalk(239)),first);
  assert.notDeepEqual(point(0,new RandomWalk(240)),first);
  assert.equal(point(RULES.tickHz-1),first);
  assert.notDeepEqual(point(RULES.tickHz),first);
  for(let tick=RULES.tickHz+4;tick<3000;tick+=4) {
    const current=point(tick);
    assert.ok(current.x>=RULES.arenaInset && current.x<RULES.width-RULES.arenaInset);
    assert.ok(current.y>=RULES.arenaInset && current.y<RULES.height-RULES.arenaInset);
    Object.assign(state.robots.red,current);
    assert.notDeepEqual(point(tick+1),current);
  }
});

test('random trajectories approach their waypoint at full configured speed without wall stalls',()=>{
  const config={...still,movement:'random',rotation:'cw'} as const;
  const state=createState();
  const inset=RULES.arenaInset;
  for (const [x,y] of [[inset,inset],[RULES.width-inset,inset],[inset,RULES.height-inset],[RULES.width-inset,RULES.height-inset]]) {
    Object.assign(state.robots.red,{x,y});
    const action=privilegedAction(traditionalSnapshot(state,stationaryMotion(),0,'running'),'red',config,7,new RandomWalk(7));
    assert.equal(Math.sign(action.moveX),x===inset?1:-1);
    assert.equal(Math.sign(action.moveY),y===inset?1:-1);
    assert.ok(Math.abs(Math.hypot(action.moveX,action.moveY)-.8)<1e-12);
    assert.equal(action.spin,.6);
  }
  for(const [power,redSeed,blueSeed] of [[1,7,987],[50,239,240],[300,111,220]]) {
    const game=new Game();
    startReady(game,{...setup,controllers:{red:'privileged',blue:'privileged'},tuning:{hp:200,damage:10,power},
      controllerSeeds:{red:redSeed,blue:blueSeed},privilegedAI:{red:config,blue:config}});
    let contact=0;
    for(let elapsed=0;elapsed<RULES.tickHz*12;elapsed+=4) {
      game.advance(4);
      const {red,blue}=game.display().scene.robots;
      const wall=[red,blue].some(({x,y})=>Math.min(x,y,RULES.width-x,RULES.height-y)<=inset+1e-8);
      contact=wall?contact+4:0;
      assert.ok(contact<=RULES.tickHz/10,'wall contact persisted');
    }
    const record=game.refereeRecord();
    assert.notEqual(record.finalState.robots.red.angle,RULES.spawnArmorAngle);
    assert.ok(record.actions.filter(e=>e.step>=1200&&e.action).every(({action})=>Math.abs(Math.hypot(action!.moveX,action!.moveY)-.8)<1e-12 && action!.spin===.6));
  }
});

test('combined sine uses fixed 3.2 m/s translation and a 4.8 rad/s peak; single axes use full speed',()=>{
  const state=createState(),seed=7;
  const phaseMs=behaviorProfile(seed).spinPhase*4000/(2*Math.PI);
  const motion=(ms:number,config:typeof DEFAULT_AI)=>velocity(privilegedAction(traditionalSnapshot(state,stationaryMotion(),ms,'running'),'red',config,seed,new RandomWalk(seed)));
  const mixed={...still,movement:'random',rotation:'sine'} as const;
  for (const [ms,expectedSpin] of [[0,0],[1000,4.8],[2000,0],[3000,-4.8],[4000,0]]) {
    const v=motion(4000+ms-phaseMs,mixed);
    assert.ok(Math.abs(Math.hypot(v.x,v.y)/46-3.2)<1e-12);
    assert.ok(Math.abs(v.omega-expectedSpin)<1e-12);
  }
  const move=motion(0,{...mixed,rotation:'still'});
  assert.ok(Math.abs(Math.hypot(move.x,move.y)/46-4)<1e-12);
  assert.equal(move.omega,0);
  const turn=motion(5000-phaseMs,{...mixed,movement:'still'});
  assert.ok(Math.abs(turn.omega-8)<1e-12);
  assert.equal(Math.hypot(turn.x,turn.y),0);
});

test('independent random walks replay and shooting respects cooldown and heat',()=>{
  const game=new Game(),walk={...still,movement:'random'} as const;
  startReady(game,{...setup,controllers:{red:'privileged',blue:'privileged'},privilegedAI:{red:walk,blue:walk}});
  game.advance(480);
  const record=game.refereeRecord(),moves=record.actions.filter(e=>e.step>=1200&&e.action);
  assert.notDeepEqual(moves[0].action,moves[1].action);
  const headings=moves.filter(e=>e.side==='red').map(e=>e.action!.moveX);
  assert.ok(new Set(headings).size>1);
  assert.equal(replay(JSON.parse(JSON.stringify(record))).identical,true);
  for (const [roomRate,minTicks] of [[20,24],[4,60]]) {
    startReady(game,{...setup,fireRateHz:roomRate,tuning:{hp:1000,damage:1,power:50},privilegedAI:{red:{...still,shooting:'center'}}});
    for (let i=0;i<10;i++) game.advance(480);
    const outcome=game.refereeRecord(),shots=outcome.events.filter(e=>e.type==='shot');
    assert.ok(shots.length>20);
    assert.equal(shots[1].tick-shots[0].tick,minTicks);
    assert.ok(shots.slice(1).every((shot,i)=>shot.tick-shots[i].tick>=minTicks));
    assert.equal(outcome.events.some(e=>e.type==='overheat'),false);
    assert.equal(outcome.finalState.robots.red.hp,1000);
    assert.equal(replay(outcome).identical,true);
  }
});
