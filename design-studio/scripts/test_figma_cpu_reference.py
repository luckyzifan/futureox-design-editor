import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

spec = importlib.util.spec_from_file_location(
    'figma_cpu_reference', Path(__file__).with_name('check-figma-cpu-reference.py'))
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


class StrictReferenceTests(unittest.TestCase):
    def test_a_single_rgb_or_alpha_byte_difference_fails_exact_comparison(self):
        expected = bytes([128, 128, 128, 255] * 2)
        self.assertEqual(reference.difference(expected, expected)['differentPixels'], 0)
        for channel in range(len(expected)):
            changed = bytearray(expected)
            changed[channel] -= 1
            self.assertEqual(reference.difference(changed, expected), {
                'differentPixels': 1, 'differentChannels': 1, 'maxChannelError': 1,
            })

    def test_truncated_or_differently_sized_rgba_is_not_accepted(self):
        for actual, expected in [(b'', b''), (b'123', b'123'), (b'1234', b'12345678')]:
            with self.assertRaises(ValueError):
                reference.difference(actual, expected)

    def test_empty_duplicate_changed_or_wrong_size_references_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix='forma-reference-test-') as directory:
            root = Path(directory)
            png = root / 'reference.png'
            Image.new('RGBA', (1, 1), (128, 128, 128, 255)).save(png)
            case = {'id': 'control', 'reference': png.name,
                    'referenceSha256': hashlib.sha256(png.read_bytes()).hexdigest(),
                    'options': {'width': 1, 'height': 1}}
            manifest = root / 'cases.json'
            manifest.write_text(json.dumps([case]))
            self.assertEqual(reference.references(root), [case])
            for cases in [[], [case, case], [{**case, 'referenceSha256': 'changed'}],
                          [{**case, 'options': {'width': 2, 'height': 1}}]]:
                manifest.write_text(json.dumps(cases))
                with self.assertRaises(ValueError):
                    reference.references(root)

    def test_reference_cannot_escape_its_declared_directory(self):
        with tempfile.TemporaryDirectory(prefix='forma-reference-test-') as directory:
            root = Path(directory)
            (root / 'cases.json').write_text(json.dumps([
                {'id': 'control', 'reference': '../outside.png'}]))
            with self.assertRaisesRegex(ValueError, 'outside'):
                reference.references(root)

    def test_startup_failure_cannot_leave_a_previous_green_report(self):
        with tempfile.TemporaryDirectory(prefix='forma-reference-test-') as directory:
            root = Path(directory)
            report = root / 'results.json'
            report.write_text('{"strictParityPassed":true}')
            args = ['check', '--references', str(root / 'missing'), '--native-binary',
                    str(root / 'missing-renderer'), '--output', str(root)]
            with patch('sys.argv', args), self.assertRaises(FileNotFoundError):
                reference.main()
            self.assertFalse(report.exists())


if __name__ == '__main__':
    unittest.main()
