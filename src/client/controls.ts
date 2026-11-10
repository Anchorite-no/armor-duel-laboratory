import { RULES } from '../shared/protocol.js';
// Screen coordinates: x right, y down, so positive angle is clockwise.
export const KEYBOARD_SPIN = 0.6;
export function keyboardSpin(current: number, key: string, repeat = false) {
  if (repeat) return current;
  if (key === 'x') return 0;
  const desired = key === 'e' ? KEYBOARD_SPIN : key === 'q' ? -KEYBOARD_SPIN : undefined;
  return desired === undefined ? current : current === desired ? 0 : desired;
}
export function isEditableTarget(target: EventTarget | null) {
  return !!(target as Element | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}
export function numericInput(value: string): number {
  return value.trim() === '' ? NaN : Number(value);
}
export function mouseButtons(buttons: number) {
  return { fire: (buttons & 1) !== 0, aimAssist: (buttons & 2) !== 0 };
}
export function pointerAim(clientX: number, clientY: number, bounds: { left: number; top: number; width: number; height: number }) {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0.5, y: 0.5 };
  const limit = (n: number) => Math.max(0, Math.min(1, n));
  return { x: limit((clientX - bounds.left) / bounds.width), y: limit(((clientY - bounds.top) / bounds.height * (RULES.height + 80) - 80) / RULES.height) };
}
