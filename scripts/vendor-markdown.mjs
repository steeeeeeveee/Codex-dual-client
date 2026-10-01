// Ship fixed local assets; the running phone page never contacts a CDN.
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const assets=[
  ['marked','lib/marked.esm.js','marked.mjs'],
  ['dompurify','dist/purify.es.mjs','purify.mjs'],
  ['katex','dist/katex.mjs','katex/katex.mjs'],
  ['katex','dist/katex.min.css','katex/katex.min.css'],
  ['@highlightjs/cdn-assets','es/highlight.min.js','highlight.mjs'],
  ['@highlightjs/cdn-assets','styles/github.min.css','highlight.css'],
];
const target=root+'static/vendor/';await mkdir(target,{recursive:true});
const manifest={packages:{},assets:{}};
for(const [pkg,source,dest] of assets){
  const base=root+'node_modules/'+pkg+'/';
  await mkdir(target+dest.slice(0,Math.max(0,dest.lastIndexOf('/'))),{recursive:true});
  await cp(base+source,target+dest);
  manifest.assets[dest]=createHash('sha256').update(await readFile(target+dest)).digest('hex');
  if(!manifest.packages[pkg]){
    const data=JSON.parse(await readFile(base+'package.json','utf8'));
    manifest.packages[pkg]={version:data.version,license:data.license,source:`https://www.npmjs.com/package/${pkg}`};
    await cp(base+'LICENSE',target+pkg.replaceAll('/','-')+'-LICENSE');
  }
}
await cp(root+'node_modules/dompurify/LICENSE-MPL',target+'dompurify-LICENSE-MPL');
await cp(root+'node_modules/katex/dist/fonts',target+'katex/fonts',{recursive:true});
await writeFile(target+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
