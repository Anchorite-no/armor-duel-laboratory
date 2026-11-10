import { parentPort } from 'node:worker_threads';
import { renderPixels } from './render.js';
import { performance } from 'node:perf_hooks';
parentPort.on('message', frame => {
  try {
    const started = performance.now();
    const { data } = renderPixels(frame.scene, frame.status, frame.countdownMs);
    parentPort.postMessage({ data, renderMs: performance.now() - started }, [data.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
