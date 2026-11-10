// Owner/host protocol. Never export rules to participant tools or script SDK.
import { CONTACT_TOLERANCE } from './numerics.js';
export type Side = 'blue' | 'red';
export type ClockMode = 'realtime' | 'stepped';
export type Scenario = 'duel' | 'spinner' | 'shooter';
export interface Tuning { hp: number; damage: number; power: number }
// Older room configs omit power; normalize them at the host boundary.
export type TuningInput = Omit<Tuning, 'power'> & { power?: number };
export const REFERENCE_POWER = 50;
export interface RoomConfig { seats: Record<Side, string> }
export interface ScriptChoice { id: string; name: string; description: string; kind: 'builtin' | 'custom'; controller: 'privileged' | 'computer' | 'spinner' | 'fixed' | 'script'; hash: string; implementation?: string }
export interface ScriptBinding { side: Side; id: string; name: string; kind: 'builtin' | 'custom'; hash: string; implementation?: string }
export interface Action {
  moveX: number; moveY: number; spin: number; aimX: number; aimY: number; fire: boolean; durationMs: number;
}
export type MotionAction = Omit<Action, 'fire'>;
// Owner UI only: never return this structured state from participant RPC.
export interface OwnerObservation {
  version: string; matchId: string; timestampMs: number; clock: ClockMode;
  status: 'ready' | 'countdown' | 'running' | 'paused' | 'ended' | 'stopped';
  countdownMs: number;
  rules: Tuning;
  scenario: Scenario; winner: Side | 'draw' | null;
  overheatDeaths?: Side[];
  hud: Record<Side, { hp: number; ammo: number; shots: number; hits: number; heat?: number }>;
  controller: Record<Side, string>;
  image: { mimeType: 'image/png'; width: number; height: number; base64: string };
}
export interface ParticipantObservation { readonly frameId:number; readonly image:{readonly mimeType:'image/jpeg';readonly width:number;readonly height:number;readonly base64:string} }
const BODY_RADIUS = 23;
const BODY_DIAMETER = BODY_RADIUS * 2;
export type MotionModel = 'current' | '0.7.9' | 'legacy';
export const RULES = {
  version: '0.8.0', width: 960, height: 600, tickHz: 240,
  radius: 26, plateLength: 12, plateThickness: 4, bulletRadius: 2,
  spawnArmorAngle: Math.PI/4, arenaInset:34,
  bodyRadius: BODY_RADIUS, bodyDiameter: BODY_DIAMETER, barrelLength: 36, barrelRadius: 4,
  hp: 200, damage: 10, power: 50, ammo: 600, bulletSpeed: 1000, fireHz: 20,
  humanFireHz: 10, minFireIntervalMs: 50,
  heat: { perShot: 10, limit: 100, coolingPerSecond: 20, maxHpFraction: 0.1 },
  // The 46px chassis diameter represents 1m. Reference power 50.
  maxSpeed: 4 * BODY_DIAMETER, maxSpin: 8, turretSpeed: 10, durationMs: 60000,
  maxActionMs: 500, preparationMs: 5000,
} as const;
const motionModels = {
  current: {maxSpeed:RULES.maxSpeed,maxSpin:RULES.maxSpin,referencePower:REFERENCE_POWER},
  '0.7.9': {maxSpeed:3*BODY_DIAMETER,maxSpin:8,referencePower:50},
  legacy: {maxSpeed:8*BODY_DIAMETER,maxSpin:16,referencePower:100},
} as const;
export const motionCalibration = (model: MotionModel = 'current') => motionModels[model];
export const SIDE = ['blue', 'red'] as const;
export function validateFireInterval(input: unknown = RULES.minFireIntervalMs): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) throw Error('最小出弹间隔必须为正整数毫秒');
  return input;
}
export function validateFireRate(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input<=0) throw Error('射速必须为正有限数');
  return input;
}
export type FireSettings = {fireRateHz?:number;minFireIntervalMs?:number};
export function validateFireSettings(settings: {fireRateHz?:unknown;minFireIntervalMs?:unknown}): FireSettings {
  if (settings.fireRateHz===undefined) return {minFireIntervalMs:validateFireInterval(settings.minFireIntervalMs)};
  if (settings.minFireIntervalMs!==undefined) throw Error('射速和最小出弹间隔只能设置一项');
  return {fireRateHz:validateFireRate(settings.fireRateHz)};
}
export const TUNING_FIELDS = {
  hp: { label: '生命值', min: 50, max: 1000 },
  damage: { label: '攻击力', min: 1, max: 100 },
  power: { label: '功率', min: 1, max: 300 },
} as const;
export function validateTuningField(field: keyof Tuning, input: unknown): number {
  const { label, min, max } = TUNING_FIELDS[field];
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
    throw new Error(`${label}：请输入 [${min}, ${max}] 范围内的整数`);
  }
  return input;
}

