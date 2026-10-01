import json
from pathlib import Path
import struct
import tempfile
import unittest

from desktop_bridge.inspection import AsarArchive, inspect_desktop


def make_archive(path, source):
    data = source.encode()
    tree = {'files': {'.vite': {'files': {'build': {'files': {
        'main-test.js': {'offset': '0', 'size': len(data)}
    }}}}}}
    header = json.dumps(tree).encode()
    path.write_bytes(struct.pack('<4I', 4, len(header) + 8, len(header) + 4, len(header)) + header + data)


class DesktopInspectionTests(unittest.TestCase):
    def test_replacement_interface_never_enables_submission(self):
        source = 'var versions={"thread-owner-discovery":1,"thread-follower-set-queued-follow-ups-state":1};acceptFromFollower=async(e,t)=>{await this.#h(e,()=>t,!0)}'
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'app.asar'
            make_archive(archive, source)
            result = inspect_desktop(archive)
        self.assertEqual(result['gate'], 'blocked_unsafe_queue_replacement')
        self.assertTrue(result['capabilities']['ownerDiscoveryDeclared'])
        self.assertFalse(result['sharedSubmissionEnabled'])
        self.assertFalse(result['capabilities']['singleAppendVerified'])

    def test_unknown_version_and_new_method_name_require_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'app.asar'
            make_archive(archive, 'var versions={"thread-follower-append-message":1};')
            result = inspect_desktop(archive)
        self.assertEqual(result['gate'], 'unverified_desktop_version')
        self.assertFalse(result['sharedSubmissionEnabled'])

    def test_archive_reader_does_not_change_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'app.asar'
            make_archive(archive, 'const value=1;')
            before = archive.read_bytes()
            self.assertEqual(AsarArchive(archive).read('.vite/build/main-test.js'), b'const value=1;')
            self.assertEqual(archive.read_bytes(), before)

    def test_native_queue_add_does_not_prove_an_external_owner_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'app.asar'
            make_archive(archive, 'sendRequest(`thread/queue/add`,{threadId:id});')
            result = inspect_desktop(archive)
        self.assertTrue(result['capabilities']['nativeServerQueueAddDeclared'])
        self.assertFalse(result['capabilities']['singleAppendVerified'])
        self.assertFalse(result['sharedSubmissionEnabled'])

    def test_truncated_and_out_of_bounds_archives_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'app.asar'
            archive.write_bytes(b'invalid')
            with self.assertRaises(ValueError):
                AsarArchive(archive)
            make_archive(archive, 'code')
            reader = AsarArchive(archive)
            reader.entries['.vite/build/main-test.js']['offset'] = '-1'
            with self.assertRaises(ValueError):
                reader.read('.vite/build/main-test.js')


if __name__ == '__main__':
    unittest.main()
