// Keep large image bytes out of the Python/SSE state channel. This is a private
// desktop reader; the resulting files are still checked by the media service.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const directory=fileURLToPath(new URL('../runtime/desktop-media/',import.meta.url));
const projectedImages=new WeakMap();
// Cache by the authoritative image object, so text deltas neither re-decode
// megabytes of unchanged image data nor retain images from expired streams.
export function projectMedia(original,publicFields){
  const source=original.url??original.savedPath??original.src??original.result;
  const prior=projectedImages.get(original),value={...publicFields};
  if(prior&&prior.source===source){Object.assign(value,prior.fields);if(value.type==='localImage')delete value.url;if(value.type==='imageGeneration'){delete value.result;delete value.src;}return value;}
  localizeImages(value);
  projectedImages.set(original,{source,fields:value.type==='imageGeneration'?{savedPath:value.savedPath}:{type:value.type,...(value.path?{path:value.path}:{})}});
  return value;
}
export function localizeImages(value,root=directory){
  const save=source=>{
    if(typeof source!=='string'||!source.startsWith('data:image/'))return source;
    const comma=source.indexOf(',');if(comma<0||!source.slice(0,comma).endsWith(';base64')||source.length>28*1024*1024)return null;
    const buffer=Buffer.from(source.slice(comma+1),'base64');if(buffer.length>20*1024*1024)return null;
    const hash=createHash('sha256').update(buffer).digest('hex');fs.mkdirSync(root,{recursive:true});const file=path.join(root,hash+'.image');
    if(!fs.existsSync(file)){const temp=file+'.tmp';fs.writeFileSync(temp,buffer,{flag:'w'});fs.renameSync(temp,file);}return file;
  };
  const visit=object=>{
    if(!object||typeof object!=='object')return;
    if(object.type==='imageGeneration'){
      let source=object.savedPath||object.src||object.result;
      if(typeof source==='string'&&source&&!/^(?:data:|https?:|file:|\/|[a-z]:[\\/])/i.test(source))source='data:image/png;base64,'+source;
      object.savedPath=save(source);delete object.src;delete object.result;
    }else if(object.type==='image'&&object.url?.startsWith('data:image/')){object.type='localImage';object.path=save(object.url);delete object.url;}
    for(const child of Object.values(object))if(child&&typeof child==='object')Array.isArray(child)?child.forEach(visit):visit(child);
  };
  visit(value);return value;
}
