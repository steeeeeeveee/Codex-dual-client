let count=0;document.querySelector('#result').textContent='无正文渲染：0 条安全策略提示';
document.addEventListener('securitypolicyviolation',event=>{document.querySelector('#result').textContent=`无正文渲染：${++count} 条安全策略提示 ${event.violatedDirective} ${event.sourceFile}:${event.lineNumber} ${event.blockedURI}`;});
