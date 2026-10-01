// Isolated visual fixture only; never loaded by the production page.
const scene=document.documentElement.dataset.scene;
sessionStorage.clear();localStorage.clear();
if(['new','login','pending'].includes(scene))sessionStorage.setItem('newConversation','1');
else sessionStorage.setItem('selectedThread','fixture-ui-visual');
if(scene==='pending')localStorage.setItem('newCreationRequest',JSON.stringify({requestId:'fixture-create',messageId:'fixture-first',target:{type:'projectless'},text:'一条等待电脑创建的消息',mode:'default'}));
if(scene==='keyboard')await import('./ui-keyboard.mjs');
