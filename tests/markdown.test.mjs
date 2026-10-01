import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {renderMessageBody} from '../static/markdown.mjs';

const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1:8769/'}),doc=dom.window.document;
const message=text=>{const el=doc.createElement('div');el.className='body';doc.body.replaceChildren(el);renderMessageBody(el,text);return el;};

test('rich Markdown headings, nested lists, emphasis, quote and readonly tasks',()=>{
  const el=message('# 标题\n\n**粗体** *斜体* ~~删除~~ `inline`\n\n> 引用\n\n1. 第一项\n   - 子项\n\n- [x] 完成\n- [ ] 等待\n\n---');
  assert.equal(el.querySelector('h1').textContent,'标题');assert.equal(el.querySelector('strong').textContent,'粗体');assert.ok(el.querySelector('em'));assert.ok(el.querySelector('del'));assert.ok(el.querySelector('blockquote'));assert.ok(el.querySelector('ol ul'));assert.ok(el.querySelector('hr'));
  assert.equal(el.querySelectorAll('input[disabled]').length,2);
});
test('GFM tables keep alignments in their own scroll region',()=>{
  const el=message('| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| **好** | [网站](https://example.com/) | `code` |');
  assert.equal(el.querySelectorAll('th').length,3);assert.ok(el.querySelector('th.align-right'));assert.ok(el.querySelector('.table-scroll[tabindex="0"] strong'));assert.ok(el.querySelector('.table-scroll a'));
});
test('safe links open separately; local files offer the original path',()=>{
  const el=message('[官网](https://example.com/?a=1&b=2) [邮件](mailto:test@example.com) [危险](javascript:alert%281%29) [电脑文件](<C:/Users/steve/My Project/main.py:12>)');
  assert.equal(el.querySelectorAll('a').length,2);assert.equal(el.querySelector('a').getAttribute('rel'),'noopener noreferrer');assert.equal(el.querySelector('a').target,'_blank');assert.equal(el.querySelector('a').href,'https://example.com/?a=1&b=2');
  assert.equal(el.querySelector('.local-file').dataset.filePath,'C:/Users/steve/My Project/main.py:12');assert.equal(el.querySelector('.local-file button').textContent,'复制路径');
});
test('HTML and unsafe URL protocols cannot execute; explicit HTTPS images render',()=>{
  const el=message('<script>alert(1)</script>\n\n<img src="https://remote.invalid/a" onerror="alert(1)">\n\n[危险](data:text/html,test) [坏](vbscript:alert) ![外图](https://example.com/image.png)');
  assert.equal(el.querySelectorAll('script,iframe,object,style').length,0);assert.match(el.textContent,/<script>/);assert.equal(el.querySelectorAll('img').length,1);assert.equal(el.querySelector('img').src,'https://example.com/image.png');assert.equal(el.querySelector('img').referrerPolicy,'no-referrer');assert.equal(el.querySelectorAll('[onerror]').length,0);
});
test('highlighted code is literal, preserves whitespace and copies raw content',async()=>{
  const source='const value = "**bold** $x$ <img>";\n  console.log(value);';
  const el=message('```javascript\n'+source+'\n```');assert.ok(el.querySelector('.hljs-keyword'));assert.equal(el.querySelector('code').textContent,source);assert.equal(el.querySelectorAll('.katex,img,strong').length,0);
  let copied;Object.defineProperty(dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied=text;}}});
  el.querySelector('button').click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(copied,source);assert.equal(el.querySelector('button').textContent,'已复制');
});
test('unknown or long code stays literal rather than guessed or executed',()=>{
  const source='<script>noop()</script>\n'+'x'.repeat(31000);const el=message('```unknown-lang\n'+source+'\n```');assert.equal(el.querySelector('code').textContent,source);assert.equal(el.querySelectorAll('script,.hljs-keyword').length,0);
});
test('clipboard denial leaves a selectable original file path and useful hint',async()=>{
  const el=message('[文件](C:/Users/steve/main.py)');Object.defineProperty(dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Denied');}}});
  el.querySelector('button').click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(el.querySelector('.copy-fallback').textContent,'C:/Users/steve/main.py');assert.equal(el.querySelector('button').textContent,'请长按选择复制');assert.equal(dom.window.getSelection().toString(),'C:/Users/steve/main.py');
});
test('inline and display formulas retain accessible MathML and local CSS layout',()=>{
  const el=message('公式 $x^2$ 与 \\( \\frac{a}{b} \\)\n\n\\[\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n\\]\n\n$$\n\\sqrt{x+1}\n$$');
  assert.equal(el.querySelectorAll('.katex').length,4);assert.equal(el.querySelectorAll('math').length,4);assert.equal(el.querySelectorAll('math semantics annotation').length,4);assert.equal(el.querySelectorAll('.math-display').length,2);assert.equal(el.querySelectorAll('[data-math-style]').length,0);assert.ok(el.querySelector('.katex [style]'));
});
test('currency, escaped dollar signs, code and incomplete formula stay literal',()=>{
  const text='价格 $20 和 $40；\\$x$。`$x$`\n\n```tex\n\\[x\\]\n```\n\n尚未完成 \\(\\frac{x}{';const el=message(text);assert.equal(el.querySelectorAll('.katex').length,0,el.innerHTML);assert.match(el.textContent,/\$20 和 \$40/);assert.match(el.textContent,/\\frac\{x\}\{/);
});
test('unsupported or oversized formulas fall back without hiding the reply',()=>{
  const el=message('前文 \\(\\notACommand{x}\\) 后文\n\n$$'+ 'x'.repeat(6001)+'$$');assert.equal(el.querySelectorAll('.math-fallback').length,2);assert.match(el.textContent,/前文/);assert.match(el.textContent,/后文/);
});
test('untrusted math commands do not make links or fetch graphics',()=>{
  const el=message('\\(\\href{javascript:alert(1)}{click}\\)\n\n\\(\\includegraphics{https://remote.invalid/x}\\)');assert.equal(el.querySelectorAll('a,img').length,0);
});
test('all streaming split points end at the same final rendering',()=>{
  const text='**粗体**\n\n| A | B |\n|---|---|\n| x | y |\n\n```js\nconst x = 1;\n```\n\n\\[\\frac{x}{y}\\]\n';const el=message('');
  for(let i=1;i<=text.length;i++)assert.doesNotThrow(()=>renderMessageBody(el,text.slice(0,i)));
  const final=el.innerHTML;doc.body.replaceChildren(el);assert.equal(renderMessageBody(el,text),false);const fresh=doc.createElement('div');renderMessageBody(fresh,text);assert.equal(fresh.innerHTML,final);
});
test('unchanged snapshots preserve DOM and user messages stay plain',()=>{
  const el=message('**原文**');const bold=el.firstChild;assert.equal(renderMessageBody(el,'**原文**'),false);assert.equal(el.firstChild,bold);
  renderMessageBody(el,'**原文** <img>',{rich:false});assert.equal(el.textContent,'**原文** <img>');assert.equal(el.querySelectorAll('strong,img').length,0);assert.equal(el.classList.contains('markdown'),false);
});
test('stream updates preserve horizontal scroll positions and selected text',()=>{
  const el=message('先读这一段\n\n```text\nlong line\n```');const code=el.querySelector('pre');code.scrollLeft=120;
  const range=doc.createRange();const text=el.querySelector('p').firstChild;range.setStart(text,1);range.setEnd(text,4);dom.window.getSelection().removeAllRanges();dom.window.getSelection().addRange(range);
  renderMessageBody(el,'先读这一段\n\n```text\nlong line plus\n```\n\n新内容');assert.equal(el.querySelector('pre').scrollLeft,120);assert.equal(dom.window.getSelection().toString(),'读这一');
});
test('renderer failures fall back to visible plain source',()=>{
  const el=message('旧文本');const original=el.replaceChildren;el.replaceChildren=()=>{throw new Error('DOM failed');};renderMessageBody(el,'**保留原文**');el.replaceChildren=original;assert.equal(el.textContent,'**保留原文**');assert.equal(el.classList.contains('markdown'),false);
});
test('HTML includes local assets and version while server CSP stays restrictive',async()=>{
  const html=await readFile(new URL('../static/index.html',import.meta.url),'utf8'),server=await readFile(new URL('../app.py',import.meta.url),'utf8');assert.match(html,/markdown.css\?v=\d+\.\d+\.\d+/);assert.match(html,/v\d+\.\d+\.\d+ · 支持全屏状态栏/);assert.match(html,/<meta name="viewport" content="[^"]*viewport-fit=cover">/);assert.match(html,/<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);assert.doesNotMatch(html,/(?:src|href)="https?:/);assert.match(server,/script-src 'self'; style-src 'self';/);assert.doesNotMatch(server,/unsafe-inline|unsafe-eval/);
});
test('all shipped vendor modules match their manifest and local formula fonts exist',async()=>{
  const base=new URL('../static/vendor/',import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
  for(const [file,hash] of Object.entries(manifest.assets))assert.equal(createHash('sha256').update(await readFile(new URL(file,base))).digest('hex'),hash,file);
  const css=await readFile(new URL('katex/katex.min.css',base),'utf8');for(const match of css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g))assert.ok((await readFile(new URL('katex/'+match[1],base))).length>0);
});
