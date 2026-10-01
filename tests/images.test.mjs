import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {imageReferences} from '../scripts/media-references.mjs';
import {renderMessageBody} from '../static/markdown.mjs';
import {imageUrl,videoFigure} from '../static/media.mjs';
import {validateFiles,ImageComposer} from '../static/image_composer.mjs';
import {localizeImages,projectMedia} from '../desktop_bridge/media_transport.mjs';
import {FrameDecoder} from '../desktop_bridge/read_only_client.mjs';
import {projectTranscript} from '../desktop_bridge/transcript_stream.mjs';
import {transcriptRows} from '../static/transcript.mjs';

const id='b7dcda8d-51ce-428d-9280-e35d7e4ad4de',media={id,url:`/api/media/${id}/content`,thumbnail:`/api/media/${id}/content?variant=thumb`,width:80,height:40};
test('same Markdown grammar extracts explicit references but excludes code and raw HTML',()=>{
 assert.deepEqual(imageReferences('![x](<C:/photo space.png>) [y](C:/photo.jpg)\n\n```\n![z](C:/secret.png)\n```\n<img src="C:/raw.png">'),['C:/photo space.png','C:/photo.jpg']);
 for(const bad of ['file:///secret.png','javascript:alert(1)','data:image/svg+xml,evil','http://example.com/a.png','https://user:pass@example.com/a.png'])assert.equal(imageUrl(bad),null);
});
test('local and user images preserve aspect, safe paths, DOM identity while streaming, and preview closes',()=>{
 const dom=new JSDOM('<div id="body"></div>',{url:'http://localhost/'}),doc=dom.window.document,body=doc.getElementById('body');
 renderMessageBody(body,'![图片](C:/photo.png)',{media:{'C:/photo.png':media}});const img=body.querySelector('img');assert.equal(img.width,80);assert.equal(img.height,40);
 renderMessageBody(body,'![图片](C:/photo.png)\n\n新文字',{media:{'C:/photo.png':media}});assert.equal(body.querySelector('img'),img);
 body.querySelector('.imageOpen').click();assert.ok(doc.querySelector('.imageViewer'));doc.querySelector('.imageViewerToolbar').lastChild.click();assert.equal(doc.querySelector('.imageViewer'),null);
 renderMessageBody(body,'',{rich:false,images:[media]});assert.equal(body.querySelectorAll('img').length,1);dom.window.close();
});
test('native image input and generation survive projection, and bytes are localized off public channels',()=>{
 const raw={turns:[{id:'t',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'localImage',path:'C:/photo.png'}]},{id:'g',type:'imageGeneration',result:'aGVsbG8=',status:'completed'}]}]};
 const projected=projectTranscript(raw);assert.equal(projected.turns[0].items.length,2);const root=mkdtempSync(path.join(os.tmpdir(),'mobile-images-'));
 try{localizeImages(projected,root);const image=projected.turns[0].items[1];assert.ok(existsSync(image.savedPath));assert.equal(image.result,undefined);assert.equal(JSON.stringify(projected).includes('aGVsbG8='),false);
 projected.turns[0].items[0].content[0].media=media;image.media=media;const rows=transcriptRows({turns:projected.turns},null);assert.equal(rows[0].messages[0].images.length,1);assert.equal(rows[1].messages[0].images.length,1);
 }finally{rmSync(root,{recursive:true});}
});
test('upload limits are enforced and plus menu only opens chooser or existing mode panel',async()=>{
 assert.throws(()=>validateFiles([{name:'a.png',type:'image/png',size:21*1024*1024}]));assert.throws(()=>validateFiles(Array(11).fill({name:'a.png',type:'image/png',size:1})));
 const dom=new JSDOM(readFileSync(new URL('../static/index.html',import.meta.url),'utf8'),{url:'http://localhost/'}),doc=dom.window.document;let modes=0,picks=0,calls=0;
 const controller=new ImageComposer(doc,{api:async()=>{calls++;},ui:{closePanel(){},openPanel(mode){assert.equal(mode,'mode');modes++;}},notice(){},changed(){}});
 await controller.context('new');doc.getElementById('imageFiles').click=()=>picks++;
 doc.getElementById('openMode').click();assert.equal(doc.getElementById('attachmentMenu').hidden,false);doc.getElementById('chooseMode').click();assert.equal(modes,1);
 doc.getElementById('openMode').click();doc.getElementById('chooseImages').click();assert.equal(picks,1);assert.equal(calls,0);dom.window.close();
});

