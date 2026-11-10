import type { ClockMode, OwnerObservation, Scenario, Side, TuningInput, RoomConfig, ScriptChoice, ScriptBinding } from '../shared/protocol.js';
import { RULES } from '../shared/protocol.js';
import type { VisionConfig } from '../shared/vision.js';
import type { RecordingInfo } from '../shared/recording.js';
import type { PrivilegedSeats } from '../shared/privileged-ai.js';
export type Api = (method: string, payload?: unknown, signal?: AbortSignal) => Promise<unknown>;
export type Controller = 'human' | 'agent' | 'script' | 'privileged' | 'computer' | 'spinner' | 'fixed' | 'idle';
export interface Setup { clock: ClockMode; scenario: Scenario; targetSpin: number; countdownMs?: number; minFireIntervalMs?:number; fireRateHz?:number; controllers: Record<Side, Controller>; tuning?: TuningInput; room?: RoomConfig; scriptBindings?: ScriptBinding[]; controllerSeeds?:Record<Side,number>; privilegedAI?:PrivilegedSeats; recording?:boolean }
export interface ProgramInfo { status: string; output: string; restriction: string }
export interface View { observation: OwnerObservation; setup: Setup; scripts: ScriptChoice[]; controllerError?: string; programs: Record<Side, ProgramInfo>; restriction: string; vision?:VisionConfig; recording?:RecordingInfo }
export interface ReplayFrame { timestampMs: number; countdownMs: number; status: OwnerObservation['status']; image: OwnerObservation['image'] }
export const labels: Record<string, string> = { blue: '蓝方', red: '红方', draw: '平局', human: '玩家', privileged: '特权 AI', computer: '特权 AI', agent: '智能体工具', script: '图像脚本', spinner: '固定旋转靶', fixed: '固定方向射手', idle: '静止控制器' };
export function resultHeading(winner: Side|'draw'|null|undefined) { return winner==='draw'?'平局':winner?`${labels[winner]}胜利`:''; }
export function resultDetail(result:Pick<OwnerObservation,'status'|'winner'|'hud'|'timestampMs'|'overheatDeaths'>) {
  if(result.status==='stopped')return '对局已停止';
  if(result.status!=='ended'||!result.winner)return '';
  if(result.winner==='draw') {
    if(result.overheatDeaths?.length===2)return '两台机体同时因过热损毁';
    const overheated=result.overheatDeaths?.[0];
    if(overheated)return `${labels[overheated]}因过热损毁，${labels[overheated==='red'?'blue':'red']}机体同时被击毁`;
    if(result.hud.red.hp===0&&result.hud.blue.hp===0)return '两台机体同时被击毁';
    return result.timestampMs>=RULES.durationMs&&result.hud.red.hp===result.hud.blue.hp?'时间到，剩余血量相同':'本轮结束';
  }
  const loser=result.winner==='red'?'blue':'red';
  if(result.overheatDeaths?.includes(loser))return `${labels[loser]}因过热损毁`;
  return result.hud[loser].hp===0?`${labels[loser]}机体被击毁`:result.timestampMs>=RULES.durationMs?`时间到，${labels[loser]}剩余血量较少`:'本轮结束';
}
export function playSetup(scenario: Scenario = 'duel'): Setup {
  return { clock: 'realtime', scenario, countdownMs: 5000, targetSpin: 0.65, controllers: { red: 'human', blue: scenario === 'duel' ? 'computer' : scenario === 'spinner' ? 'spinner' : 'fixed' } };
}
