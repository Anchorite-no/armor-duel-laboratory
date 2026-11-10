import { RULES as R, SIDE, validateHistoricalTuning, type MotionModel, type Tuning, type TuningInput, type RoomConfig, type ScriptBinding, type Action, type Side, type ClockMode, type Scenario } from '../shared/protocol.js';
import { translationLimit, motionCaps } from '../shared/motion.js';
import type { VisionConfig } from '../shared/vision.js';
import type { PrivilegedSeats } from '../shared/privileged-ai.js';
import { CONTACT_TOLERANCE, MAX_CONTACT_EVALUATIONS, MAX_STEP_CONTACT_EVALUATIONS, SimulationNumericsError } from '../shared/numerics.js';
export const DT = 1 / R.tickHz;
export const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Heat uses integer units of 1/tickHz so the strict limit is exact after cooling.
// Historical records predate both optional fields and keep their original shape.
export interface Robot { side: Side; x: number; y: number; angle: number; turret: number; hp: number; ammo: number; shots: number; hits: number; nextShot: number; heatUnits?: number }
export interface Bullet { id: number; owner: Side; x: number; y: number; vx: number; vy: number }
export interface Event { tick: number; type: string; [key: string]: unknown }
export interface State { tick: number; tuning: Tuning; robots: Record<Side, Robot>; bullets: Bullet[]; events: Event[]; nextBullet: number; winner: Side | 'draw' | null; overheatDeaths?: Side[] }
export function createState(input?: TuningInput, heatEnabled = true, bulletSpeed?: number, motionModel?:MotionModel): State {
  const tuning = validateHistoricalTuning(input, bulletSpeed, motionModel);
  const armorOffset=motionModel===undefined||motionModel==='current'?R.spawnArmorAngle:0;
  const robot = (side: Side, x: number, turret: number): Robot => ({ side, x, y: R.height / 2, angle:armorOffset?wrap(turret+armorOffset):turret, turret, hp: tuning.hp, ammo: R.ammo, shots: 0, hits: 0, nextShot: 0, ...(heatEnabled ? { heatUnits: 0 } : {}) });
  return { tick: 0, tuning, robots: { red: robot('red', 210, 0), blue: robot('blue', R.width - 210, Math.PI) }, bullets: [], events: [], nextBullet: 1, winner: null };
}
export const neutral = (r?: Robot): Action => ({ moveX: 0, moveY: 0, spin: 0, aimX: r ? (r.x + Math.cos(r.turret) * 30) / R.width : 0.5, aimY: r ? (r.y + Math.sin(r.turret) * 30) / R.height : 0.5, fire: false, durationMs: 1 });
export function velocity(a: Action, power: number = R.power, motionModel?:MotionModel) {
  const n = Math.max(1, Math.hypot(a.moveX, a.moveY));
  const caps = motionCaps(power,motionModel);
  if (motionModel==='legacy') {
    const speed = caps.maxSpeed * translationLimit(a.spin);
    return { x: a.moveX / n * speed, y: a.moveY / n * speed, omega: a.spin * caps.maxSpin };
  }
  const x = a.moveX/n, y = a.moveY/n;
  const demand = Math.max(1,Math.hypot(x,y,a.spin));
  return { x: x/demand*caps.maxSpeed, y: y/demand*caps.maxSpeed, omega: a.spin/demand*caps.maxSpin };
}
export interface Motion { start: Robot; end: Robot; omega: number }
interface ContactBudget { remaining: number }
// Distance to the actual finite rotating rectangle, with projectile radius included.
function plateGap(b: Bullet, m: Motion, plate: number, t: number, dt: number) {
  const f = dt === 0 ? 0 : t / dt;
  const angle = m.start.angle + m.omega * t + plate * Math.PI / 2;
  const c = Math.cos(angle), s = Math.sin(angle);
  const x = b.x + b.vx * t - (m.start.x + (m.end.x - m.start.x) * f);
  const y = b.y + b.vy * t - (m.start.y + (m.end.y - m.start.y) * f);
  const radial = x * c + y * s - R.radius;
  const tangent = -x * s + y * c;
  return Math.hypot(Math.max(Math.abs(radial) - R.plateThickness / 2, 0), Math.max(Math.abs(tangent) - R.plateLength / 2, 0)) - R.bulletRadius;
}
// Conservative advancement using a Lipschitz bound on relative surface speed.
// Every advance is no longer than distance / speed bound, so it cannot skip a plate.
export function sweepPlate(b: Bullet, m: Motion, plate: number, dt: number, budget?: ContactBudget): number | null {
  const vx = dt ? (m.end.x - m.start.x) / dt : 0;
  const vy = dt ? (m.end.y - m.start.y) / dt : 0;
  const outer = Math.hypot(R.radius + R.plateThickness / 2, R.plateLength / 2);
  const bound = Math.hypot(b.vx - vx, b.vy - vy) + Math.abs(m.omega) * outer;
  return sweepGap(t => plateGap(b, m, plate, t, dt), bound, dt, budget);
}
function sweepGap(distance: (t: number) => number, bound: number, dt: number, budget?: ContactBudget): number | null {
  if (!Number.isFinite(bound) || bound < 0 || !Number.isFinite(dt) || dt < 0 || bound * dt * Number.EPSILON * 16 > CONTACT_TOLERANCE)
    throw new SimulationNumericsError('碰撞运动超出浮点接触精度，已停止模拟');
  let evaluations = 0;
  const evaluate = (time: number) => {
    if (budget && --budget.remaining < 0) throw new SimulationNumericsError('碰撞求解超出单步计算预算，已停止模拟；请降低功率或调整场景');
    if (++evaluations > MAX_CONTACT_EVALUATIONS) throw new SimulationNumericsError('碰撞求解超出单次计算预算，已停止模拟；请降低功率或调整场景');
    const gap = distance(time);
    if (!Number.isFinite(gap)) throw new SimulationNumericsError('碰撞计算产生非有限数，已停止模拟');
    return gap;
  };
  let t = 0;
  for (let i = 0; i < 512; i++) {
    const gap = evaluate(t);
    if (gap <= CONTACT_TOLERANCE) return t;
    if (bound === 0 || t + gap / bound > dt) return null;
    t += gap / bound;
  }
  // Near a grazing corner conservative advancement converges slowly. Subdivide
  // the unresolved interval using the same Lipschitz lower bound; never turn an
  // iteration budget into a missed collision.
  const search = (lo: number, hi: number, a: number, z: number): number | null => {
    if (a <= CONTACT_TOLERANCE) return lo;
    if ((a + z - bound * (hi - lo)) / 2 > 0) return null;
    if (bound * (hi - lo) <= CONTACT_TOLERANCE) return lo;
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) throw new SimulationNumericsError('碰撞时间区间超出浮点分辨率，已停止模拟');
    const gap = evaluate(mid);
    return search(lo, mid, a, gap) ?? search(mid, hi, gap, z);
  };
  return search(t, dt, evaluate(t), evaluate(dt));
}
// Only the chassis disk blocks non-armor shots. The barrel is visual only.
export function sweepBody(b: Bullet, m: Motion, dt: number, budget?: ContactBudget): number | null {
  const vx = b.vx - (dt ? (m.end.x - m.start.x) / dt : 0);
  const vy = b.vy - (dt ? (m.end.y - m.start.y) / dt : 0);
  const dx = b.x - m.start.x, dy = b.y - m.start.y;
  return sweepGap(t => {
    const x = dx + vx * t, y = dy + vy * t;
    return Math.hypot(x, y) - R.bodyRadius - R.bulletRadius;
  }, Math.hypot(vx, vy), dt, budget);
}
// Exactly opposite headings have two equal arcs. Use the same clockwise tie
// for both sides; historical playback keeps its original signed-pi choice.
const turretError=(angle:number,legacy:boolean)=>{
  const error=wrap(angle);return !legacy&&Math.abs(Math.abs(error)-Math.PI)<1e-12?Math.PI:error;
};
export function prepareTick(state: State, actions: Record<Side, Action>, legacyTurretTie=false, motionModel?:MotionModel) {
  for (const side of SIDE) {
    const r = state.robots[side], a = actions[side];
    const aim = Math.atan2(a.aimY * R.height - r.y, a.aimX * R.width - r.x);
    r.turret = wrap(r.turret + clamp(turretError(aim-r.turret,legacyTurretTie), -R.turretSpeed * DT, R.turretSpeed * DT));
    r.angle = wrap(r.angle + velocity(a, state.tuning.power, motionModel).omega * DT);
  }
}
export type Ballistics = { bulletSpeed: number; fireHz: number; fireIntervalTicks?: Record<Side,number>; heatEnabled?: boolean; motionModel?:MotionModel };
type HumanFirePolicy = { side: Side; fireHz: number; heatProtection: boolean };
const shotHeat = R.heat.perShot * R.tickHz;
const heatLimit = R.heat.limit * R.tickHz;
const cooledHeat = (heat: number, ticks: number) => Math.max(0, heat - ticks * R.heat.coolingPerSecond);

