// Host scheduling only. Never included in participant capabilities.
import { RULES } from './protocol.js';
export const CONTROL_HZ = 60;
export const CONTROL_STEPS = RULES.tickHz / CONTROL_HZ;
export const nextControlStep = (step:number) => Math.ceil(step / CONTROL_STEPS) * CONTROL_STEPS;
// The public integer-millisecond lease is rounded to the nearest control period.
// 16 and 17 ms both mean one period, without a 5-step/48 Hz rounding accident.
export const leaseSteps = (durationMs:number) => Math.max(1,Math.round(durationMs * CONTROL_HZ / 1000)) * CONTROL_STEPS;
