// Shared desktop/web carrier: exact owner-only routes inside DSH's /api channel.
export const LAB_CHANNEL = '/api';
export const LAB_ENDPOINT_PREFIX = 'laboratory.';
export const LAB_METHODS = ['view', 'display', 'start', 'input', 'release', 'pause', 'resume', 'stop', 'program', 'stopProgram', 'record', 'replayFrame', 'saveScript', 'scriptSource','configureVision','recordingOpen'] as const;
export function laboratoryEndpoint(method: string): string {
  if (!(LAB_METHODS as readonly string[]).includes(method)) throw new Error('未知实验室请求');
  return LAB_ENDPOINT_PREFIX + method;
}
