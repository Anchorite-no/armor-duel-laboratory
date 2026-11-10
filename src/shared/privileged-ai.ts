import { SIDE, type Side } from './protocol.js';

export const PRIVILEGED_AI = {id:'builtin:privileged',name:'特权 AI',implementation:'privileged-ai-v2'} as const;
export const AI_OPTIONS = {
  movement:{still:'静止',random:'随机',smart:'智能'},
  rotation:{still:'静止',cw:'顺时针',ccw:'逆时针',sine:'正弦式'},
  shooting:{off:'不射击',center:'中心射击',predict:'预判射击'},
} as const;
export type PrivilegedAI = {[K in keyof typeof AI_OPTIONS]: keyof (typeof AI_OPTIONS)[K]};
export type PrivilegedSeats = Partial<Record<Side,PrivilegedAI>>;
export const DEFAULT_AI: Readonly<PrivilegedAI> = Object.freeze({movement:'smart',rotation:'cw',shooting:'predict'});
export const AI_ALIASES: Readonly<Record<'computer'|'spinner'|'fixed',Readonly<PrivilegedAI>>> = Object.freeze({
  computer:DEFAULT_AI,
  spinner:Object.freeze({movement:'still',rotation:'cw',shooting:'off'}),
  fixed:Object.freeze({movement:'still',rotation:'still',shooting:'center'}),
});

export function validatePrivilegedAI(input: unknown): PrivilegedAI {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw Error('特权 AI 配置无效');
  const value = input as Record<string,unknown>;
  const fields = Object.keys(AI_OPTIONS) as (keyof PrivilegedAI)[];
  if (Object.keys(value).length!==fields.length || fields.some(field=>typeof value[field]!=='string' || !Object.hasOwn(AI_OPTIONS[field],value[field]))) {
    throw Error('特权 AI 的移动、旋转或射击选项无效');
  }
  return {movement:value.movement,rotation:value.rotation,shooting:value.shooting} as PrivilegedAI;
}

export function validatePrivilegedSeats(input: unknown): PrivilegedSeats {
  if (input===undefined) return {};
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(side=>side!=='red'&&side!=='blue')) throw Error('特权 AI 席位配置无效');
  const seats = input as Partial<Record<Side,unknown>>;
  return Object.fromEntries(SIDE.filter(side=>Object.hasOwn(seats,side)).map(side=>[side,validatePrivilegedAI(seats[side])]));
}
