"""Unknown desktop bytes must never reach the compatibility transformations."""
import unittest

from desktop_bridge.lab_patch import MAIN, patch_sources
from desktop_bridge.lab_patch_928 import MAIN as NEW_MAIN


class UnknownArchive:
    def __init__(self, main):
        self.entries = {main: {}}
        self.reads = []

    def read(self, name):
        self.reads.append(name)
        return b'changed or unsupported desktop source'


class DesktopPatchTests(unittest.TestCase):
    def test_modified_old_and_new_desktops_fail_before_patching(self):
        for main in (MAIN, NEW_MAIN):
            with self.subTest(main=main):
                archive = UnknownArchive(main)
                with self.assertRaisesRegex(ValueError, 'Unsupported desktop build'):
                    patch_sources(archive, shared=True)
                self.assertEqual(archive.reads, [main])

    def test_invalid_thread_cannot_bypass_new_profile_validation(self):
        archive = UnknownArchive(NEW_MAIN)
        with self.assertRaisesRegex(ValueError, 'Invalid test conversation ID'):
            patch_sources(archive, '../other-thread', all_local=True)
        self.assertEqual(archive.reads, [])


if __name__ == '__main__':
    unittest.main()
