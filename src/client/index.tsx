import React from 'react';
import styles from './style.css';
import { LaboratoryPage } from './GamePage.js';
import { createLaboratoryApi, type ClientConnection } from './transport.js';
export { LaboratoryPage } from './GamePage.js';
interface ClientContext {
  connection: ClientConnection;
  effect(fn: () => () => void): unknown;
  slots: { inject(slot: string, fn: () => unknown): unknown; register(config: Record<string, unknown>, component: React.ComponentType<any>): unknown };
}
export const inject = ['connection', 'slots', 'layout'];
export function apply(ctx: ClientContext) {
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = styles; document.head.append(style); return () => style.remove(); });
  const api = createLaboratoryApi(ctx.connection);
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'laboratory', inject: () => ({ api }) }, LaboratoryPage));
  const Icon = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="6"/><path d="M9 3h6M9 21h6M3 9v6M21 9v6M12 12l6-6"/></svg>;
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'laboratory', order: 30, label: () => '实验室' }, Icon));
}
