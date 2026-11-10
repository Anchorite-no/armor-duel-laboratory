import { LAB_CHANNEL, LAB_METHODS, laboratoryEndpoint } from '../shared/transport.js';
export interface FetchRoute {
  path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response>;
}
export interface LaboratoryConnection { fetch: { register(route: FetchRoute): unknown } }
export function registerLaboratoryRoutes(connection: LaboratoryConnection, admin: (method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) {
  // DSH admits the authenticated owner before dispatching exact Fetch routes.
  // Do not register a second /api RPC interceptor: the existing Gateway owns it.
  for (const method of LAB_METHODS) {
    const endpoint = laboratoryEndpoint(method);
    connection.fetch.register({
      path: `${LAB_CHANNEL}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return new Response('Expected application/json', { status: 415 });
        let body: unknown;
        try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response('Invalid RPC envelope', { status: 400 });
        const message = body as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown };
        if (message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.rpcId.length > 200 || message.method !== endpoint) return new Response('Invalid RPC envelope', { status: 400 });
        try {
          const value = await admin(method, message.payload, request.signal);
          return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } });
        } catch (error) {
          return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: false, error: { code: 'laboratory/input', message: error instanceof Error ? error.message : String(error) } } });
        }
      },
    });
  }
}