// Kept for historical recordings and low-level simulation fixtures.
export function validateSimulationPower(input: unknown, bulletSpeed: number = RULES.bulletSpeed, motionModel?:MotionModel): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) throw new Error('功率必须是有限的非负数');
  // sqrt before division preserves even positive subnormal input.
  const limits = motionCalibration(motionModel);
  const scale = Math.sqrt(input) / Math.sqrt(limits.referencePower);
  const speed = limits.maxSpeed * scale, spin = limits.maxSpin * scale;
  const outer = Math.hypot(RULES.radius + RULES.plateThickness / 2, RULES.plateLength / 2);
  const travel = (bulletSpeed + 2 * speed + spin * outer) / RULES.tickHz;
  // Reserve 16 rounding-error units below contact tolerance, including world
  // coordinate arithmetic and unwrapped rotational surface travel per tick.
  if (!Number.isFinite(travel) || (Math.max(RULES.width, RULES.height) + travel) * Number.EPSILON * 16 > CONTACT_TOLERANCE)
    throw new Error('功率超出当前浮点碰撞精度：单步运动舍入误差超过接触容差');
  return input;
}
function readTuning(input: unknown = { hp: RULES.hp, damage: RULES.damage, power: RULES.power }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('共享数值必须为对象');
  const t = input as Record<string, unknown>;
  if (Object.keys(t).some(k => !['hp', 'damage', 'power'].includes(k))) throw new Error('共享数值含未知字段');
  return { hp: t.hp, damage: t.damage, power: t.power === undefined ? RULES.power : t.power };
}
export function validateTuning(input?: unknown): Tuning {
  const { hp, damage, power } = readTuning(input);
  return {
    hp: validateTuningField('hp', hp),
    damage: validateTuningField('damage', damage),
    power: validateTuningField('power', power),
  };
}
export function validateHistoricalTuning(input?: unknown, bulletSpeed?: number, motionModel?:MotionModel): Tuning {
  const { hp, damage, power } = readTuning(input);
  if (typeof hp !== 'number' || !Number.isInteger(hp) || hp < 20 || hp > 1000) throw new Error('历史生命值超出当时的规则范围');
  return { hp, damage: validateTuningField('damage', damage), power: validateSimulationPower(power, bulletSpeed, motionModel) };
}
export function validateAction(input: unknown): Action {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('动作必须是对象');
  const a = input as Record<string, unknown>;
  const allowed = ['moveX', 'moveY', 'spin', 'aimX', 'aimY', 'fire', 'durationMs'];
  if (Object.keys(a).some(k => !allowed.includes(k))) throw new Error('动作含未知字段');
  for (const key of ['moveX', 'moveY', 'spin']) {
    if (typeof a[key] !== 'number' || !Number.isFinite(a[key]) || Math.abs(a[key] as number) > 1) throw new Error(`${key} 必须在 [-1,1]`);
  }
  for (const key of ['aimX', 'aimY']) if (typeof a[key] !== 'number' || !Number.isFinite(a[key]) || (a[key] as number) < 0 || (a[key] as number) > 1) throw new Error(`${key} 是 [0,1] 归一化场地坐标`);
  if (typeof a.fire !== 'boolean') throw new Error('fire 必须为布尔值');
  if (typeof a.durationMs !== 'number' || !Number.isInteger(a.durationMs) || a.durationMs < 1 || a.durationMs > RULES.maxActionMs) throw new Error('durationMs 必须为 1..500 整数');
  return { moveX: a.moveX as number, moveY: a.moveY as number, spin: a.spin as number, aimX: a.aimX as number, aimY: a.aimY as number, fire: a.fire, durationMs: a.durationMs };
}
export function validateMotionAction(input: unknown): MotionAction {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'fire')) throw Error('持续动作只接受移动、瞄准和时长');
  const { fire, ...motion } = validateAction({ ...input, fire: false });
  return motion;
}
export function validateSide(side: unknown): Side {
  if (side !== 'blue' && side !== 'red') throw new Error('side 必须为 blue 或 red');
  return side;
}
