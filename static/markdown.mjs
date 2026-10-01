import {Marked,Renderer} from './vendor/marked.mjs';
import createPurifier from './vendor/purify.mjs';
import katex from './vendor/katex/katex.mjs';
import highlight from './vendor/highlight.mjs';
import {imageFigure,imageUrl} from './media.mjs';

const escape=text=>String(text).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const originalRenderer=new Renderer();
const mathStyles=new Set(['height','width','min-width','max-width','vertical-align','top','left','right','bottom','margin-left','margin-right','margin-top','margin-bottom','padding-left','padding-right','border-bottom-width','border-top-width','color','position']);

function formula(token){
  if(token.incomplete)return `<${token.display?'div':'span'} class="math-fallback">${escape(token.raw)}</${token.display?'div':'span'}>`;
  try{
    if(token.text.length>6000)throw new Error('Formula too long');
    const html=katex.renderToString(token.text,{displayMode:token.display,throwOnError:true,trust:false,strict:'ignore',maxSize:20,maxExpand:500,output:'htmlAndMathml'});
    // Apply the trusted layout through CSSOM after sanitizing. This keeps the
    // server's style-src 'self' policy: no inline style permission is added.
    const layout=html.replace(/ style="([^"]*)"/g,' data-math-style="$1"');
    return `<${token.display?'div':'span'} class="math-${token.display?'display':'inline'}">${layout}</${token.display?'div':'span'}>`;
  }catch{return `<${token.display?'div':'span'} class="math-fallback">${escape(token.raw.trimEnd())}</${token.display?'div':'span'}>`;}
}
function mathExtension(name,level){
  return {name,level,
    start(src){const index=src.search(level==='block'?/(?:^|\n)[ \t]*(?:\$\$|\\\[)/:/\$|\\\(/);return index<0?undefined:index;},
    tokenizer(src,tokens){
      const display=level==='block';let open,close,start=0;
      if(display){start=src.match(/^[ \t]*/)[0].length;if(src.startsWith('$$',start)){open='$$';close='$$';}else if(src.startsWith('\\[',start)){open='\\[';close='\\]';}else return;}
      else if(src.startsWith('\\(')){open='\\(';close='\\)';}
      else if(src[0]==='$'&&src[1]!=='$'&&!/\s/.test(src[1]||' ')&&!/[\w$]$/.test(tokens?.at(-1)?.raw||'')){open='$';close='$';}
      else return;
      let end=src.indexOf(close,start+open.length);
      while(end>=0){let slashes=0;for(let i=end-1;i>=0&&src[i]==='\\';i--)slashes++;if(slashes%2===0)break;end=src.indexOf(close,end+close.length);}
      if(end<0){if(open==='$')return;const raw=display?src:src.split('\n')[0];return {type:name,raw,text:raw,display,incomplete:true};}
      const text=src.slice(start+open.length,end);
      if(!display&&(!text||open==='$'&&(text.includes('\n')||/\s$/.test(text)||text.includes('`')||text.includes('\\$')||/^\d+(?:[,.]\d+)*$/.test(text)||/^\d/.test(text)&&!/[A-Za-z\\+*/=^_{}-]/.test(text)||/\d/.test(src[end+1]||''))))return;
      let length=end+close.length;
      if(display){const tail=src.slice(length).match(/^[ \t]*(?:\n|$)/);if(!tail)return;length+=tail[0].length;}
      return {type:name,raw:src.slice(0,length),text,display};
    },renderer:formula};
}
function localPath(href){return /^(?:[a-z]:[\\/]|\\\\|\/(?!\/)|file:\/\/)/i.test(href);}
function safeUrl(href){
  if(/[\u0000-\u0020\u007f]/.test(href))return null;
  try{const url=new URL(href);return ['https:','http:','mailto:'].includes(url.protocol)?url.href:null;}catch{return null;}
}
function linkHTML(href,label,title=''){
  if(localPath(href))return `<span class="local-file" data-file-path="${escape(href)}" title="电脑文件：${escape(href)}">${label}</span>`;
  const url=safeUrl(href);
  return url?`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer"${title?' title="'+escape(title)+'"':''}>${label}</a>`:label;
}
const parser=new Marked({gfm:true,breaks:false,async:false,extensions:[mathExtension('mathBlock','block'),mathExtension('mathInline','inline')],renderer:{
  html({text}){return escape(text);},
  link({href,title,tokens}){const label=this.parser.parseInline(tokens);return /\.(?:png|jpe?g|webp|gif|hei[cf])(?:[?#].*)?$/i.test(href)?`<span class="media-reference" data-media-href="${escape(href)}" data-media-label="图片">${label}</span>`:linkHTML(href,label,title);},
  image({href,text}){return `<span class="media-reference" data-media-href="${escape(href)}" data-media-label="${escape(text||'图片')}"></span>`;},
  code({text,lang}){
    const language=(lang||'').split(/\s/)[0].slice(0,40);
    let contents=escape(text);
    // Never guess a language or execute code. Keep very long blocks plain.
    if(language&&text.length<=30000&&highlight.getLanguage(language)){
      try{contents=highlight.highlight(text,{language,ignoreIllegals:true}).value;}catch{}
    }
    return `<section class="code-block" data-language="${escape(language||'纯文本')}"><pre><code class="hljs">${contents}</code></pre></section>`;
  },
  table(token){return `<div class="table-scroll" tabindex="0" role="region" aria-label="表格，可左右滑动">${originalRenderer.table.call(this,token)}</div>`;},
  tablecell(token){const tag=token.header?'th':'td';return `<${tag}${token.align?' class="align-'+escape(token.align)+'"':''}>${this.parser.parseInline(token.tokens)}</${tag}>`;},
}});

const cache=new WeakMap();
let purifier;
function sanitized(source,doc){
  purifier??=createPurifier(doc.defaultView);
  const fragment=purifier.sanitize(parser.parse(source),{
    RETURN_DOM_FRAGMENT:true,USE_PROFILES:{html:true,mathMl:true,svg:true},
    ADD_ATTR:['target','encoding'],ADD_TAGS:['semantics','annotation'],
    FORBID_TAGS:['script','style','iframe','object','embed','img','video','audio','form','textarea','select','button'],
    FORBID_ATTR:['style','id','name'],
  });
  for(const el of fragment.querySelectorAll('[data-math-style]')){
    const declarations=el.getAttribute('data-math-style');el.removeAttribute('data-math-style');
    for(const declaration of declarations.split(';')){
      const colon=declaration.indexOf(':'),property=declaration.slice(0,colon).trim(),value=declaration.slice(colon+1).trim();
      if(mathStyles.has(property)&&/^[\d.\-+a-zA-Z%#(),\s]+$/.test(value))el.style.setProperty(property,value);
    }
  }
  return fragment;
}
async function copyText(text,button){
  const doc=button.ownerDocument,win=doc.defaultView;
  try{
    if(win.navigator.clipboard?.writeText)await win.navigator.clipboard.writeText(text);
    else{
      const field=doc.createElement('textarea');field.className='copy-buffer';field.value=text;field.readOnly=true;doc.body.append(field);field.select();field.setSelectionRange(0,text.length);
      let copied=false;try{copied=doc.execCommand('copy');}finally{field.remove();button.focus({preventScroll:true});}if(!copied)throw new Error('Clipboard unavailable');
    }
    button.textContent='已复制';
  }catch{
    button.textContent='请长按选择复制';
    let target=button.parentElement.nextElementSibling;
    if(button.parentElement.classList.contains('local-file')){
      target=button.parentElement.querySelector('.copy-fallback');
      if(!target){target=doc.createElement('code');target.className='copy-fallback';target.textContent=text;button.parentElement.append(target);}
    }
    if(target){const range=doc.createRange();range.selectNodeContents(target);const selection=win.getSelection();selection.removeAllRanges();selection.addRange(range);}
    return;
  }
  win.setTimeout(()=>{if(button.isConnected)button.textContent=button.dataset.label;},2000);
}
function copyButton(doc,text,label){const button=doc.createElement('button');button.type='button';button.className='copy-code';button.textContent=label;button.dataset.label=label;button.addEventListener('click',()=>copyText(text,button));return button;}
function decorate(fragment,doc,media={},prior=new Map()){
  for(const el of fragment.querySelectorAll('.media-reference')){
    const href=el.dataset.mediaHref,label=el.dataset.mediaLabel;
    const descriptor=media[href]??(imageUrl(href)?{url:href,external:true}:{error:'图片暂不可用'});
    const key=JSON.stringify([href,label,descriptor]);
    const figure=prior.get(key)||imageFigure(doc,descriptor,label,href);figure.dataset.mediaKey=key;
    if(!figure.dataset.fallbackAdded&&localPath(href)){figure.dataset.fallbackAdded='1';const details=doc.createElement('details');details.className='imagePath';const summary=doc.createElement('summary');summary.textContent='电脑文件';const path=doc.createElement('span');path.className='local-file';path.dataset.filePath=href;path.textContent=href;details.append(summary,path);figure.append(details);}
    el.replaceWith(figure);
  }
  for(const section of fragment.querySelectorAll('.code-block')){
    const toolbar=doc.createElement('div');toolbar.className='code-toolbar';
    const label=doc.createElement('span');label.textContent=section.dataset.language;
    toolbar.append(label,copyButton(doc,section.querySelector('code').textContent,'复制代码'));section.prepend(toolbar);
  }
  for(const el of fragment.querySelectorAll('.local-file'))if(!el.querySelector('button'))el.append(copyButton(doc,el.dataset.filePath,'复制路径'));
}

// Original text stays in the transcript. Render only changed assistant bodies;
// preserve horizontal reading positions when a streamed snapshot grows.
export function renderMessageBody(body,text,{rich=true,media={},images=[]}={}){
  text=String(text??'');const prior=cache.get(body);
  const imageKey=JSON.stringify([media,images]);
  if(prior?.text===text&&prior.rich===rich&&prior.imageKey===imageKey)return false;
  const figures=new Map([...body.querySelectorAll('[data-media-key]')].map(el=>[el.dataset.mediaKey,el]));
  const doc=body.ownerDocument,selection=doc.defaultView.getSelection();
  const selected=selection?.rangeCount&&!selection.isCollapsed&&body.contains(selection.getRangeAt(0).commonAncestorContainer);
  const range=selected?selection.getRangeAt(0):null;
  const offsets=range?selectionOffsets(body,range):null;
  const scrolls=[...body.querySelectorAll('.table-scroll,pre,.math-display,.math-inline')].map(el=>[el.scrollLeft,el.scrollTop]);
  body.classList.toggle('markdown',rich);
  try{
    if(rich){const fragment=sanitized(text,doc);decorate(fragment,doc,media,figures);body.replaceChildren(fragment);}
    else body.textContent=text;
    if(images.length){const gallery=doc.createElement('div');gallery.className='messageImages';for(const image of images){const key=JSON.stringify(image);const figure=figures.get(key)||imageFigure(doc,image,image.name||'图片');figure.dataset.mediaKey=key;gallery.append(figure);}body.append(gallery);}
  }catch{body.classList.remove('markdown');body.textContent=text;}
  cache.set(body,{text,rich,imageKey});
  [...body.querySelectorAll('.table-scroll,pre,.math-display,.math-inline')].forEach((el,i)=>{if(scrolls[i]){el.scrollLeft=scrolls[i][0];el.scrollTop=scrolls[i][1];}});
  if(offsets)restoreSelection(body,offsets,selection);
  return true;
}
function selectionOffsets(body,range){const prefix=range.cloneRange();prefix.selectNodeContents(body);prefix.setEnd(range.startContainer,range.startOffset);return [prefix.toString().length,prefix.toString().length+range.toString().length];}
function restoreSelection(body,[start,end],selection){
  const doc=body.ownerDocument,walker=doc.createTreeWalker(body,4),range=doc.createRange();let offset=0,started=false,node;
  while((node=walker.nextNode())){const length=node.textContent.length;
    if(!started&&offset+length>=start){range.setStart(node,Math.min(length,start-offset));started=true;}
    if(started&&offset+length>=end){range.setEnd(node,Math.min(length,end-offset));selection.removeAllRanges();selection.addRange(range);return;}offset+=length;
  }
}
