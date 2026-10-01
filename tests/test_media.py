import asyncio
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock
from PIL import Image
from fastapi.testclient import TestClient
import app
from media_store import MediaStore, MAX_FILE
from shared_queue import SharedQueue


def picture(color='red',fmt='PNG',size=(80,40),**options):
    output=io.BytesIO()
    Image.new('RGBA' if fmt=='PNG' else 'RGB',size,color).save(output,format=fmt,**options)
    return output.getvalue()


class MediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=MediaStore(Path(self.temp.name)/'media',shutil.which('node'))

    async def asyncTearDown(self):
        self.store.db.close();self.temp.cleanup()

    async def test_upload_identity_restart_original_alpha_and_no_resize(self):
        data=picture(size=(1400,900));mid=str(uuid.uuid4())
        first=self.store.ingest(data,mid,'a.png')
        self.assertEqual(first,self.store.ingest(data,mid,'a.png'))
        self.assertEqual(Path(first['path']).read_bytes(),data)
        self.assertEqual((first['width'],first['height']),(1400,900))
        with Image.open(first['thumbPath']) as image:self.assertEqual(image.mode,'RGBA');self.assertLessEqual(max(image.size),640)
        with self.assertRaisesRegex(ValueError,'另一张'):self.store.ingest(picture('blue'),mid)
        again=MediaStore(self.store.root)
        self.assertEqual(again.get(mid),first);again.db.close()

    async def test_heic_rotation_and_gif_first_frame(self):
        heic=picture(fmt='HEIF',size=(60,30))
        value=self.store.ingest(heic,str(uuid.uuid4()),'photo.heic')
        self.assertEqual(value['mime'],'image/jpeg');self.assertEqual((value['width'],value['height']),(60,30))
        exif=Image.Exif();exif[274]=6
        rotated=self.store.ingest(picture(fmt='JPEG',size=(80,40),exif=exif),str(uuid.uuid4()))
        self.assertEqual((rotated['width'],rotated['height']),(40,80))
        output=io.BytesIO();Image.new('RGB',(20,20),'red').save(output,format='GIF',save_all=True,append_images=[Image.new('RGB',(20,20),'blue')])
        gif=self.store.ingest(output.getvalue(),str(uuid.uuid4()))
        with Image.open(gif['path']) as image:self.assertEqual(image.n_frames,1)

    async def test_invalid_content_ids_count_and_size_are_rejected(self):
        for data in (b'<svg><script>evil</script></svg>',b'not an image',b'x'*(MAX_FILE+1)):
            with self.assertRaises(ValueError):self.store.ingest(data,str(uuid.uuid4()))
        with self.assertRaises(ValueError):self.store.ingest(picture(),'../escape')
        with self.assertRaises(ValueError):self.store.attachments([str(uuid.uuid4())]*11)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM assets').fetchone()[0],0)

    async def test_only_parsed_history_references_copy_and_survive_source_deletion(self):
        source=Path(self.temp.name)/'original image.png';source.write_bytes(picture())
        body=f'![绘图](<{source.as_posix()}>)\n\n```text\n![not media](C:/secret.png)\n```'
        payload={'thread':{'turns':[{'items':[{'id':'a','type':'agentMessage','text':body},{'id':'g','type':'imageGeneration','savedPath':str(source),'result':'private bytes'}]}]}}
        projected=await self.store.project(payload,'thread:one')
        items=projected['thread']['turns'][0]['items'];self.assertEqual(len(items[0]['media']),1)
        descriptor=items[0]['media'][source.as_posix()];self.assertIn('/api/media/',descriptor['url']);self.assertNotIn('path',descriptor)
        self.assertNotIn('result',items[1]);self.assertNotIn('savedPath',items[1]);source.unlink()
        again=await self.store.project(payload,'thread:one');self.assertEqual(again['thread']['turns'][0]['items'][0]['media'],items[0]['media'])
        self.assertEqual(payload['thread']['turns'][0]['items'][1]['result'],'private bytes')

    async def test_missing_external_and_changed_path_in_another_message(self):
        self.assertIn('error',self.store.source('C:/not-existent/photo.png','a'))
        self.assertEqual(self.store.source('https://example.com/image.png','a')['external'],True)
        source=Path(self.temp.name)/'same.png';source.write_bytes(picture('red'))
        a=self.store.source(str(source),'message:a');source.write_bytes(picture('blue'))
        b=self.store.source(str(source),'message:b');self.assertNotEqual(a['id'],b['id'])
        self.assertEqual(self.store.source(str(source),'message:a')['id'],a['id'])

    async def test_native_image_wrapper_is_only_removed_from_public_display(self):
        value=self.store.ingest(picture(),str(uuid.uuid4()),'手机图片.png')
        text='\n# Files mentioned by the user:\n\n## 手机图片.png: '+value['path']+'\nImage attachment: true\n\n## My request:\n\n'
        payload={'items':[{'id':'u','type':'userMessage','content':[{'type':'text','text':text},{'type':'image','url':'data:image/png;base64,aGVsbG8='}]}]}
        display=await self.store.project(payload,'thread:test');parts=display['items'][0]['content']
        self.assertEqual(parts[0]['text'],'');self.assertEqual(payload['items'][0]['content'][0]['text'],text)
        self.assertEqual(parts[1]['media']['id'],value['id']);self.assertEqual(parts[1]['media']['name'],'手机图片.png')
        self.assertNotIn('url',parts[1]);self.assertNotIn('aGVsbG8=',json.dumps(display))

    async def test_referenced_files_survive_cleanup_and_orphans_expire(self):
        a=self.store.ingest(picture(),str(uuid.uuid4()));b=self.store.ingest(picture('blue'),str(uuid.uuid4()))
        self.store.bind('waiting-message',[a['id']]);self.store.db.execute('UPDATE assets SET touched=0');self.store.db.commit();self.store.cleanup()
        self.assertTrue(Path(a['path']).exists())
        with self.assertRaises(ValueError):self.store.get(b['id'])


