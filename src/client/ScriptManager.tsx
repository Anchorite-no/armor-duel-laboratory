import React, { useState } from 'react';
import type { Api, View } from './types.js';
const example = `// 接口示例：获取 JPG 并解码像素。
while (true) {
  const observation = await lab.observe();
  const pixels = lab.pixels(observation); // 仅 JPEG 解码后的 RGB
  await lab.log({frameId:observation.frameId,width:pixels.width,height:pixels.height});
  await lab.sleep(100);
}`;
export function ScriptManager({ view, api, changed }: { view?: View; api: Api; changed?(view:View):void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState(example);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const custom = view?.scripts.filter(s => s.kind === 'custom') ?? [];
  const load = async (next: string) => {
    setId(next); setError(''); setNotice('');
    if (!next) { setName(''); setCode(example); return; }
    setBusy(true);
    try { const result = await api('scriptSource', { id: next }) as { name: string; code: string }; setName(result.name); setCode(result.code); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api('saveScript', { id: id || undefined, name, code }) as View;
      const script = result.scripts.find(s => s.kind === 'custom' && s.name === name.trim()); if (script) setId(script.id);
      changed?.(result);setNotice('已保存，可在房间选择。');
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <section><label>管理自定义脚本<select disabled={busy} value={id} onChange={e => void load(e.target.value)}><option value="">新建脚本</option>{custom.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>脚本名称<input aria-label="脚本名称" maxLength={40} disabled={busy} value={name} onChange={e => setName(e.target.value)}/></label><textarea aria-label="脚本源码" spellCheck={false} disabled={busy} value={code} onChange={e => setCode(e.target.value)}/><div className="game-row"><button className="game-primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存到脚本库'}</button><button disabled={busy} onClick={() => void load('')}>新建</button></div>{notice && <p role="status">{notice}</p>}{error && <p className="game-error" role="alert">{error}</p>}<details><summary>图像脚本接口</summary><p><code>lab.observe()</code> 获取公开画面与 HUD；<code>lab.pixels(observation)</code> 仅解码 RGB；<code>lab.act(action)</code> 提交统一约束下的动作并返回画面；<code>lab.cancel()</code> 取消本席位动作。</p></details>{(view?.programs.red.output||view?.programs.blue.output)&&<details><summary>脚本输出</summary><pre>{view?.programs.red.output||view?.programs.blue.output}</pre></details>}</section>;
}
