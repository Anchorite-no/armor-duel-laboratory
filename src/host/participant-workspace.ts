import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTEBOOK_BYTES = 30_000;
export const BOT_CHARS = 64_000;
export const participantFiles = ['notebook.md','bot.js'] as const;
type ParticipantFile = typeof participantFiles[number];
const source = import.meta.url.replaceAll('\\','/').includes('/src/host/');
export const defaultParticipantsDirectory = fileURLToPath(new URL(source?'../../.local/participants/':'../.local/participants/',import.meta.url));
const invalid = () => Error('Participant request failed.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code==='ENOENT';
const exists = (error: unknown) => (error as NodeJS.ErrnoException).code==='EEXIST';
export class NotebookSizeError extends Error {
  constructor() {super(`笔记超过 ${NOTEBOOK_BYTES} 个 UTF-8 字节，原内容未修改。`);}
}

export function validateModelId(input: unknown): string {
  if (typeof input!=='string' || !/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(input) || input.includes('..') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(input)) throw Error('Invalid participant model ID');
  return input;
}

function validateFile(input: unknown): ParticipantFile {
  if (input!=='notebook.md' && input!=='bot.js') throw invalid();
  return input;
}
const byteLimit = (file: ParticipantFile) => file==='notebook.md'?NOTEBOOK_BYTES:BOT_CHARS*3;
function encode(file: ParticipantFile, content: unknown) {
  if (typeof content!=='string') throw invalid();
  if (Buffer.byteLength(content,'utf8')>byteLimit(file)) {
    if (file==='notebook.md') throw new NotebookSizeError();
    throw invalid();
  }
  if (file==='bot.js' && content.length>BOT_CHARS) throw invalid();
  const bytes=Buffer.from(content,'utf8');
  if (bytes.toString('utf8')!==content) throw invalid();
  return bytes;
}

async function ensureDirectory(directory: string, parent?:string) {
  try {await mkdir(directory,{recursive:parent===undefined});}
  catch (error) {if(!exists(error))throw error;}
  const state=await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) throw invalid();
  const actual=await realpath(directory);
  if (parent && path.relative(path.join(parent,path.basename(directory)),actual)!=='') throw invalid();
  return actual;
}

async function regularFile(filename: string) {
  const state=await lstat(filename,{bigint:true}).catch(error=>{if(missing(error))return null;throw error;});
  if (state && (!state.isFile() || state.isSymbolicLink() || state.nlink!==1n)) throw invalid();
  return state;
}

export class ParticipantWorkspace {
  readonly #root: string;
  readonly #model: string;

  constructor(root:string, model:unknown) {
    this.#root=path.resolve(root);
    this.#model=validateModelId(model);
  }

  private async directory() {
    const parent=await ensureDirectory(path.dirname(this.#root));
    const root=await ensureDirectory(this.#root,parent);
    const directory=await ensureDirectory(path.join(root,this.#model),root);
    const notebook=path.join(directory,'notebook.md');
    if (!await regularFile(notebook)) {
      try {const file=await open(notebook,'wx');await file.close();}
      catch(error) {if(!exists(error))throw error;await regularFile(notebook);}
    }
    return directory;
  }

  async read(input: unknown) {
    const file=validateFile(input),directory=await this.directory(),filename=path.join(directory,file);
    const state=await regularFile(filename);
    if (!state) return {file,content:null};
    const limit=byteLimit(file);
    if (state.size>BigInt(limit)) throw invalid();
    const handle=await open(filename,constants.O_RDONLY | (constants.O_NOFOLLOW??0));
    try {
      const opened=await handle.stat({bigint:true});
      if (!opened.isFile() || opened.nlink!==1n || opened.dev!==state.dev || opened.ino!==state.ino ||
          path.relative(filename,await realpath(filename))!=='') throw invalid();
      const bytes=Buffer.alloc(limit+1);
      let length=0;
      while (length<bytes.length) {
        const {bytesRead}=await handle.read(bytes,length,bytes.length-length,length);
        if (!bytesRead) break;
        length+=bytesRead;
      }
      if(length>limit) throw invalid();
      const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length));
      encode(file,content);
      return {file,content};
    } finally {await handle.close();}
  }

  async write(input: unknown, content: unknown) {
    const file=validateFile(input),bytes=encode(file,content);
    await this.publish(file,bytes,false);
    return {file,bytes:bytes.length};
  }

  async importBotIfMissing(content: string) {
    return this.publish('bot.js',encode('bot.js',content),true);
  }

  private async publish(file:ParticipantFile, bytes:Buffer, exclusive:boolean) {
    const directory=await this.directory(),filename=path.join(directory,file);
    const present=await regularFile(filename);
    if (exclusive && present) return false;
    const temporary=path.join(directory,`.${file}.${randomUUID()}.tmp`);
    const handle=await open(temporary,'wx');
    try {
      try {await handle.writeFile(bytes);} finally {await handle.close();}
      // The model has no filesystem access. Recheck paths before publishing.
      if(path.relative(directory,await this.directory())!=='') throw invalid();
      if (exclusive) {
        try {await copyFile(temporary,filename,constants.COPYFILE_EXCL);}
        catch(error) {if(exists(error)){await regularFile(filename);return false;}throw error;}
      } else {
        await regularFile(filename);
        await rename(temporary,filename);
      }
      return true;
    } finally {await unlink(temporary).catch(()=>{});}
  }
}
