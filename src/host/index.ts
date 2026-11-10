import { Laboratory } from './service.js';
import { RULES } from '../shared/protocol.js';
import { registerLaboratoryRoutes, type LaboratoryConnection } from './transport.js';
import { runtimeReporter } from './runtime-status.js';
// Structural host contract: runtime API checked against installed 0.2.2-rc.1 sources.
interface Context {
  effect(fn: () => (() => void | Promise<void>)): unknown;
  connection: LaboratoryConnection;
  inject(dependencies: string[], callback: (ctx: ToolContext) => void): unknown;
}
interface ToolContext {
  tools: { register(tool: unknown): unknown };
  attachments: { saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<unknown> };
}
export const name = 'laboratory';
// Playing must not wait for an Agent registry or a model image attachment store.
export const inject = ['connection'];
export function apply(ctx: Context) {
  const lab = new Laboratory(); lab.startClock();
  const report = runtimeReporter(import.meta.url);
  ctx.effect(() => async () => { await lab.dispose(); await report('stopped').catch(() => {}); });
  registerLaboratoryRoutes(ctx.connection, (method, payload, signal) => lab.admin(method, payload, signal));
  void report('registered').catch(error => console.warn('Laboratory runtime status:', error instanceof Error ? error.message : String(error)));
  ctx.inject(['tools', 'attachments'], toolCtx => registerParticipantTools(toolCtx, lab));
}
function registerParticipantTools(ctx: ToolContext, lab: Laboratory) {
  // tools.register consumes compiled JSON Schema, not the defineTool author DSL.
  const side = { type: 'string', enum: ['blue', 'red'], description: '页面分配给 Agent 的席位' };
  const noParameters = { type: 'object', properties: {}, additionalProperties: false };
  const sideParameters = { type: 'object', properties: { side }, required: ['side'], additionalProperties: false };
  const output = {
    schema: {},
    render: (_args: unknown, value: unknown) => {
      const v = value as {frameId?:number; image?: { base64: string; mimeType: string }; attachment?: unknown };
      if (!v.image) return [{type:'text',text:(value as {cancelled?:boolean})?.cancelled===true?'{\"cancelled\":true}':'参赛接口未返回图像'}];
      return [{type:'text',text:JSON.stringify({frameId:v.frameId})},{type:'image',attachment:v.attachment}];
    },
  };
  const participant = async (method: string, args: unknown, signal: AbortSignal) => {
    try {
    const value = await lab.participant(method, args, 'agent', signal);
    const v = value as {frameId:number; image?: { base64: string; mimeType: string } };
    if (!v.image || v.image.mimeType!=='image/jpeg' || !Number.isSafeInteger(v.frameId)) throw Error('参赛观察格式无效');
    signal.throwIfAborted();
    const attachment = await ctx.attachments.saveImage({ data: Buffer.from(v.image.base64, 'base64'), mediaType: v.image.mimeType, name: 'laboratory.jpg' });
    signal.throwIfAborted();
    return {frameId:v.frameId,image:v.image,attachment};
    } catch { throw new Error('Participant request failed.'); }
  };
  ctx.tools.register({ name: 'lab_observe', description: `获取完整 JPG 画面与传输序号。`, parameters: noParameters, output, execute: (_a: unknown, exec: { signal: AbortSignal }) => participant('observe', {}, exec.signal) });
  ctx.tools.register({
    name: 'lab_act', description: `提交移动、旋转和瞄准动作，返回完整 JPG 与传输序号。moveX、moveY、spin 取 [-1,1]。aimX、aimY 取 [0,1]，按不含顶部 HUD 的场地归一化。durationMs 取 [1,${RULES.maxActionMs}] 内的整数，单位毫秒。`,
    parameters: { type: 'object', required: ['side', 'action'], additionalProperties: false, properties: { side, action: { type: 'object', additionalProperties: false, required: ['moveX', 'moveY', 'spin', 'aimX', 'aimY', 'durationMs'], properties: {
      moveX: { type: 'number', description: '数值，[-1,1]' }, moveY: { type: 'number', description: '数值，[-1,1]' }, spin: { type: 'number', description: '数值，[-1,1]' }, aimX: { type: 'number', description: '数值，[0,1]' }, aimY: { type: 'number', description: '数值，[0,1]' }, durationMs: { type: 'integer', description: `1..${RULES.maxActionMs} 毫秒` },
    } } } }, output,
    execute: (a: unknown, exec: { signal: AbortSignal }) => participant('act', a, exec.signal),
  });
  ctx.tools.register({ name: 'lab_fire', description: '请求单发，每次最多发一颗。冷却中的请求直接丢弃。当前移动与瞄准保持生效。返回完整 JPG 与传输序号。', parameters: sideParameters, output, execute: (a: unknown, exec: { signal: AbortSignal }) => participant('fire', a, exec.signal) });
  ctx.tools.register({ name: 'lab_cancel', description: '撤销本席位动作，返回静态确认。', parameters: sideParameters, output, execute: (a: unknown, exec: { signal: AbortSignal }) => lab.participant('cancel', a, 'agent', exec.signal) });
}
