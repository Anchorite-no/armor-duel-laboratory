import { RULES, type Scenario, type Side, type ScriptChoice } from '../shared/protocol.js';
import type { Setup } from './types.js';
import { playSetup } from './types.js';
import { DEFAULT_SCRIPT, KEYBOARD, normalizeRoom, roomErrors, upgradeRoomAI } from '../shared/room.js';
import { PRIVILEGED_AI } from '../shared/privileged-ai.js';
export type ConnectionState = 'connecting' | 'ready' | 'error';
export function switchRoomSeat(setup: Setup, from: Side, to: Side): Setup {
  return selectRoomController(setup,to,KEYBOARD);
}
export function selectRoomController(setup: Setup, side: Side, value: string): Setup {
  const next = structuredClone(setup);
  const room = normalizeRoom(next.room), other=side==='blue'?'red':'blue';
  if(value===KEYBOARD && room.seats[other]===KEYBOARD)room.seats[other]=room.seats[side];
  room.seats[side]=value;
  Object.assign(next,upgradeRoomAI(room,next.privilegedAI));
  for(const s of ['blue','red']as const)next.controllers[s]=next.room!.seats[s]===KEYBOARD?'human':next.room!.seats[s]===PRIVILEGED_AI.id?'privileged':'script';
  return next;
}
export function changeRoomScenario(setup: Setup, scenario: Scenario, playerSide: Side): Setup {
  const opponent = playerSide === 'blue' ? 'red' : 'blue';
  return { ...structuredClone(setup), scenario, controllers: { ...setup.controllers, [opponent]: scenario === 'duel' ? 'computer' : scenario === 'spinner' ? 'spinner' : 'fixed' } };
}
export function canEnterRoom(connection: ConnectionState, busy: boolean): boolean { return connection === 'ready' && !busy; }
export function createRoomSetup(): Setup {
  return { ...playSetup(), controllers:{red:'human',blue:'privileged'}, tuning: { hp: RULES.hp, damage: RULES.damage, power: RULES.power }, room: { seats: { red: KEYBOARD, blue: DEFAULT_SCRIPT } } };
}
export function freshMatchSetup(setup:Setup,recording=false):Setup {
  const next=structuredClone(setup);delete next.controllerSeeds;next.recording=recording;return next;
}
export function validateRoomSetup(setup: Setup, scripts: readonly ScriptChoice[]) { return roomErrors(setup, scripts); }
