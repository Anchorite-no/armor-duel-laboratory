// Ideal symmetric chassis: normalized wheel-speed-square sum, no acceleration.
// This game "power" is not a model of real electrical power.
import { motionCalibration, RULES, type MotionModel } from './protocol.js';
export function motionCaps(power: number = RULES.power, model?:MotionModel) {
  const limits = motionCalibration(model);
  const scale = Math.sqrt(power) / Math.sqrt(limits.referencePower);
  return { maxSpeed: limits.maxSpeed * scale, maxSpin: limits.maxSpin * scale };
}
export const rotationPower = (spin: number) => spin * spin;
export const translationLimit = (spin: number) => Math.sqrt(Math.max(0, 1 - rotationPower(spin)));