test('existing photo picker accepts videos and validates video limits alongside image limits',()=>{
 const dom=new JSDOM(readFileSync(new URL('../static/index.html',import.meta.url),'utf8'));
 assert.match(dom.window.document.getElementById('imageFiles').accept,/video\/\*/);
 validateFiles([{name:'录屏.MOV',type:'video/quicktime',size:30*1024*1024}]);
 validateFiles([{name:'video.mp4',type:'',size:1},{name:'图片.png',type:'image/png',size:1}]);
 assert.throws(()=>validateFiles([{name:'录屏.mov',type:'video/quicktime',size:101*1024*1024}]),/100 MiB/);
 assert.throws(()=>validateFiles([{name:'v.mov',type:'video/quicktime',size:90*1024*1024}],[{size:11*1024*1024}]),/合计/);
 assert.throws(()=>validateFiles([{name:'test.webm',type:'video/webm',size:1}]),/MP4/);
 dom.window.close();
});

test('video attachments render controlled native playback and retain the player while updating text',()=>{
 const dom=new JSDOM('<div id="body"></div>',{url:'http://localhost/'}),doc=dom.window.document,body=doc.getElementById('body');
 const video={...media,kind:'video',mime:'video/mp4',name:'录屏.mp4',duration:2};
 renderMessageBody(body,'',{rich:false,images:[video]});const player=body.querySelector('video');
 assert.ok(player.controls);assert.equal(player.preload,'metadata');assert.ok(player.hasAttribute('playsinline'));
 assert.equal(body.querySelectorAll('img').length,0);
 renderMessageBody(body,'新的文字',{rich:false,images:[video]});assert.equal(body.querySelector('video'),player);
 assert.equal(videoFigure(doc,{...video,url:'javascript:alert(1)'}).querySelector('video'),null);
 assert.equal(transcriptRows({turns:[{id:'t',items:[{id:'u',type:'userMessage',content:[],files:[video]}]}]},null)[0].messages[0].images[0].kind,'video');
 dom.window.close();
});

test('switching drafts blocks sends until attachment restore and never carries pictures across chats',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../static/index.html',import.meta.url),'utf8'),{url:'http://localhost/'}),doc=dom.window.document;
 const controller=new ImageComposer(doc,{api:async()=>{},ui:{closePanel(){},openPanel(){}},notice(){},changed(){}});
 Object.defineProperty(dom.window,'indexedDB',{value:{}});let resolve;
 controller.storage=()=>new Promise(r=>{resolve=r;});const pending=controller.context('chat-a');assert.equal(controller.ready,false);
 controller.storage=async()=>[];await controller.context('chat-b');assert.equal(controller.hasImages,false);assert.equal(controller.ready,true);
 resolve([{id,name:'saved.png',size:100,status:'ready',media}]);await pending;assert.equal(controller.hasImages,false);
 await controller.context('chat-a');assert.deepEqual(controller.ids(),[id]);assert.equal(controller.ready,true);dom.window.close();
});

test('private image IPC uses native bounds and streamed projections never alter the authoritative image',()=>{
 const header=Buffer.alloc(4);header.writeUInt32LE(140*1024*1024);assert.throws(()=>new FrameDecoder().push(header),/length/);assert.deepEqual(new FrameDecoder(256*1024*1024).push(header),[]);
 header.writeUInt32LE(256*1024*1024+1);assert.throws(()=>new FrameDecoder(256*1024*1024).push(header),/length/);
 const raw={type:'image',url:'data:image/png;base64,aGVsbG8='};const a=projectMedia(raw,{...raw}),b=projectMedia(raw,{...raw});assert.deepEqual(a,b);assert.equal(a.type,'localImage');assert.ok(a.path);assert.ok(raw.url.startsWith('data:'));assert.equal(a.url,undefined);
 const pending={type:'imageGeneration',status:'inProgress'};assert.equal(projectMedia(pending,{...pending}).status,'inProgress');
});
