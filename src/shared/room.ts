import { SIDE, validateFireSettings, validateSide, validateTuning, type RoomConfig, type ScriptChoice } from './protocol.js';
import { AI_ALIASES, PRIVILEGED_AI, validatePrivilegedSeats } from './privileged-ai.js';
export const DEFAULT_SCRIPT = PRIVILEGED_AI.id;
export const KEYBOARD = 'keyboard';
export function keyboardSide(room?: RoomConfig): 'blue' | 'red' | undefined { return room && SIDE.find(side => room.seats[side] === KEYBOARD); }
export function normalizeRoom(input: unknown): RoomConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('需要房间配置');
  const r = input as { seats?: Record<string,unknown>; mode?:unknown; playerSide?:unknown; scripts?:Record<string,unknown> };
  if (r.seats !== undefined) {
    if (!r.seats || typeof r.seats !== 'object' || SIDE.some(side => typeof r.seats![side] !== 'string')) throw new Error('需要为双方选择控制者');
    return { seats: { blue:r.seats.blue as string, red:r.seats.red as string } };
  }
  // Legacy room configuration is read once and discarded; seats are canonical.
  if (!['pve','eve'].includes(r.mode as string) || !r.scripts || typeof r.scripts !== 'object') throw new Error('需要为双方选择控制者');
  const player = r.mode === 'pve' ? validateSide(r.playerSide) : undefined;
  return { seats: Object.fromEntries(SIDE.map(side => [side,side === player ? KEYBOARD : r.scripts![side]])) as Record<'blue'|'red',string> };
}
export function upgradeRoomAI(input: unknown, config: unknown) {
  const room=normalizeRoom(input),privilegedAI=validatePrivilegedSeats(config);
  for (const side of SIDE) {
    const seat=room.seats[side];
    const alias=typeof seat==='string'&&seat.startsWith('builtin:') ? seat.slice('builtin:'.length) : '';
    if (!Object.hasOwn(AI_ALIASES,alias)) continue;
    room.seats[side]=PRIVILEGED_AI.id;
    privilegedAI[side] ??= {...AI_ALIASES[alias as keyof typeof AI_ALIASES]};
  }
  return {room,privilegedAI};
}
export function validateRoom(input: unknown, choices: readonly ScriptChoice[]): RoomConfig {
  const r = normalizeRoom(input);
  if (SIDE.filter(side => r.seats[side] === KEYBOARD).length > 1) throw new Error('本机只有一套键鼠，不能同时绑定双方');
  for (const side of SIDE) if (r.seats[side] !== KEYBOARD) {
    if (typeof r.seats[side] !== 'string' || !choices.some(c => c.id === r.seats[side])) throw new Error(`${side === 'blue' ? '蓝方' : '红方'}脚本不可用，请重新选择`);
  }
  return r;
}
export function roomErrors(setup: { room?: RoomConfig; tuning?: unknown; minFireIntervalMs?:unknown; fireRateHz?:unknown; privilegedAI?:unknown; clock: string }, choices: readonly ScriptChoice[]): string[] {
  const errors: string[] = [];
  try { validateRoom(upgradeRoomAI(setup.room,setup.privilegedAI).room, choices); } catch (e) { errors.push((e as Error).message); }
  try { validateTuning(setup.tuning); } catch (e) { errors.push((e as Error).message); }
  try { validateFireSettings(setup); } catch (e) { errors.push((e as Error).message); }
  if (setup.clock !== 'realtime') errors.push('本地房间使用实时模式');
  return errors;
}