export function canFireWithoutOverheat(heat: number, cooldownTicks: number) {
  // The shot step itself cools first, just like every running step before it.
  return cooledHeat(heat, cooldownTicks + 1) + shotHeat <= heatLimit;
}

function shoot(state: State, side: Side, a: Action, { bulletSpeed, fireHz, fireIntervalTicks, heatEnabled }: Ballistics, humanFire?: HumanFirePolicy) {
  const r = state.robots[side];
  if (!a.fire || r.hp <= 0 || r.ammo <= 0 || state.tick < r.nextShot) return;
  const heatAfterShot = heatEnabled !== false && r.heatUnits !== undefined ? r.heatUnits + shotHeat : undefined;
  const overheats = (heatAfterShot ?? 0) > heatLimit;
  if (humanFire?.heatProtection && overheats) return;
  const c = Math.cos(r.turret), s = Math.sin(r.turret);
  const muzzle = R.barrelLength + R.barrelRadius + R.bulletRadius + 0.01;
  state.bullets.push({ id: state.nextBullet++, owner: side, x: r.x + c * muzzle, y: r.y + s * muzzle, vx: c * bulletSpeed, vy: s * bulletSpeed });
  const configuredTicks = fireIntervalTicks?.[side];
  const interval = configuredTicks === undefined
    ? R.tickHz / (humanFire?.fireHz ?? fireHz)
    : Math.max(configuredTicks, humanFire ? R.tickHz / humanFire.fireHz : 0);
  r.ammo--; r.shots++; r.nextShot = state.tick + interval;
  state.events.push({ tick: state.tick, type: 'shot', side, x: r.x + c * muzzle, y: r.y + s * muzzle, angle: r.turret });
  if (heatAfterShot === undefined) return;
  r.heatUnits = heatAfterShot;
  if (!overheats) return;
  // Both damage sources preserve tenths of an HP, including non-multiple-of-ten max HP.
  const damageTenths = Math.round(state.tuning.hp * 10 * R.heat.maxHpFraction);
  r.hp = Math.max(0, Math.round(r.hp * 10) - damageTenths) / 10;
  state.events.push({ tick: state.tick, type: 'overheat', side, damage: damageTenths / 10, hp: r.hp, heat: heatAfterShot / R.tickHz });
  return r.hp === 0;
}
export function tick(state: State, actions: Record<Side, Action>, ballistics: Ballistics = R, legacyTurretTie = false, humanFire?: HumanFirePolicy) {
  if (state.winner) return;
  const robots = Object.fromEntries(SIDE.map(side => [side, { ...state.robots[side] }])) as Record<Side, Robot>;
  const bullets = state.bullets.map(b => ({ ...b })), eventsLength = state.events.length, nextBullet = state.nextBullet;
  try { tickState(state, actions, ballistics, legacyTurretTie, humanFire); }
  catch (error) {
    if (error instanceof SimulationNumericsError) {
      for (const side of SIDE) {
        Object.assign(state.robots[side], robots[side]);
        if (robots[side].heatUnits === undefined) delete state.robots[side].heatUnits;
      }
      state.bullets = bullets; state.events.length = eventsLength; state.nextBullet = nextBullet;
    }
    throw error;
  }
}
function tickState(state: State, actions: Record<Side, Action>, ballistics: Ballistics, legacyTurretTie: boolean, humanFire?: HumanFirePolicy) {
  if (state.winner) return;
  const motions = {} as Record<Side, Motion>;
  let overheatDeaths: Side[] | undefined;
  for (const side of SIDE) {
    const r = state.robots[side], a = actions[side], v = velocity(a, state.tuning.power,ballistics.motionModel), start = { ...r };
    if (ballistics.heatEnabled !== false) r.heatUnits = cooledHeat(r.heatUnits ?? 0, 1);
    const aim = Math.atan2(a.aimY * R.height - r.y, a.aimX * R.width - r.x);
    r.turret = wrap(r.turret + clamp(turretError(aim-r.turret,legacyTurretTie), -R.turretSpeed * DT, R.turretSpeed * DT));
    start.turret = r.turret;
    // Fire from the start of this tick, after the bounded turret slew.
    if (shoot(state, side, a, ballistics, humanFire?.side === side ? humanFire : undefined)) (overheatDeaths ??= []).push(side);
    r.x = clamp(r.x + v.x * DT, R.arenaInset, R.width - R.arenaInset);
    r.y = clamp(r.y + v.y * DT, R.arenaInset, R.height - R.arenaInset);
    r.angle = wrap(r.angle + v.omega * DT);
    motions[side] = { start, end: r, omega: v.omega };
  }
  // Symmetric robot separation; project both equally onto the permitted arena.
  const blue = state.robots.blue, red = state.robots.red;
  const dx = red.x - blue.x, dy = red.y - blue.y, d = Math.hypot(dx, dy);
  if (d < 2 * R.radius) {
    const ux = d > 1e-9 ? dx / d : 1, uy = d > 1e-9 ? dy / d : 0;
    const correction = (2 * R.radius - d) / 2;
    blue.x -= ux * correction; blue.y -= uy * correction;
    red.x += ux * correction; red.y += uy * correction;
    const shiftX = Math.max(R.arenaInset - Math.min(blue.x, red.x), 0) - Math.max(Math.max(blue.x, red.x) - (R.width - R.arenaInset), 0);
    const shiftY = Math.max(R.arenaInset - Math.min(blue.y, red.y), 0) - Math.max(Math.max(blue.y, red.y) - (R.height - R.arenaInset), 0);
    for (const r of [blue, red]) { r.x += shiftX; r.y += shiftY; }
  }
  const hits: { b: Bullet; target: Side; t: number; plate: number; x: number; y: number }[] = [];
  const survivors: Bullet[] = [];
  const blocked: { b: Bullet; target: Side; t: number }[] = [];
  const budget = { remaining: MAX_STEP_CONTACT_EVALUATIONS };
  for (const b of state.bullets) {
    const target = b.owner === 'blue' ? 'red' : 'blue';
    let earliest = Infinity, plate = -1;
    for (let p = 0; p < 4; p++) {
      const t = sweepPlate(b, motions[target], p, DT, budget);
      if (t !== null && t < earliest) { earliest = t; plate = p; }
    }
    const bodyTime = sweepBody(b, motions[target], DT, budget);
    // Armor wins only an actual tie within the same contact tolerance.
    if (bodyTime !== null && (plate === -1 || bodyTime < earliest - 1e-10)) blocked.push({ b, target, t: bodyTime });
    else if (plate !== -1) hits.push({ b, target, t: earliest, plate, x: b.x + b.vx * earliest, y: b.y + b.vy * earliest });
    else { b.x += b.vx * DT; b.y += b.vy * DT; if (b.x >= 0 && b.x <= R.width && b.y >= 0 && b.y <= R.height) survivors.push(b); }
  }
  state.bullets = survivors;
  for (const { b, target, t } of blocked) state.events.push({ tick: state.tick, type: 'block', target, bullet: b.id, x: b.x + b.vx * t, y: b.y + b.vy * t, fraction: t / DT });
  // Damage in a tick is simultaneous, so equal lethal shots produce a draw.
  for (const h of hits.sort((a, b) => a.t - b.t || a.b.id - b.b.id)) {
    state.robots[h.target].hp = Math.max(0, Math.round(state.robots[h.target].hp * 10) - state.tuning.damage * 10) / 10;
    state.robots[h.b.owner].hits++;
    state.events.push({ tick: state.tick, type: 'hit', side: h.b.owner, target: h.target, bullet: h.b.id, plate: h.plate, x: h.x, y: h.y, fraction: h.t / DT, damage: state.tuning.damage, hp: state.robots[h.target].hp });
  }
  state.tick++;
  if (blue.hp === 0 || red.hp === 0 || state.tick >= R.durationMs / 1000 * R.tickHz) {
    state.winner = blue.hp === red.hp ? 'draw' : blue.hp > red.hp ? 'blue' : 'red';
    if (overheatDeaths) state.overheatDeaths = overheatDeaths;
    state.events.push({ tick: state.tick, type: 'end', winner: state.winner });
  }
}
export interface MatchConfig { clock: ClockMode; scenario: Scenario; targetSpin: number; countdownMs?: number; minFireIntervalMs?:number; fireRateHz?:number; tuning?: TuningInput; room?: RoomConfig; scriptBindings?: ScriptBinding[]; vision?:VisionConfig; controllerSeeds?:Record<Side,number>; privilegedAI?:PrivilegedSeats; recording?:boolean }
