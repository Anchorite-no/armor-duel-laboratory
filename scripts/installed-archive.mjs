// Read-only inspection of the locally installed DSH; never changes the installation.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const archive = [process.env.DSH_ASAR, `${process.env.LOCALAPPDATA}/Programs/DeepSeek Harness/resources/app.asar`, path.join(os.homedir(), 'AppData/Local/Programs/DeepSeek Harness/resources/app.asar')].find(p => p && fs.existsSync(p));
if (!archive) throw new Error('未找到本机 DSH app.asar，请设置 DSH_ASAR');
const fd = fs.openSync(archive, 'r');
const prefix = Buffer.alloc(16);
fs.readSync(fd, prefix, 0, 16, 0);
const header = Buffer.alloc(prefix.readUInt32LE(12));
fs.readSync(fd, header, 0, header.length, 16);
const tree = JSON.parse(header.toString());
const base = 8 + prefix.readUInt32LE(4);
export function read(entry) {
  let node = tree;
  for (const key of entry.split('/').filter(Boolean)) node = node.files?.[key];
  if (!node || node.files) throw new Error(`Not an archive file: ${entry}`);
  if (node.unpacked) return fs.readFileSync(path.join(`${archive}.unpacked`, entry), 'utf8');
  const buffer = Buffer.alloc(Number(node.size));
  fs.readSync(fd, buffer, 0, buffer.length, base + Number(node.offset));
  return buffer.toString();
}
export function list(entry) {
  let node = tree;
  for (const key of entry.split('/').filter(Boolean)) node = node.files?.[key];
  return Object.keys(node?.files ?? {});
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  for (const entry of process.argv.slice(2)) {
    console.log(`\n${entry}\n`);
    console.log(entry.endsWith('/') ? list(entry) : read(entry));
  }
}
