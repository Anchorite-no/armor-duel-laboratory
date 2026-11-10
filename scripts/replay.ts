import { readFile } from 'node:fs/promises';
import { replay } from '../src/host/replay.js';
const filename = process.argv[2];
if (!filename) throw new Error('用法：npm run replay -- <裁判记录.json>');
const record = JSON.parse(await readFile(filename, 'utf8'));
const result = replay(record);
console.log(JSON.stringify({ identical: result.identical, tick: result.actual.finalTick, hits: result.actual.events.filter(e => e.type === 'hit').length, winner: result.actual.finalState.winner }, null, 2));
if (!result.identical) process.exitCode = 1;