class MediaRoutes(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.old_media,self.old_shared=app.media,app.shared
        app.media=MediaStore(Path(self.temp.name)/'media',shutil.which('node'));app.shared=SharedQueue(':memory:',AsyncMock(),{'shared-test':'Test'})
        self.client=TestClient(app.app,base_url='http://127.0.0.1:8767')
        self.client.headers.update({'origin':'http://127.0.0.1:8767','x-mobile-client':'1'})
        self.client.post('/api/login',json={'password':app.cfg['password']})

    def tearDown(self):
        app.media.db.close();app.shared.db.close();app.media,self.old_media=self.old_media,app.media;app.shared=self.old_shared;self.temp.cleanup()

    def upload(self,data=None,mid=None):
        return self.client.post('/api/media/upload',data={'uploadId':mid or str(uuid.uuid4())},files={'file':('photo.png',data or picture(),'image/png')})

    def test_upload_content_requires_login_and_cannot_choose_paths(self):
        response=self.upload();self.assertEqual(response.status_code,200,response.text);value=response.json()
        self.assertNotIn('path',value);self.assertEqual(self.client.get(value['url']).status_code,200)
        self.assertEqual(self.client.get('/api/media/../../config.json/content').status_code,404)
        self.client.cookies.clear();self.assertEqual(self.client.get(value['url']).status_code,401);self.assertEqual(self.upload().status_code,401)

    def test_image_only_message_is_persisted_once_and_changed_attachment_rejected(self):
        image=self.upload().json();mid=str(uuid.uuid4())
        payload={'id':mid,'threadId':'shared-test','text':'','attachments':[image['id']]}
        for _ in range(2):self.assertEqual(self.client.post('/api/send',json=payload).status_code,200)
        rows=app.shared.rows('shared-test');self.assertEqual(len(rows),1);self.assertEqual(rows[0]['attachments'][0]['id'],image['id'])
        image2=self.upload(picture('blue')).json();payload['attachments']=[image2['id']]
        self.assertEqual(self.client.post('/api/send',json=payload).status_code,409)
        payload['id']=str(uuid.uuid4());payload['attachments']=['C:/fake.png'];self.assertEqual(self.client.post('/api/send',json=payload).status_code,400)


class ImageQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_desktop_waits_then_confirmation_loss_reconciles_without_duplicate(self):
        adapter=AsyncMock();receipts=[];calls=[];supported=False
        async def call(operation,tid,**params):
            if operation=='snapshot':return {'protocol':'mobile-queue-v2','threadId':tid,'imageInputs':supported,'queue':[],'receipts':receipts,'thread':{'turns':[]}}
            calls.append(params);receipts.append({'messageId':params['messageId'],'status':'executed'});raise RuntimeError('confirmation lost')
        adapter.call.side_effect=call;queue=SharedQueue(':memory:',adapter,{'test':'Test'})
        images=[{'id':str(uuid.uuid4()),'localPath':'managed.png','sha256':'a'*64}];mid=str(uuid.uuid4())
        await queue.enqueue('test',mid,'',attachments=images);await queue.sync('test');self.assertEqual(calls,[]);self.assertEqual(queue.rows('test')[0]['status'],'waiting')
        supported=True;await queue.sync('test');self.assertEqual(calls[0]['attachments'],images);self.assertEqual(queue.rows('test')[0]['status'],'needs-review')
        await queue.sync('test');self.assertEqual(len(calls),1);self.assertEqual(queue.rows('test')[0]['status'],'executed');await queue.close()
