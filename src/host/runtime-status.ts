// Local operator evidence only. Never exposed through participant tools.
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BUILD_ID } from '../shared/build.js';
import { RULES } from '../shared/protocol.js';
export function runtimeReporter(moduleUrl: string) {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  const startedAt = new Date().toISOString();
  const output = ['bundle', 'dist'].includes(path.basename(directory)) ? path.join(directory, '../.local/runtime-status', `${process.pid}-${BUILD_ID}-${process.hrtime.bigint()}.json`) : undefined;
  let queue = Promise.resolve();
  return (phase: 'registered' | 'stopped') => {
    if (!output) return Promise.resolve();
    const record = { version: RULES.version, buildId: BUILD_ID, pid: process.pid, executable: path.basename(process.execPath), moduleUrl, startedAt, reportedAt: new Date().toISOString(), phase };
    queue = queue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(output), { recursive: true });
      const temporary = output + '.tmp'; await writeFile(temporary, JSON.stringify(record, null, 2)); await rename(temporary, output);
    });
    return queue;
  };
}
