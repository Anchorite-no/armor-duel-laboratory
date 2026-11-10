import { LAB_CHANNEL, laboratoryEndpoint } from '../shared/transport.js';
import type { Api } from './types.js';
import { BUILD_ID } from '../shared/build.js';
export interface ClientConnection {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }> };
}
export function createLaboratoryApi(connection: ClientConnection): Api {
  return async (method, payload = {}, signal) => {
    let result;
    try { result = await connection.rpc.call(LAB_CHANNEL, laboratoryEndpoint(method), payload, signal ?? AbortSignal.timeout(10000)); }
    catch (e) {
      if (e instanceof Error && /HTTP 404\b/.test(e.message)) throw new Error(`游戏宿主尚未提供新版接口（HTTP 404，页面构建 ${BUILD_ID}）。DSH 关闭窗口会驻留后台；请从托盘菜单“退出”后重新打开，加载新版宿主。`);
      throw e;
    }
    if (!result.ok) throw new Error(result.error?.message ?? '游戏宿主请求失败');
    if (method === 'view' || method === 'display') {
      const runtime = (result.value as { runtime?: { buildId?: string } })?.runtime;
      if (runtime?.buildId !== BUILD_ID) throw new Error(`页面与宿主构建不一致（页面 ${BUILD_ID}，宿主 ${runtime?.buildId ?? '旧版本'}）。请从 DSH 托盘菜单“退出”后重新打开。`);
    }
    return result.value;
  };
}
