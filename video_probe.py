"""Validate local MP4/MOV containers without transcoding or extracting frames."""
import json
import math
import os
import shutil
import subprocess

MAX_VIDEO = 100 * 1024 * 1024


def video_container(data):
    return (len(data) >= 16 and data[4:8] == b'ftyp'
            and data[8:12] in (b'qt  ', b'isom', b'iso2', b'iso4', b'iso5', b'iso6',
                              b'mp41', b'mp42', b'avc1', b'M4V ', b'M4VH', b'MSNV', b'dash'))


def probe_video(path):
    executable = shutil.which('ffprobe')
    if not executable:
        raise ValueError('电脑视频校验工具暂不可用，视频尚未上传成功')
    try:
        result = subprocess.run([executable, '-v', 'error', '-protocol_whitelist', 'file',
            '-show_entries', 'format=format_name,duration:stream=codec_type,width,height',
            '-of', 'json', str(path)], capture_output=True, timeout=30,
            creationflags=0x08000000 if os.name == 'nt' else 0, check=True)
        info = json.loads(result.stdout)
        streams = [stream for stream in info.get('streams', []) if stream.get('codec_type') == 'video']
        if 'mov' not in info.get('format', {}).get('format_name', '').split(',') or not streams:
            raise ValueError()
        width, height = int(streams[0]['width']), int(streams[0]['height'])
        duration = float(info.get('format', {}).get('duration', 0))
        if width <= 0 or height <= 0 or not math.isfinite(duration) or duration <= 0:
            raise ValueError()
        return {'width': width, 'height': height, 'duration': duration}
    except Exception:
        raise ValueError('视频损坏或格式不支持，请选择有效的 MP4 或 MOV 视频') from None
