import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardSpin } from '../src/client/controls.js';
import { HumanInput, type InputContext } from '../src/client/human-input.js';
import { TracedGame as Game } from './support.js';
import { createState, neutral, tick, velocity, wrap } from '../src/host/physics.js';
import { motionCaps, rotationPower } from '../src/shared/motion.js';
import { RULES } from '../src/shared/protocol.js';
import { replay } from '../src/host/replay.js';

test('Q/E同键停止、反键换向，重复keydown不切换，X归零', () => {
  for (const [key, opposite, direction] of [['e','q',1],['q','e',-1]] as const) {
    let spin=keyboardSpin(0,key);assert.equal(spin,direction*.6);
    for(let i=0;i<30;i++)spin=keyboardSpin(spin,key,true);
    assert.equal(spin,direction*.6);
    assert.equal(keyboardSpin(spin,key),0);
    assert.equal(keyboardSpin(spin,opposite),-direction*.6);
    assert.equal(keyboardSpin(spin,'x'),0);
    assert.equal(keyboardSpin(spin,'w'),spin);
  }
});

test('键盘60%转速在屏幕上E顺Q逆，功率占36%且平移保留80%', () => {
  for(const power of [25,100,400])for(const key of ['q','e']) {
    const spin=keyboardSpin(0,key),caps=motionCaps(power),state=createState({hp:100,damage:10,power});
    state.robots.blue.angle=0;
    const action={...neutral(state.robots.blue),moveX:.8,spin},v=velocity(action,power);
    assert.equal(rotationPower(spin),.36);
    assert.ok(Math.abs(v.x-caps.maxSpeed*.8)<1e-10);
    assert.ok(Math.abs(Math.abs(v.omega)-caps.maxSpin*.6)<1e-10);
    tick(state,{blue:action,red:neutral(state.robots.red)});
    // A point initially on the right moves down for E (clockwise), up for Q.
    const screenY=state.robots.blue.y+Math.sin(state.robots.blue.angle)*RULES.radius;
    assert.equal(screenY>state.robots.blue.y,key==='e');
  }
});

test('键盘映射在准备期允许旋转，暂停取消与新规则回放保持一致', () => {
  const game=new Game();game.start({clock:'realtime',scenario:'duel',targetSpin:0,controllers:{blue:'human',red:'idle'}});
  const before=game.refereeRecord().finalState.robots.blue;
  game.action('blue',{...neutral(),moveX:1,spin:keyboardSpin(0,'e'),fire:true,durationMs:500},'human');game.advance(24);
  const after=game.refereeRecord().finalState.robots.blue;
  assert.ok(Math.abs(wrap(after.angle-before.angle)-.48)<1e-10);
  assert.equal(after.x,before.x);assert.equal(after.shots,0);assert.equal(game.tickCount,0);
  game.pause();game.resume();game.advance(24);
  assert.equal(game.refereeRecord().finalState.robots.blue.angle,after.angle);
  const record=game.refereeRecord();assert.equal(record.version,RULES.version);assert.equal(record.rules.bulletSpeed,1000);
  assert.equal(replay(record).identical,true);
  assert.throws(()=>replay({...record,version:'0.6.0'}),/记录版本不支持/);
});

test('准备期键盘输入在全速和移动档间切换，含最低允许功率', () => {
  for (const power of [1, 100]) {
    const game = new Game();
    game.start({clock:'realtime',scenario:'duel',targetSpin:0,tuning:{hp:200,damage:10,power},controllers:{blue:'human',red:'idle'}});
    const input = new HumanInput();
    const context: InputContext = {phase:'battle',connection:'ready',setup:game.setup,matchId:game.matchId,status:'countdown',side:'blue',focused:true,blocked:false};
    const current = () => game.refereeRecord().finalState.robots.blue;
    const initial = current();
    const sample = (expectedSpin: number) => {
      const packet = input.packet(context)!;
      assert.equal(packet.action.spin, expectedSpin);
      const angle = current().angle;
      game.humanInput(packet.side, packet.action, packet.aimAssist);
      input.acknowledge(packet);
      game.advance(24);
      assert.ok(Math.abs(wrap(current().angle-angle) - expectedSpin * motionCaps(power).maxSpin / 10) < 1e-10);
      assert.equal(current().x, initial.x);
      assert.equal(current().shots, 0);
    };
    sample(0);
    input.keyDown(context,'e'); input.keyUp(context,'e');
    input.buttons(context,1);
    sample(1);
    input.keyDown(context,'d');
    sample(.6);
    input.keyUp(context,'d');
    sample(1);
    input.keyDown(context,'q'); input.keyUp(context,'q');
    sample(-1);
    input.keyDown(context,'q');
    sample(0);
    assert.equal(game.tickCount, 0);
    assert.equal(replay(game.refereeRecord()).identical, true);
  }
});
