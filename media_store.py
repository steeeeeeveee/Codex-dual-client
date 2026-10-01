"""Private immutable media storage. Public callers provide IDs, never file paths."""
import asyncio
import base64
import copy
import hashlib
import io
import json
import os
import re
from pathlib import Path
import sqlite3
import threading
import time
import uuid
import warnings
from urllib.parse import unquote, urlparse

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from video_probe import MAX_VIDEO, video_container, probe_video

register_heif_opener()
Image.MAX_IMAGE_PIXELS = 60_000_000
MAX_FILE = 20 * 1024 * 1024
MAX_TOTAL = 100 * 1024 * 1024
MAX_UPLOAD = MAX_VIDEO
FORMATS = {'JPEG':'jpg', 'PNG':'png', 'WEBP':'webp', 'GIF':'gif', 'HEIF':'heic'}


def identity(value):
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ValueError('图片标识无效') from None
    return value


class MediaStore:
    def __init__(self, root, node=None):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / 'media.sqlite', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, digest TEXT NOT NULL, value TEXT NOT NULL, touched REAL NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS refs(owner TEXT NOT NULL, asset TEXT NOT NULL, PRIMARY KEY(owner,asset))')
        self.db.execute('CREATE TABLE IF NOT EXISTS sources(source TEXT PRIMARY KEY, asset TEXT NOT NULL)')
        self.db.commit()
        self.lock = threading.RLock()
        self.asset_locks = {}
        self.node = node
        self.markdown_cache = {}
        self.source_errors = {}

    def get(self, asset_id, touch=False):
        identity(asset_id)
        with self.lock:
            row = self.db.execute('SELECT value FROM assets WHERE id=?', (asset_id,)).fetchone()
            if not row:
                raise ValueError('图片尚未上传成功或已失效，请重新选择')
            if touch:
                self.db.execute('UPDATE assets SET touched=? WHERE id=?', (time.time(),asset_id))
                self.db.commit()
            return json.loads(row['value'])

    def public(self, value):
        return {**{k:value[k] for k in ('id','name','width','height','bytes','mime','url','thumbnail')},
                'kind':value.get('kind','image'), **({'duration':value['duration']} if value.get('kind')=='video' else {})}

    def ingest(self, data, asset_id, name='图片'):
        identity(asset_id)
        is_video = video_container(data)
        if not data or len(data) > (MAX_VIDEO if is_video else MAX_FILE):
            raise ValueError('单个视频最多 100 MiB，图片最多 20 MiB，且不能为空')
        digest = hashlib.sha256(data).hexdigest()
        with self.lock:
            asset_lock=self.asset_locks.setdefault(asset_id,threading.Lock())
        with asset_lock:
            with self.lock:
                row = self.db.execute('SELECT digest,value FROM assets WHERE id=?', (asset_id,)).fetchone()
            if row:
                if row['digest'] != digest:
                    raise ValueError('上传标识已用于另一张图片')
                self.get(asset_id, True)
                return json.loads(row['value'])
            if is_video:
                return self._ingest_video(data,asset_id,name,digest)
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter('error', Image.DecompressionBombWarning)
                    image = Image.open(io.BytesIO(data))
                    fmt = image.format
                    if fmt not in FORMATS:
                        raise ValueError('仅支持 JPEG、PNG、WebP、GIF、HEIC/HEIF 图片')
                    if image.width * image.height > Image.MAX_IMAGE_PIXELS:
                        raise ValueError('图片超过 6000 万像素，请选择较小的图片')
                    image.seek(0)
                    image.load()
                    orientation = image.getexif().get(274, 1)
                    image = ImageOps.exif_transpose(image)
            except ValueError:
                raise
            except Exception:
                raise ValueError('图片损坏、格式不支持或像素过大') from None
            folder = self.root / asset_id
            folder.mkdir(exist_ok=True)
            original = folder / ('original.' + FORMATS[fmt])
            self._write(original, data)
            model = original
            mime = {'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp'}.get(fmt)
            if fmt in ('HEIF','GIF') or orientation != 1:
                target = 'JPEG' if fmt in ('HEIF','JPEG') else 'PNG'
                model = folder / ('full.jpg' if target == 'JPEG' else 'full.png')
                output = io.BytesIO()
                converted = image.convert('RGB') if target == 'JPEG' else image
                converted.save(output, format=target, **({'quality':95,'subsampling':0} if target=='JPEG' else {}))
                self._write(model, output.getvalue())
                mime = 'image/jpeg' if target == 'JPEG' else 'image/png'
            thumb = image.copy()
            if thumb.mode not in ('RGB','RGBA','L','LA'):
                thumb=thumb.convert('RGBA' if 'transparency' in thumb.info else 'RGB')
            thumb.thumbnail((640,640))
            output = io.BytesIO()
            thumb.save(output, format='PNG' if 'A' in thumb.getbands() else 'JPEG', **({'quality':85} if 'A' not in thumb.getbands() else {}))
            thumbnail = folder / ('thumb.png' if 'A' in thumb.getbands() else 'thumb.jpg')
            self._write(thumbnail, output.getvalue())
            value = dict(id=asset_id,name=Path(name.replace('\\','/')).name[:200] or '图片',width=image.width,height=image.height,
                bytes=len(data),mime=mime,path=str(model),original=str(original),thumbPath=str(thumbnail),
                sha256=hashlib.sha256(model.read_bytes()).hexdigest(),url=f'/api/media/{asset_id}/content',thumbnail=f'/api/media/{asset_id}/content?variant=thumb')
            with self.lock:
                self.db.execute('INSERT INTO assets VALUES(?,?,?,?)', (asset_id,digest,json.dumps(value),time.time()))
                self.db.commit()
            return value

    def _ingest_video(self, data, asset_id, name, digest):
        folder = self.root / asset_id
        folder.mkdir(exist_ok=True)
        temporary = folder / 'video-check.mp4'
        self._write(temporary,data)
        try:
            metadata = probe_video(temporary)
            extension = 'mov' if data[8:12] == b'qt  ' else 'mp4'
            original = folder / ('original.' + extension)
            temporary.replace(original)
            name = re.sub(r'[\x00-\x1f\x7f]', ' ', Path(name.replace('\\','/')).name)[:200] or '视频.' + extension
            value = dict(id=asset_id,kind='video',name=name,**metadata,bytes=len(data),
                mime='video/quicktime' if extension=='mov' else 'video/mp4',path=str(original),
                original=str(original),thumbPath=str(original),sha256=digest,
                url=f'/api/media/{asset_id}/content',thumbnail=f'/api/media/{asset_id}/content')
            with self.lock:
                self.db.execute('INSERT INTO assets VALUES(?,?,?,?)',(asset_id,digest,json.dumps(value),time.time()))
                self.db.commit()
            return value
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _write(path, data):
        temporary = path.with_suffix(path.suffix + '.tmp')
        with temporary.open('wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)

    def attachments(self, ids):
        if not isinstance(ids,list) or len(ids)>10 or len(set(ids))!=len(ids):
            raise ValueError('一次最多发送 10 个不同的图片或视频附件')
        values = [self.get(asset_id, True) for asset_id in ids]
        if sum(value['bytes'] for value in values)>MAX_TOTAL:
            raise ValueError('本次附件合计不能超过 100 MiB')
        return [dict(id=v['id'],localPath=v['path'],sha256=v['sha256'],filename=v['name'],
                     **({'kind':'video','mime':v['mime']} if v.get('kind')=='video' else {})) for v in values]

    def bind(self, owner, ids, replace=False):
        for asset_id in ids:
            self.get(asset_id)
        with self.lock:
            if replace:
                self.db.execute('DELETE FROM refs WHERE owner=?',(owner,))
            self.db.executemany('INSERT OR IGNORE INTO refs VALUES(?,?)', [(owner,asset_id) for asset_id in ids])
            self.db.executemany('UPDATE assets SET touched=? WHERE id=?', [(time.time(),asset_id) for asset_id in ids])
            self.db.commit()

    def cleanup(self):
        # Only unreferenced immutable assets in this exact managed directory.
        with self.lock:
            rows = self.db.execute('SELECT id,value FROM assets WHERE touched<? AND id NOT IN (SELECT asset FROM refs)',(time.time()-7*86400,)).fetchall()
            for row in rows:
                folder = (self.root / identity(row['id'])).resolve()
                if folder.parent != self.root:
                    continue
                for file in folder.iterdir():
                    if file.is_file() and not file.is_symlink():
                        file.unlink()
                if not any(folder.iterdir()):
                    folder.rmdir()
                    self.db.execute('DELETE FROM assets WHERE id=?',(row['id'],))
                    self.db.execute('DELETE FROM sources WHERE asset=?',(row['id'],))
            self.db.commit()

    def source(self, source, owner):
        """Only called with references extracted from authoritative desktop history."""
        if not isinstance(source,str) or not source:
            return {'error':'图片文件尚不可用'}
        if source.startswith('https://'):
            parsed = urlparse(source)
            if parsed.netloc and not parsed.username and not parsed.password:
                return {'url':source,'thumbnail':source,'name':'图片','external':True}
        cache_key=hashlib.sha256((owner+'\0'+source).encode()).hexdigest()
        with self.lock:
            cached = self.db.execute('SELECT asset FROM sources WHERE source=?',(cache_key,)).fetchone()
        if cached:
            value = self.get(cached['asset'])
            self.bind(owner,[value['id']])
            return self.public(value)
        failed = self.source_errors.get(source)
        if failed and time.monotonic()-failed[0]<5:
            return failed[1]
        try:
            if source.startswith('data:image/'):
                header,encoded = source.split(',',1)
                if ';base64' not in header or len(encoded)>MAX_FILE*4//3+8:
                    raise ValueError('图片数据格式或大小不受支持')
                data=base64.b64decode(encoded,validate=True)
                name='生成图片.png'
            else:
                path=source
                if path.startswith('file://'):
                    parsed=urlparse(path)
                    if parsed.netloc and parsed.netloc != 'localhost':
                        raise ValueError('暂不读取网络共享图片')
                    path=unquote(parsed.path).lstrip('/') if os.name=='nt' else unquote(parsed.path)
                if not Path(path).is_absolute():
                    raise ValueError('图片引用需要电脑上的绝对路径')
                resolved=Path(path).resolve(strict=True)
                if resolved.parent.parent==self.root:
                    try:
                        managed=self.get(resolved.parent.name)
                        if Path(managed['path']).resolve()==resolved:
                            self.bind(owner,[managed['id']])
                            return self.public(managed)
                    except ValueError:
                        pass
                limit=MAX_VIDEO if resolved.suffix.lower() in ('.mp4','.mov') else MAX_FILE
                if not resolved.is_absolute() or str(resolved).startswith('\\\\') or not resolved.is_file() or resolved.stat().st_size>limit:
                    raise ValueError('媒体文件不可用或超过大小限制')
                data=resolved.read_bytes()
                name=resolved.name
            digest=hashlib.sha256(data).hexdigest()
            with self.lock:
                existing=self.db.execute("SELECT value FROM assets WHERE digest=? OR json_extract(value,'$.sha256')=? LIMIT 1",(digest,digest)).fetchone()
            value=json.loads(existing['value']) if existing else self.ingest(data,str(uuid.uuid5(uuid.NAMESPACE_URL,cache_key)),name)
            with self.lock:
                self.db.execute('INSERT OR IGNORE INTO sources VALUES(?,?)',(cache_key,value['id']))
                self.db.commit()
            self.bind(owner,[value['id']])
            return self.public(value)
        except Exception as exc:
            result={'error':str(exc) if isinstance(exc,ValueError) else '电脑图片文件已不存在或暂时无法读取'}
            if not source.startswith('data:') and len(source)<4096:
                result['source']=source
            self.source_errors[source]=(time.monotonic(),result)
            return result

    async def project(self, payload, owner='history'):
        value=copy.deepcopy(payload)
        turns=value.get('turns',value.get('thread',{}).get('turns',[]))
        items=[item for turn in turns for item in turn.get('items',[])]+value.get('items',[])
        texts=[item['text'] for item in items if item.get('type') in ('agentMessage','plan') and isinstance(item.get('text'),str)]
        missing=list(dict.fromkeys(text for text in texts if text not in self.markdown_cache))
        if missing and self.node:
            process=None
            try:
                process=await asyncio.create_subprocess_exec(self.node,str(Path(__file__).parent/'scripts/media-references.mjs'),
                    stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,
                    creationflags=0x08000000 if os.name=='nt' else 0)
                output,_=await asyncio.wait_for(process.communicate(json.dumps(missing).encode()),10)
                if process.returncode!=0:
                    raise ValueError('Markdown image parser failed')
                self.markdown_cache.update(zip(missing,json.loads(output)))
                if len(self.markdown_cache)>400:
                    self.markdown_cache={text:self.markdown_cache[text] for text in texts if text in self.markdown_cache}
            except Exception:
                # A failed image projection must not interrupt text streaming.
                if process and process.returncode is None:
                    process.kill();await process.wait()
            except BaseException:
                if process and process.returncode is None:
                    process.kill();await process.wait()
                raise
        for item in items:
            if item.get('type')=='userMessage':
                item_files=[]
                for part in item.get('content',[]):
                    text=part.get('text','') if part.get('type')=='text' else ''
                    if text.lstrip().startswith('# Files mentioned by the user:') and '\n## My request:\n' in text:
                        header=text.split('\n## My request:\n',1)[0]
                        for source in re.findall(r'^## [^\n]+?: (.+)\r?$',header,re.MULTILINE):
                            if Path(source.strip()).suffix.lower() in ('.mp4','.mov'):
                                item_files.append({'kind':'video',**await asyncio.to_thread(self.source,source.strip(),owner+':'+item.get('id',''))})
                if item_files:
                    item['files']=item_files
                has_image=any(part.get('type') in ('image','localImage') for part in item.get('content',[]))
                native_paths=[]
                for part in item.get('content',[]):
                    text=part.get('text','') if part.get('type')=='text' else ''
                    if has_image and text.lstrip().startswith('# Files mentioned by the user:') and '\n## My request:\n' in text:
                        native_paths=re.findall(r'^## [^\n]+: (.+)\r?\nImage attachment: true',text.split('\n## My request:\n',1)[0],re.MULTILINE)
                image_index=0
                for part in item.get('content',[]):
                    if (has_image or item_files) and part.get('type')=='text' and part.get('text','').lstrip().startswith('# Files mentioned by the user:') and ('Image attachment: true' in part['text'] or item_files) and '\n## My request:\n' in part['text']:
                        part['text']=part['text'].split('\n## My request:\n',1)[1].lstrip('\n')
                    if part.get('type') in ('image','localImage'):
                        source=part.get('path') or part.get('url')
                        preferred=native_paths[image_index] if image_index<len(native_paths) else None
                        descriptor=await asyncio.to_thread(self.source,preferred or source,owner+':'+item.get('id',''))
                        if preferred and 'error' in descriptor:
                            descriptor=await asyncio.to_thread(self.source,source,owner+':'+item.get('id',''))
                        part['media']=descriptor
                        if isinstance(part.get('url'),str) and part['url'].startswith('data:'):
                            part.pop('url',None)
                            part['type']='localImage'
                        image_index+=1
            elif item.get('type') in ('agentMessage','plan'):
                item['media']={href:await asyncio.to_thread(self.source,href,owner+':'+item.get('id','')) for href in self.markdown_cache.get(item.get('text'),[])}
            elif item.get('type')=='imageGeneration':
                source=item.get('savedPath') or item.get('src') or item.get('result')
                if isinstance(source,str) and source and not source.startswith(('data:','https:','file:','/')) and not (len(source)>2 and source[1]==':'):
                    source='data:image/png;base64,'+source
                item['media']=await asyncio.to_thread(self.source,source,owner+':'+item.get('id',''))
                for key in ('result','src','savedPath'):
                    item.pop(key,None)
        for row in value.get('queue',[])+value.get('outbox',[]):
            row['images']=[]
            for attachment in row.get('attachments',[]):
                try:
                    image=self.public(self.get(attachment['id']))
                except ValueError:
                    image=await asyncio.to_thread(self.source,attachment.get('localPath') or attachment.get('src') or attachment.get('path'),owner)
                row['images'].append(image)
            row.pop('attachments',None)
        return value
