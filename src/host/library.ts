import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RULES, type ScriptChoice } from '../shared/protocol.js';
import { COMPUTER, TRADITIONAL_POLICY } from './opponent.js';
import { PRIVILEGED_AI } from '../shared/privileged-ai.js';
interface StoredScript { id: string; name: string; code: string }
export interface SelectedScript extends ScriptChoice { code?: string }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function checkSyntax(code: string) {
  try { new (Object.getPrototypeOf(async function() {}).constructor)('lab', '"use strict";\n' + code); }
  catch (e) { throw new Error('脚本语法错误：' + (e as Error).message); }
}
const builtins: SelectedScript[] = [
  { ...PRIVILEGED_AI, description: '读取双方当前状态，分别配置移动、旋转与射击。',kind:'builtin',controller:'privileged',hash:hash(PRIVILEGED_AI.implementation+':'+RULES.version) },
  { id: 'builtin:computer', ...COMPUTER, description: '特权读取双方机器人完整当前状态；固定策略与有界随机走位、旋转防御和装甲提前量射击，非语言模型。', kind: 'builtin', controller: 'computer', hash: hash(COMPUTER.implementation + ':' + JSON.stringify(TRADITIONAL_POLICY) + ':' + RULES.version) },
  { id: 'builtin:spinner', name: '原地旋转靶', description: '固定档位原地旋转，不移动、不射击。', kind: 'builtin', controller: 'spinner', hash: hash('spinner:' + RULES.version) },
  { id: 'builtin:fixed', name: '固定方向射手', description: '向场地中央固定方向射击，不跟踪目标。', kind: 'builtin', controller: 'fixed', hash: hash('fixed:' + RULES.version) },
];
export class ScriptLibrary {
  #entries: StoredScript[] = [];
  #loaded?: Promise<void>;
  constructor(readonly filename: string) {}
  async #load() {
    this.#loaded ??= (async () => {
      let text: string;
      try { text = await readFile(this.filename, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      if (text.length > 2_000_000) throw new Error('脚本库文件超过大小限制');
      const data = JSON.parse(text) as { version: number; scripts: StoredScript[] };
      if (data.version !== 1 || !Array.isArray(data.scripts)) throw new Error('脚本库格式无效');
      for (const s of data.scripts) if (typeof s.id !== 'string' || !s.id.startsWith('custom:') || typeof s.name !== 'string' || !s.name.trim() || typeof s.code !== 'string' || s.code.length > 64000) throw new Error('脚本库含无效条目');
      this.#entries = data.scripts;
    })();
    await this.#loaded;
  }
  async list(): Promise<ScriptChoice[]> {
    await this.#load();
    return [{...builtins[0]}, ...this.#entries.map(s => ({ id: s.id, name: s.name, description: '本机保存的图像闭环 JavaScript', kind: 'custom' as const, controller: 'script' as const, hash: hash(s.code) }))];
  }
  async get(id: unknown): Promise<SelectedScript> {
    if (typeof id !== 'string') throw new Error('脚本标识无效');
    await this.#load();
    const builtin = builtins.find(s => s.id === id); if (builtin) return { ...builtin };
    const s = this.#entries.find(s => s.id === id); if (!s) throw new Error('所选脚本不存在');
    checkSyntax(s.code);
    return { ...s, description: '本机保存的图像闭环 JavaScript', kind: 'custom', controller: 'script', hash: hash(s.code) };
  }
  async save(name: unknown, code: unknown, id?: unknown) {
    await this.#load();
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) throw new Error('脚本名称须为 1..40 个字符');
    if (typeof code !== 'string' || !code.trim() || code.length > 64000) throw new Error('脚本源码须为 1..64000 个字符');
    checkSyntax(code);
    if (id !== undefined && (typeof id !== 'string' || !this.#entries.some(s => s.id === id))) throw new Error('只能更新已有的自定义脚本');
    if ([...builtins, ...this.#entries.filter(s => s.id !== id)].some(s => s.name.toLowerCase() === name.trim().toLowerCase())) throw new Error('脚本名称已存在，请使用不同名称');
    const entry = { id: id as string ?? `custom:${randomUUID()}`, name: name.trim(), code };
    const entries = this.#entries.filter(s => s.id !== entry.id); entries.push(entry);
    if (entries.length > 30) throw new Error('本地脚本库最多保存 30 个脚本');
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = this.filename + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify({ version: 1, scripts: entries })); await rename(temporary, this.filename);
    this.#entries = entries; return this.get(entry.id);
  }
}
