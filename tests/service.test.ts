import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TracedLaboratory as Laboratory } from './support.js';
import { finishPreparation, neutralMotion } from './support.js';
import { Program } from '../src/host/program.js';
const dir = path.resolve('.local/test-records');
const setup = { clock: 'realtime', scenario: 'duel', targetSpin: 0.5, controllers: { blue: 'agent', red: 'idle' } };
test('实时动作取消会结束等待，并在宿主清除动作', async () => {
  const lab = new Laboratory(dir); await lab.admin('start', { setup });
  const abort = new AbortController();
  const result = lab.participant('act', { side: 'blue', action: { ...neutralMotion(), moveX: 1, durationMs: 500 } }, 'agent', abort.signal);
  abort.abort(); await assert.rejects(result);
  const before = lab.game.refereeRecord().finalState.robots.blue.x; lab.game.advance(240);
  assert.equal(lab.game.refereeRecord().finalState.robots.blue.x, before); await lab.dispose();
});
test('模型接口不能调用管理、裁判记录、重开或任意真值查询', async () => {
  const lab = new Laboratory(dir);
  for (const method of ['record', 'replayFrame', 'start', 'program', 'truth', 'state', 'saveScript', 'scriptSource']) await assert.rejects(lab.participant(method, {}, 'agent'));
  await lab.dispose();
});
test('按步模式观测不推进时钟，动作按量化时间推进', async () => {
  const lab = new Laboratory(dir); await lab.admin('start', { setup: { ...setup, clock: 'stepped' } });
  lab.pump(performance.now() + 10000); assert.equal(lab.game.tickCount, 0);
  finishPreparation(lab.game);const o = await lab.participant('act', { side: 'blue', action: { ...neutralMotion(), durationMs: 100 } }, 'agent') as { image:{mimeType:string} };
  assert.equal(o.image.mimeType,'image/jpeg');assert.equal(lab.game.tickCount,24); await lab.dispose();
});
test('脚本进程通过公开观测和动作接口完成闭环，退出清理', async () => {
  const p = new Program(),lab=new Laboratory(dir);const frame=await lab.participant('observe',{},'script'); let calls = 0, cancelled = false;
  await p.run('const o = await lab.observe(); await lab.log(o.frameId); await lab.act({moveX:0});', 'blue', async (method) => { calls++; return frame; }, () => { cancelled = true; });
  const deadline = Date.now() + 5000;
  while (p.info().status === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(p.info().status, 'ended', p.info().output); assert.equal(calls, 2); assert.equal(cancelled, true); assert.match(p.info().output, /1/); await p.stop();await lab.dispose();
});
test('实际 Node 权限：项目文件读取、写文件、子进程和 Worker 被拒绝', async () => {
  const p = new Program();
  const code = `
    const fs = await import('node:fs');
    const cp = await import('node:child_process');
    const wt = await import('node:worker_threads');
    let blocked = 0;
    for (const operation of [
      () => fs.readFileSync(${JSON.stringify(path.resolve('package.json'))}),
      () => fs.writeFileSync(${JSON.stringify(path.resolve('.local/should-not-exist'))}, 'x'),
      () => cp.spawnSync(process.execPath, ['--version']),
      () => new wt.Worker('0', {eval:true}),
    ]) {try { operation(); } catch(e) { if(e.code === 'ERR_ACCESS_DENIED') blocked++; }}
    await lab.log('blocked=' + blocked);
  `;
  await p.run(code, 'blue', async () => null, () => {});
  const deadline = Date.now() + 5000; while (p.info().status === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(p.info().status, 'ended', p.info().output); assert.match(p.info().output, /blocked=4/); assert.match(p.info().restriction, /网络.*未/); await p.stop();
});
test('停止忙循环脚本会杀掉独立进程，且不依赖脚本协作', async () => {
  const p = new Program(); let cancelled = false;
  await p.run('while(true) {}', 'blue', async () => null, () => { cancelled = true; });
  await p.stop(); assert.equal(p.info().status, 'stopped'); assert.equal(cancelled, true);
});
test('脚本能解码宿主 JPEG 为 RGB，解码不需要裁判真值', async () => {
  const p = new Program(), lab = new Laboratory(dir);
  const observation = await lab.participant('observe',{},'script');
  await p.run('const o = await lab.observe(); const p = lab.pixels(o); await lab.log([p.width,p.height,p.channels,p.data.length].join(","));', 'blue', async () => observation, () => {});
  const deadline = Date.now() + 5000; while (p.info().status === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(p.info().status, 'ended', p.info().output); assert.match(p.info().output, /960,680,3,1958400/);
  await p.stop(); await lab.dispose();
});
