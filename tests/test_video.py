import asyncio
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import app
from media_store import MediaStore
from shared_queue import SharedQueue


def sample_video(folder, extension='mp4'):
    path=Path(folder)/('sample.'+extension)
    subprocess.run([shutil.which('ffmpeg'),'-v','error','-f','lavfi','-i','color=c=blue:s=80x40:r=4',
        '-t','0.5','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',str(path)],
        check=True,timeout=30,capture_output=True)
    return path.read_bytes()


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg validation tools unavailable')
class VideoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.store=MediaStore(Path(self.temp.name)/'media')

    async def asyncTearDown(self):
        self.store.db.close();self.temp.cleanup()

    async def test_original_bytes_idempotency_mixed_order_and_history_reference(self):
        for extension in ('mp4','mov'):
            data=sample_video(self.temp.name,extension);mid=str(uuid.uuid4())
            asset=self.store.ingest(data,mid,'手机录屏.'+extension)
            self.assertEqual(asset['kind'],'video');self.assertEqual((asset['width'],asset['height']),(80,40))
            self.assertEqual(Path(asset['path']).read_bytes(),data)
            self.assertEqual(asset,self.store.ingest(data,mid,'手机录屏.'+extension))
            attachment=self.store.attachments([mid])[0];self.assertEqual(attachment['kind'],'video')
            self.assertEqual(attachment['sha256'],hashlib.sha256(data).hexdigest())
            text='# Files mentioned by the user:\n\n## 手机录屏.'+extension+': '+asset['path']+'\n\n## My request:\n\n帮我看这段录屏'
            payload={'items':[{'id':'u','type':'userMessage','content':[{'type':'text','text':text}]}]}
            display=await self.store.project(payload,'thread:test')
            self.assertEqual(display['items'][0]['files'][0]['id'],mid)
            self.assertEqual(display['items'][0]['content'][0]['text'],'帮我看这段录屏')
            self.assertEqual(payload['items'][0]['content'][0]['text'],text)
            self.assertNotIn('path',self.store.public(asset))
        reopened=MediaStore(self.store.root);self.assertEqual(reopened.get(mid),asset);reopened.db.close()

    async def test_corrupt_and_audio_only_container_are_not_saved(self):
        corrupt=b'\x00\x00\x00\x18ftypisom'+b'\x00'*60
        with self.assertRaises(ValueError):self.store.ingest(corrupt,str(uuid.uuid4()),'bad.mp4')
        path=Path(self.temp.name)/'audio.mp4'
        subprocess.run([shutil.which('ffmpeg'),'-v','error','-f','lavfi','-i','sine=frequency=440','-t','0.1','-c:a','aac','-y',str(path)],check=True,capture_output=True,timeout=30)
        with self.assertRaises(ValueError):self.store.ingest(path.read_bytes(),str(uuid.uuid4()),'audio.mp4')
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM assets').fetchone()[0],0)

    async def test_video_queue_waits_for_capability_and_reconciles_lost_confirmation(self):
        asset=self.store.ingest(sample_video(self.temp.name),str(uuid.uuid4()),'clip.mp4')
        adapter=AsyncMock();calls=[];receipts=[];supported=False
        async def call(operation,tid,**params):
            if operation=='snapshot':return {'protocol':'mobile-queue-v2','threadId':tid,'imageInputs':True,'videoInputs':supported,'queue':[],'receipts':receipts,'thread':{'turns':[]}}
            calls.append(params);receipts.append({'messageId':params['messageId'],'status':'executed'});raise RuntimeError('confirmation lost')
        adapter.call.side_effect=call;queue=SharedQueue(':memory:',adapter,{'video-test':'Test'})
        mid=str(uuid.uuid4());await queue.enqueue('video-test',mid,'',attachments=self.store.attachments([asset['id']]))
        await queue.sync('video-test');self.assertEqual(calls,[]);self.assertEqual(queue.rows('video-test')[0]['status'],'waiting')
        supported=True;await queue.sync('video-test');self.assertEqual(queue.rows('video-test')[0]['status'],'needs-review')
        await queue.sync('video-test');self.assertEqual(len(calls),1);self.assertEqual(queue.rows('video-test')[0]['status'],'executed')
        await queue.close()


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg validation tools unavailable')
class VideoRoutes(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.old_media,self.old_shared=app.media,app.shared
        app.media=MediaStore(Path(self.temp.name)/'media');app.shared=SharedQueue(':memory:',AsyncMock(),{'video-test':'Test'})
        self.client=TestClient(app.app,base_url='http://127.0.0.1:8767');self.client.headers.update({'origin':'http://127.0.0.1:8767','x-mobile-client':'1'})
        self.client.post('/api/login',json={'password':app.cfg['password']})

    def tearDown(self):
        app.media.db.close();app.shared.db.close();app.media,self.old_media=self.old_media,app.media;app.shared=self.old_shared;self.temp.cleanup()

    def test_upload_recovery_content_range_and_video_only_send(self):
        data=sample_video(self.temp.name,'mov');mid=str(uuid.uuid4())
        for _ in range(2):
            response=self.client.post('/api/media/upload',data={'uploadId':mid},files={'file':('录屏.mov',data,'video/quicktime')})
            self.assertEqual(response.status_code,200,response.text)
        asset=response.json();self.assertEqual(asset['kind'],'video')
        self.assertEqual(self.client.get('/api/media/'+mid+'/status').json(),asset)
        self.assertEqual(self.client.get(asset['url']).content,data)
        partial=self.client.get(asset['url'],headers={'range':'bytes=0-15'})
        self.assertEqual(partial.status_code,206);self.assertEqual(partial.content,data[:16]);self.assertEqual(partial.headers['content-type'],'video/quicktime')
        payload={'id':str(uuid.uuid4()),'threadId':'video-test','text':'','attachments':[mid]}
        for _ in range(2):self.assertEqual(self.client.post('/api/send',json=payload).status_code,200)
        self.assertEqual(len(app.shared.rows('video-test')),1)
        self.client.cookies.clear();self.assertEqual(self.client.get(asset['url']).status_code,401)
