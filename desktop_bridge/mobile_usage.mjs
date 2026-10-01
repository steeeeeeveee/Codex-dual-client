// Only public account metadata is hashed; credentials never leave the desktop.
async function accountKey(value) {
 const account=value?.account;
 if(!account||!['chatgpt','chatgptAuthTokens','personalAccessToken','agentIdentity'].includes(account.type))return null;
 const identity=account.id??account.accountId??account.email;
 if(typeof identity!=='string'||!identity)return null;
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([account.type,identity])));
 return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
}
export function selectWindows(value) {
 const multi=value?.rateLimitsByLimitId;
 let bucket=multi?.codex;
 if(!bucket){const legacy=value?.rateLimits;if(legacy&&(!legacy.limitId||legacy.limitId==='codex'))bucket=legacy;}
 if(bucket?.limitId&&bucket.limitId!=='codex')bucket=null;
 const windows={fiveHour:null,weekly:null};
 for(const name of ['primary','secondary']){
  const w=bucket?.[name];if(!w||typeof w.usedPercent!=='number'||!Number.isFinite(w.usedPercent))continue;
  const key=w.windowDurationMins===300?'fiveHour':w.windowDurationMins===10080?'weekly':null;
  if(key&&!windows[key])windows[key]={remainingPercent:Math.max(0,Math.min(100,100-w.usedPercent)),
   resetsAt:Number.isSafeInteger(w.resetsAt)&&w.resetsAt>0?w.resetsAt:null};
 }
 return windows;
}
export async function readUsage(send) {
 const before=await accountKey(await send('account/read',{refreshToken:false}));
 if(!before)return {status:'unavailable',reason:'login-required',accountKey:null};
 let limits,failed=false;try{limits=await send('account/rateLimits/read',null);}catch{failed=true;}
 const after=await accountKey(await send('account/read',{refreshToken:false}));
 if(before!==after)return {status:'unavailable',reason:'account-changed',accountKey:after};
 if(failed)return {status:'unavailable',reason:'read-failed',accountKey:before};
 const windows=selectWindows(limits);
 return {status:windows.fiveHour||windows.weekly?'fresh':'unavailable',reason:windows.fiveHour||windows.weekly?null:'windows-unavailable',
  accountKey:before,fetchedAt:Date.now()/1000,windows};
}
