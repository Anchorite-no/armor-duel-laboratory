import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {test} from 'node:test';
import {ParticipantWorkspace,validateModelId} from '../src/host/participant-workspace.js';

const testRoot=path.resolve('.local');
const sandbox=async()=>{
  await mkdir(testRoot,{recursive:true});
  return mkdtemp(path.join(testRoot,'participant-test-'));
};
const removeSandbox=async(dir:string)=>{
  assert.equal(path.dirname(dir),testRoot);
  assert.ok(path.basename(dir).startsWith('participant-test-'));
  await rm(dir,{recursive:true,force:true});
};

test('workspace accepts only owner IDs and fixed file names, and import never overwrites',async()=>{
  for (const id of ['../sample','sample/other','sample\\other','SAMPLE','con','con.model','lpt9.model','a:stream','-a','a-','.a','a.','a..b','a\n']) {
    assert.throws(()=>validateModelId(id),/Invalid participant model ID/);
  }
  const dir=await sandbox();
  try {
    const root=path.join(dir,'participants');
    const modelId='example-1.2-model';
    const valid=new ParticipantWorkspace(root,modelId);
    assert.deepEqual(await valid.read('notebook.md'),{file:'notebook.md',content:''});
    assert.deepEqual(await readdir(root),[modelId]);
    assert.equal(await valid.importBotIfMissing('first'),true);
    assert.equal(await valid.importBotIfMissing('replacement'),false);
    assert.equal((await valid.read('bot.js')).content,'first');
    await assert.rejects(valid.read('../escape/bot.js'));
    await assert.rejects(valid.write('bot.js::$DATA','no'));
  } finally {await removeSandbox(dir);}
});

test('workspace rejects junctions and hard links without touching their target', {
  skip:process.env.LAB_TEST_LINKS!=='1'?'Link fixtures require OS permission':false,
},async()=>{
  const dir=await sandbox(),root=path.join(dir,'participants'),outside=path.join(dir,'outside');
  try {
    await mkdir(root);await mkdir(outside);
    const secret=path.join(outside,'bot.js');
    await writeFile(secret,'private');
    await symlink(outside,path.join(root,'escape'),'junction');
    const escape=new ParticipantWorkspace(root,'escape');
    await assert.rejects(escape.read('bot.js'));
    await assert.rejects(escape.write('bot.js','no'));
    const valid=new ParticipantWorkspace(root,'safe');
    await valid.read('notebook.md');
    await link(secret,path.join(root,'safe','bot.js'));
    await assert.rejects(valid.read('bot.js'));
    await assert.rejects(valid.write('bot.js','no'));
    assert.equal(await readFile(secret,'utf8'),'private');
    const outsideRoot=path.join(dir,'linked-root');
    await symlink(outside,outsideRoot,'junction');
    await assert.rejects(new ParticipantWorkspace(outsideRoot,'safe').read('notebook.md'));
    assert.deepEqual(await readdir(outside),['bot.js']);
  } finally {await removeSandbox(dir);}
});

function connect(dir:string,id:string,effort:string) {
  const child=spawn(process.execPath,['--import','tsx','src/host/contest-mcp.ts',`--model-id=${id}`,`--reasoning-effort-label=${effort}`],{
    windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,
      LAB_CONTEST_DIRECTORY:path.join(dir,'contests'),LAB_PARTICIPANT_DIRECTORY:path.join(dir,'participants')},
  });
  const closed=once(child,'close'),lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let sequence=0;
  async function send(method:string,params?:object) {
    const id=++sequence;
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    const {value}=await lines.next(),reply=JSON.parse(value!);
    assert.equal(reply.id,id);
    return reply.result;
  }
  return {send,async call(name:string,args:object={}) {
    const result=await send('tools/call',{name,arguments:args});
    return result.isError?result.content[0].text:JSON.parse(result.content[0].text);
  },async close(){child.stdin.end();assert.equal((await closed)[0],0);}};
}

test('MCP files persist across connections, stay model-scoped and never open a match', {timeout:15000},async()=>{
  const dir=await sandbox(),participants=path.join(dir,'participants');
  const clients:ReturnType<typeof connect>[]=[];
  const start=async(id:string,effort:string)=>{
    const client=connect(dir,id,effort);
    clients.push(client);
    await client.send('initialize',{protocolVersion:'2025-06-18'});
    return client;
  };
  try {
    const a=await start('model-a','xhigh'),b=await start('model-b','high');
    const notebook={file:'notebook.md'},bot={file:'bot.js'};
    const tools=(await a.send('tools/list')).tools;
    assert.deepEqual(tools.find((tool:{name:string})=>tool.name==='lab_workspace_read').inputSchema.properties.file.enum,['notebook.md','bot.js']);
    assert.deepEqual(await a.call('lab_workspace_read',notebook),{...notebook,content:''});
    assert.deepEqual(await a.call('lab_workspace_read',bot),{...bot,content:null});
    assert.equal(await a.call('lab_run_script',{}),'Participant request failed.');
    const content='笔'.repeat(10_000);
    assert.deepEqual(await a.call('lab_workspace_write',{...notebook,content}),{...notebook,bytes:30_000});
    assert.match(await a.call('lab_workspace_write',{...notebook,content:content+'记'}),/30,?000|30000/);
    assert.deepEqual(await a.call('lab_workspace_read',notebook),{...notebook,content});
    const code='await lab.log("saved");';
    assert.deepEqual(await a.call('lab_workspace_write',{...bot,content:code}),{...bot,bytes:Buffer.byteLength(code)});
    assert.equal(await a.call('lab_workspace_write',{...bot,content:'x'.repeat(64_001)}),'Participant request failed.');
    assert.deepEqual(await b.call('lab_workspace_read',notebook),{...notebook,content:''});
    assert.equal(await b.call('lab_workspace_read',{file:'../model-a/notebook.md'}),'Participant request failed.');
    assert.equal(await b.call('lab_workspace_read',{...bot,modelId:'model-a'}),'Participant request failed.');
    await a.close();clients.shift();
    const resumed=await start('model-a','low');
    assert.deepEqual(await resumed.call('lab_workspace_read',notebook),{...notebook,content});
    assert.deepEqual(await resumed.call('lab_workspace_read',bot),{...bot,content:code});
    assert.deepEqual(await resumed.call('lab_recordings'),{recordings:[],saving:false});
    assert.deepEqual((await readdir(path.join(participants,'model-a'))).sort(),['bot.js','notebook.md']);
    assert.deepEqual(await readdir(dir),['participants']);
  } finally {
    try {await Promise.all(clients.map(client=>client.close()));}
    finally {await removeSandbox(dir);}
  }
});
