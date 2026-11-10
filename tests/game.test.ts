import { startReady, finishPreparation } from './support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Setup } from '../src/host/game.js';
import { TracedGame as Game } from './support.js';
import { neutral } from '../src/host/physics.js';
import { validateAction, RULES as R } from '../src/shared/protocol.js';
import { replay } from '../src/host/replay.js';
const setup: Setup = { clock: 'stepped', scenario: 'spinner', targetSpin: 0.7, controllers: { blue: 'agent', red: 'spinner' } };
test('动作校验拒绝越界、非有限数、额外状态字段和无限持续时间', () => {
  for (const action of [{ ...neutral(), spin: 1.1 }, { ...neutral(), moveX: NaN }, { ...neutral(), aimX: Infinity }, { ...neutral(), durationMs: 501 }, { ...neutral(), durationMs: 0 }, { ...neutral(), durationMs: 2.5 }, { ...neutral(), enemyX: 4 }]) assert.throws(() => validateAction(action));
});
test('动作到期，平移、旋转和开火停止', () => {
  const g = new Game(); startReady(g,setup);
  g.action('blue', { ...neutral(), moveX: 1, spin: 0.5, durationMs: 100 }, 'agent'); g.fire('blue','agent');
  g.advance(24); const before = g.refereeRecord().finalState.robots.blue;
  g.advance(200); const after = g.refereeRecord().finalState.robots.blue;
  assert.equal(after.x, before.x); assert.equal(after.y, before.y); assert.equal(after.angle, before.angle); assert.equal(after.shots, before.shots);
});
test('取消和暂停丢弃当前输入，恢复后不会继续旧动作', () => {
  const g = new Game(); startReady(g,setup); const a = { ...neutral(), moveX: 1, fire: true, durationMs: 500 };
  g.action('blue', a, 'agent'); g.advance(10); g.cancel('blue', 'agent');
  const x = g.refereeRecord().finalState.robots.blue.x; g.advance(50); assert.equal(g.refereeRecord().finalState.robots.blue.x, x);
  g.action('blue', a, 'agent'); g.pause(); g.resume(); g.advance(100); assert.equal(g.refereeRecord().finalState.robots.blue.x, x);
});
test('控制器占用限制与按步双参与者限制显式拒绝', () => {
  const g = new Game(); startReady(g,setup);
  assert.throws(() => g.action('red', neutral(), 'agent'));
  assert.throws(() => g.action('blue', neutral(), 'human'));
  assert.throws(() => g.start({ ...setup, controllers: { blue: 'agent', red: 'script' } }));
});
test('房主状态白名单及PNG无辅助元数据，参赛观察另经JPEG通道', () => {
  const g = new Game(); startReady(g,setup); g.advance(50); const o = g.observe();
  assert.deepEqual(Object.keys(o).sort(), ['clock','controller','countdownMs','rules','hud','image','matchId','scenario','status','timestampMs','version','winner'].sort());
  assert.deepEqual(Object.keys(o.rules).sort(), ['damage', 'hp', 'power']);
  for (const h of Object.values(o.hud)) assert.deepEqual(Object.keys(h).sort(), ['ammo','heat','hits','hp','shots']);
  const png = Buffer.from(o.image.base64, 'base64'); assert.equal(png.readUInt32BE(16), R.width); assert.equal(png.readUInt32BE(20), R.height + 80);
  let offset = 8; const chunks: string[] = [];
  while (offset < png.length) { const size = png.readUInt32BE(offset); chunks.push(png.toString('ascii', offset + 4, offset + 8)); offset += size + 12; }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND']);
  assert.ok(!JSON.stringify(o).includes('angle')); assert.ok(!JSON.stringify(o).includes('seed'));
});
test('重新开始清理图像缓存和旧动作', () => {
  const g = new Game(); startReady(g,setup); const initial = g.observe();
  g.advance(100); startReady(g,setup); const restarted = g.observe();
  assert.notEqual(restarted.matchId, initial.matchId); assert.equal(restarted.image.base64, initial.image.base64); assert.equal(restarted.timestampMs, 0);
});
test('分批和整批推进得到相同状态，页面帧率不参与物理', () => {
  const a = new Game(), b = new Game(); startReady(a,setup); startReady(b,setup);
  a.fire('blue','agent'); b.fire('blue','agent');
  a.advance(240); for (let i = 0; i < 60; i++) b.advance(4);
  assert.deepEqual(a.refereeRecord().finalState, b.refereeRecord().finalState);
});
test('动作、取消、暂停、恢复可离线重放到完全相同的裁判状态', () => {
  const g = new Game(); startReady(g,setup);
  g.fire('blue','agent'); g.advance(120);
  g.pause(); g.resume(); g.action('blue', { ...neutral(), moveY: 1, durationMs: 500 }, 'agent'); g.advance(75);
  g.cancel('blue', 'agent'); g.advance(480); g.stop();
  assert.equal(replay(g.refereeRecord()).identical, true);
  assert.throws(() => replay({ ...g.refereeRecord(), version: '0.3.0' }), /记录版本不支持/);
  assert.throws(() => replay({ ...g.refereeRecord(), version: '0.3.1' }), /记录版本不支持/);
  assert.throws(() => replay({ ...g.refereeRecord(), version: '0.4.0' }), /记录版本不支持/);
  assert.throws(() => replay({ ...g.refereeRecord(), version: '0.4.1' }), /记录版本不支持/);
  assert.throws(() => replay({ ...g.refereeRecord(), version: '0.5.1' }), /记录版本不支持/);
});
test('裁判回放仅在结束后开放，并返回普通画面', () => {
  const g = new Game(); startReady(g,setup); g.advance(240);
  assert.throws(() => g.refereeFrame(0)); g.pause(); assert.throws(() => g.refereeFrame(0));
  g.stop(); const index=g.refereeRecord().snapshots.findIndex(s=>s.tick===120);const frame = g.refereeFrame(index);
  assert.equal(frame.timestampMs, 500); assert.deepEqual(Object.keys(frame).sort(), ['countdownMs','image','status','timestampMs']);
  assert.throws(() => g.refereeFrame(-1)); assert.throws(() => g.refereeFrame(9999));
});
test('固定五秒准备允许旋转瞄准，不能移动开火，不消耗正式回合时间',()=>{
  const g=new Game();g.start({...setup,clock:'realtime',countdownMs:0});assert.equal(g.countdownMs,5000);
  const initial=g.refereeRecord().finalState.robots.blue;
  g.action('blue',{...neutral(),moveX:1,moveY:1,spin:.5,aimX:0,aimY:0,fire:true,durationMs:500},'agent');
  const before=g.observe();g.advance(24);const after=g.refereeRecord().finalState.robots.blue;
  assert.notEqual(after.angle,initial.angle);assert.notEqual(after.turret,initial.turret);assert.notEqual(g.observe().image.base64,before.image.base64);
  assert.equal(after.x,initial.x);assert.equal(after.y,initial.y);assert.equal(after.shots,0);assert.equal(after.ammo,R.ammo);assert.equal(g.tickCount,0);
  g.advance(480);g.advance(480);g.advance(215);assert.equal(g.status,'countdown');assert.ok(Math.abs(g.countdownMs-1000/240)<1e-9);
  g.action('blue',{...neutral(),moveX:1,fire:true,durationMs:500},'agent');g.advance(1);assert.equal(g.status,'running');assert.equal(g.tickCount,0);
  g.advance(1);assert.equal(g.tickCount,1);const started=g.refereeRecord().finalState.robots.blue;assert.equal(started.x,initial.x);assert.equal(started.shots,0);
  g.action('blue',{...neutral(),moveX:1,durationMs:100},'agent');g.fire('blue','agent');g.advance(4);assert.ok(g.refereeRecord().finalState.robots.blue.x>initial.x);assert.equal(g.refereeRecord().finalState.robots.blue.shots,1);
  g.stop();assert.equal(replay(g.refereeRecord()).identical,true);
});
test('准备期支持暂停恢复停止，旧倒计时配置统一成五秒',()=>{
  const g=new Game();g.start({...setup,countdownMs:3000});g.advance(240);g.pause();const remaining=g.countdownMs;
  g.advance(480);assert.equal(g.countdownMs,remaining);g.resume();finishPreparation(g);assert.equal(g.status,'running');
  g.stop();assert.equal(g.countdownMs,0);for(const countdownMs of [0,3000,5000,9000]){g.start({...setup,countdownMs});assert.equal(g.countdownMs,5000);assert.equal(g.setup.countdownMs,5000);}
});
