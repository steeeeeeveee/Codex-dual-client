export function imageUrl(value,{blob=false}={}){
  if(typeof value!=='string'||/[\u0000-\u0020\u007f]/.test(value))return null;
  if(/^\/api\/media\/[0-9a-f-]{36}\/content(?:\?variant=thumb)?$/.test(value))return value;
  if(blob&&value.startsWith('blob:'))return value;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function imageFigure(doc,media,label='图片',source=''){
  if(media?.kind==='video')return videoFigure(doc,media,media.name||'视频');
  const figure=doc.createElement('figure');figure.className='chatImage';
  const full=imageUrl(media?.url),thumb=imageUrl(media?.thumbnail)||full;
  if(!full){figure.classList.add('imageUnavailable');figure.textContent=label+' · '+(media?.error||'图片暂不可用');const fallback=media?.source||source;if(fallback&&!fallback.startsWith('data:')){const path=doc.createElement('p');path.className='imagePath';path.textContent=fallback;figure.append(path);}return figure;}
  const button=doc.createElement('button');button.type='button';button.className='imageOpen';button.setAttribute('aria-label','放大查看：'+label);
  const img=doc.createElement('img');img.alt=label;img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';
  if(media.width&&media.height){img.width=media.width;img.height=media.height;img.style.aspectRatio=media.width+'/'+media.height;}
  img.src=thumb;button.append(img);figure.append(button);
  img.addEventListener('error',()=>{button.hidden=true;figure.querySelector('.imageLoadError')?.remove();const hint=doc.createElement('p');hint.className='imageLoadError';hint.textContent='图片加载失败';const retry=doc.createElement('button');retry.type='button';retry.textContent='重试';retry.onclick=()=>{hint.remove();button.hidden=false;img.src=thumb;};hint.append(retry);figure.append(hint);});
  button.onclick=()=>openImage(doc,full,label,button);
  if(media.external){const link=doc.createElement('a');link.href=full;link.textContent='打开原图';link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';figure.append(link);}
  return figure;
}
export function videoFigure(doc,media,label='视频'){
  const figure=doc.createElement('figure');figure.className='chatImage chatVideo';
  const full=imageUrl(media?.url);
  if(!full){figure.classList.add('imageUnavailable');figure.textContent=label+' · '+(media?.error||'视频暂不可用');return figure;}
  const video=doc.createElement('video');video.controls=true;video.preload='metadata';video.setAttribute('playsinline','');video.setAttribute('aria-label',label);video.src=full;
  if(media.width&&media.height){video.width=media.width;video.height=media.height;video.style.aspectRatio=media.width+'/'+media.height;}
  const caption=doc.createElement('figcaption');caption.textContent=label;
  const fallback=doc.createElement('a');fallback.href=full;fallback.textContent='打开视频';fallback.target='_blank';fallback.rel='noopener noreferrer';fallback.hidden=true;
  video.addEventListener('error',()=>{fallback.hidden=false;caption.textContent=label+' · 当前浏览器无法播放，可打开原视频';});
  figure.append(video,caption,fallback);return figure;
}
export function openImage(doc,url,label,origin){
  doc.querySelector('.imageViewer')?.remove();
  const viewer=doc.createElement('div');viewer.className='imageViewer';viewer.tabIndex=-1;viewer.setAttribute('role','dialog');viewer.setAttribute('aria-modal','true');viewer.setAttribute('aria-label','图片预览');
  const toolbar=doc.createElement('div');toolbar.className='imageViewerToolbar';const canvas=doc.createElement('div');canvas.className='imageViewerCanvas';
  const img=doc.createElement('img');img.src=url;img.alt=label;img.referrerPolicy='no-referrer';canvas.append(img);
  let scale=1,x=0,y=0;const pointers=new Map();
  const draw=()=>img.style.transform=`translate(${x}px,${y}px) scale(${scale})`;
  const zoom=amount=>{scale=Math.max(1,Math.min(6,scale*amount));if(scale===1)x=y=0;draw();};
  const close=()=>{viewer.remove();doc.removeEventListener('keydown',keyboard);origin?.focus({preventScroll:true});};
  const keyboard=event=>{if(event.key==='Escape')close();if(event.key==='Tab'){const controls=[...toolbar.querySelectorAll('button')],i=controls.indexOf(doc.activeElement);event.preventDefault();controls[(i+(event.shiftKey?-1:1)+controls.length)%controls.length].focus({preventScroll:true});}};
  for(const [text,action]of [['缩小',()=>zoom(1/1.4)],['放大',()=>zoom(1.4)],['关闭',close]]){const button=doc.createElement('button');button.type='button';button.textContent=text;button.onclick=action;toolbar.append(button);}
  canvas.onpointerdown=event=>{pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});canvas.setPointerCapture?.(event.pointerId);};
  canvas.onpointermove=event=>{if(!pointers.has(event.pointerId))return;const prior=[...pointers.values()],old=pointers.get(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});const current=[...pointers.values()];if(current.length===2){const distance=p=>Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);zoom(distance(current)/Math.max(1,distance(prior)));}else if(scale>1){x+=event.clientX-old.x;y+=event.clientY-old.y;draw();}};
  canvas.onpointerup=canvas.onpointercancel=event=>pointers.delete(event.pointerId);
  canvas.addEventListener('wheel',event=>{event.preventDefault();zoom(event.deltaY<0?1.1:1/1.1);},{passive:false});
  viewer.append(toolbar,canvas);doc.body.append(viewer);doc.addEventListener('keydown',keyboard);toolbar.lastChild.focus({preventScroll:true});
}
