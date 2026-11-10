import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ScriptLibrary } from '../src/host/library.js';

const [filename, name, ...extra] = process.argv.slice(2);
if (!filename || !name || extra.length) {
  console.error('用法：node --import tsx scripts/import-bot.ts <bot.js> <脚本名称>');
  process.exitCode = 1;
} else {
  try {
    const code = await readFile(filename, 'utf8');
    const library = new ScriptLibrary(fileURLToPath(new URL('../.local/scripts.json', import.meta.url)));
    const saved = await library.save(name, code);
    console.log(`已导入「${saved.name}」。在 DSH 的实验室房间选择该脚本。`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
