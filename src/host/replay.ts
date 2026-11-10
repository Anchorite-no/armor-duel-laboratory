// Offline adjudication. Not included in client bundle or participant capabilities.
import { Game, type ActionRecord, type Setup } from './game.js';
import { RULES, validateFireSettings } from '../shared/protocol.js';
import type { State } from './physics.js';
export interface RecordInput { format: string; version: string; rules?:{bulletSpeed?:number;fireHz?:number;humanFireHz?:number;minFireIntervalMs?:number;fireRateHz?:number}; setup: Setup; finalTick: number; finalStep: number; actions: ActionRecord[]; snapshots?:{step:number;tick:number;state:State}[]; finalState: unknown;finalMotion?:unknown;recordingError?:string }
export function replay(record: RecordInput) {
  if(record.recordingError)throw Error('记录不完整：'+record.recordingError);
  const legacyActionTicks = ['0.6.2','0.6.3','0.6.4','0.6.5'].includes(record.version);
  const current = record.version === RULES.version;
  const singleFire = current || record.version==='0.7.9' || record.version==='0.7.8' || record.version==='0.7.7';
  const priorBallistics = ['0.7.1','0.7.2','0.7.3','0.7.4','0.7.5','0.7.6','0.7.7','0.7.8','0.7.9'].includes(record.version);
  if (record.format !== 'laboratory-referee-v2' || (!current && !priorBallistics && !legacyActionTicks && record.version !== '0.7.0')) throw new Error('记录版本不支持');
  const bulletSpeed = current ? RULES.bulletSpeed : priorBallistics ? 1000 : legacyActionTicks ? 525 : 800;
  const fireHz = current ? RULES.fireHz : priorBallistics ? 20 : 5;
  const humanFireHz = singleFire ? RULES.humanFireHz : ['0.7.3','0.7.4','0.7.5','0.7.6'].includes(record.version) ? 10 : undefined;
  const heatEnabled = singleFire || ['0.7.2','0.7.3','0.7.4','0.7.5','0.7.6'].includes(record.version);
  if(record.rules?.bulletSpeed!==undefined&&record.rules.bulletSpeed!==bulletSpeed)throw Error('记录弹速与规则版本不一致');
  if(record.rules?.fireHz!==undefined&&record.rules.fireHz!==fireHz)throw Error('记录射速与规则版本不一致');
  if(record.rules?.humanFireHz!==undefined&&record.rules.humanFireHz!==humanFireHz)throw Error('记录键鼠射速与规则版本不一致');
  if (singleFire) {
    const settings = validateFireSettings(record.setup);
    if (record.setup.minFireIntervalMs!==settings.minFireIntervalMs ||
        record.rules?.minFireIntervalMs!==settings.minFireIntervalMs ||
        record.rules?.fireRateHz!==settings.fireRateHz ||
        (record.version==='0.7.7' && settings.fireRateHz!==undefined)) throw Error('记录射速或最小出弹间隔与对局配置不一致');
  }
  if (!Number.isInteger(record.finalTick) || record.finalTick < 0 || record.finalTick > 28800) throw new Error('记录时间越界');
  if (!Number.isInteger(record.finalStep) || record.finalStep < 0 || record.finalStep > 30000) throw new Error('记录总时间越界');
  const initial=record.snapshots?.find(s=>s.step===0&&s.tick===0)?.state;
  if(record.version!==RULES.version&&!initial)throw new Error('旧记录缺少初始快照，不能重解释出生位置');
  if(initial&&(initial.tick!==0||JSON.stringify(initial.tuning)!==JSON.stringify(record.setup.tuning)))throw new Error('初始快照与记录配置不一致');
  // Replay recorded actions, not today's randomized controller. Old initial
  // coordinates and turret/body orientations remain exactly as recorded.
  const game = new Game(true,['0.6.2','0.6.3','0.6.4'].includes(record.version),false,{version:record.version,bulletSpeed,fireHz,legacyActionTicks,heatEnabled,humanFireHz}); game.start(record.setup,initial);
  let cursor = 0;
  for (let step = 0; step <= record.finalStep; step++) {
    while (cursor < record.actions.length && record.actions[cursor].step === step) {
      const entry = record.actions[cursor++];
      if (entry.action) game.action(entry.side, entry.action, entry.source!,entry.effectiveTicks,entry.heatProtection);
      if (entry.fire && (!singleFire || !game.fire(entry.side,entry.source!))) throw Error('记录含无效的单发请求');
      if (entry.aim) game.retargetHuman(entry.side,entry.aim);
      if (entry.cancel) game.cancel(entry.side, entry.source!);
      if (entry.pause) game.pause();
      if (entry.resume) game.resume();
      if (entry.stop) game.stop();
    }
    if (step < record.finalStep) { if (!['running','countdown'].includes(game.status)) throw new Error('记录含无法推进的暂停或停止区间'); game.advance(1); }
  }
  const actual = game.refereeRecord();
  return { identical: JSON.stringify(actual.finalState) === JSON.stringify(record.finalState) && (record.finalMotion===undefined||JSON.stringify(actual.finalMotion)===JSON.stringify(record.finalMotion)), actual };
}
