// Synchronous, fsync-backed receipts in the isolated desktop's private profile.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createJournal(directory, allowedThreadId) {
  return request => {
    if (request.operation === 'media-validate') return validateMedia(request.attachments);
    if (request.operation?.startsWith('workflow-')) return workflowReceipt(directory, request);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.threadId ?? '') || !allowedThreadId || (allowedThreadId !== '*' && request.threadId !== allowedThreadId)) throw Error('Lab conversation required');
    const folder = path.join(directory, request.threadId);
    const read = id => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error('Invalid receipt ID');
      const file = path.join(folder, id + '.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    };
    if (request.operation === 'list') {
      return fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
        .map(name => ({ messageId: name.slice(0, -5), receipt: read(name.slice(0, -5)) })) : [];
    }
    const existing = read(request.messageId);
    if (request.operation === 'get') return existing;
    if (request.operation !== 'set' || !/^[0-9a-f]{64}$/.test(request.receipt?.digest)
      || !['uncertain', 'committed'].includes(request.receipt?.status)) throw Error('Invalid receipt');
    if (existing && existing.digest !== request.receipt.digest) throw Error('Receipt payload changed');
    if (existing?.status === 'committed' && request.receipt.status === 'uncertain') throw Error('Receipt cannot go backwards');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, request.messageId + '.json');
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(request.receipt)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    // A successful reply follows an explicit flush of the final named file.
    const committed = fs.openSync(file, 'r+');
    try { fs.fsyncSync(committed); } finally { fs.closeSync(committed); }
    return true;
  };
}
async function validateMedia(attachments) {
  const root = process.env.CODEX_MOBILE_MEDIA_ROOT;
  if (!root || !Array.isArray(attachments) || attachments.length > 10) throw Error('Image storage unavailable');
  const mediaRoot = await fs.promises.realpath(root);
  return Promise.all(attachments.map(async image => {
    if (!/^[0-9a-f-]{36}$/.test(image.id ?? '') || !/^[0-9a-f]{64}$/.test(image.sha256 ?? '') || typeof image.localPath !== 'string') throw Error('Invalid image attachment');
    const file = await fs.promises.realpath(image.localPath);
    const video=image.kind==='video';
    if(image.kind!=null&&!['image','video'].includes(image.kind))throw Error('Invalid media kind');
    const filename=path.basename(file);
    const allowed=video?/^original\.(?:mp4|mov)$/.test(filename)&&image.mime===(filename.endsWith('.mov')?'video/quicktime':'video/mp4'):/^(?:original\.(?:jpg|png|webp)|full\.(?:jpg|png))$/.test(filename);
    if (path.dirname(path.dirname(file)) !== mediaRoot || path.basename(path.dirname(file)) !== image.id || !allowed) throw Error('Image or video outside managed storage');
    const stat=await fs.promises.stat(file);
    if(!stat.isFile()||(video&&stat.size>100*1024*1024))throw Error('Media size exceeded');
    const bytes = await fs.promises.readFile(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw Error('Image content changed');
    return {id:image.id,localPath:file,sha256:image.sha256,filename:String(image.filename??'附件').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,200),...(video?{kind:'video',mime:image.mime}:{})};
  }));
}
function workflowReceipt(directory, request) {
  if (!['creation','settings','implementation'].includes(request.kind) || !/^[0-9a-f-]{36}$/.test(request.requestId ?? '')) throw Error('Invalid workflow ID');
  const folder = path.join(directory, 'workflows', request.kind);
  const file = path.join(folder, request.requestId + '.json');
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (request.operation === 'workflow-get') return existing;
  if (!['workflow-claim','workflow-set'].includes(request.operation) || !/^[0-9a-f]{64}$/.test(request.receipt?.digest) ||
      !['uncertain','created','applied','conflict','unsupported'].includes(request.receipt?.status)) throw Error('Invalid workflow receipt');
  if (existing && existing.digest !== request.receipt.digest) throw Error('Workflow payload changed');
  if (request.operation === 'workflow-claim' && existing) return {claimed:false,receipt:existing};
  if (existing && existing.status !== 'uncertain') {
    if (JSON.stringify(existing) !== JSON.stringify(request.receipt)) throw Error('Final workflow receipt is immutable');
    return existing;
  }
  if (request.operation === 'workflow-set' && !existing) throw Error('Workflow claim required');
  if (request.receipt.status === 'created' && !/^[0-9a-f-]{36}$/.test(request.receipt.threadId ?? '')) throw Error('Invalid created thread');
  fs.mkdirSync(folder,{recursive:true});
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary,'wx',0o600);
  try {fs.writeFileSync(fd,JSON.stringify(request.receipt));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(temporary,file);
  const final = fs.openSync(file,'r+'); try {fs.fsyncSync(final);} finally {fs.closeSync(final);}
  return request.operation === 'workflow-claim' ? {claimed:true,receipt:request.receipt} : request.receipt;
}
let journal;
exports.handle = (event, request) => {
  if (!event.senderFrame?.url.startsWith('app://')) throw Error('Desktop app frame required');
  if (request.operation === 'workflow-ready') return event.sender?.__codexMobilePrimary === true;
  if (request.operation === 'desktop-tools-ready') return !!process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if (request.kind === 'creation' && event.sender?.__codexMobilePrimary !== true) throw Error('Primary desktop required for creation');
  const shared = process.env.CODEX_MOBILE_SHARED_DESKTOP === '1';
  journal ??= createJournal(path.join(process.env.CODEX_ELECTRON_USER_DATA_PATH, shared ? 'mobile-shared-receipts' : 'mobile-lab-receipts'),
    shared ? '*' : process.env.CODEX_MOBILE_LAB_THREAD_ID);
  return journal(request);
};
exports.createJournal = createJournal;
