import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('compare_figma', Path(__file__).with_name('compare-figma.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NativeReuseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='figma-report-test-')
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.old, self.new, self.rgba = (root / p for p in ('old.json','new.json','cpu.rgba'))
        self.old.write_text(json.dumps({'document':{'radius':1.99},'options':{'width':1}}))
        self.new.write_bytes(self.old.read_bytes())
        self.rgba.write_bytes(bytes([1,2,3,255]))
        self.report = {'nativeBinarySha256':'binary','executions':[{
            'profile':'figma','case':'probe','backend':'rust-cpu','exit':0,
            'command':['renderer','--input',str(self.old),'--rgba',str(self.rgba),'--backend','cpu','--repeat','1']}],
            'rows':[{'profile':'figma','case':'probe','backend':'rust-cpu',
                     'sha256':hashlib.sha256(self.rgba.read_bytes()).hexdigest()}]}

    def reuse(self, report=None, binary='binary', repeat=1):
        return module.verified_native_reuse(report or self.report,binary,self.new,'figma','probe','rust-cpu',repeat)

    def test_exact_successful_evidence_reuses(self):
        self.assertEqual(self.reuse()[1],self.rgba)

    def test_changed_input_binary_or_repeat_requires_execution(self):
        self.assertIsNone(self.reuse(binary='different'))
        self.assertIsNone(self.reuse(repeat=2))
        self.new.write_text(json.dumps({'document':{'radius':1.9900000095367432},'options':{'width':1}}))
        self.assertIsNone(self.reuse())

    def test_failed_run_and_wrong_driver_cannot_reuse(self):
        report = copy.deepcopy(self.report)
        report['executions'][0]['exit'] = 1
        self.assertIsNone(self.reuse(report))
        report = copy.deepcopy(self.report)
        report['executions'][0]['command'][-3] = 'metal'
        self.assertIsNone(self.reuse(report))

    def test_corrupt_or_ambiguous_matching_evidence_fails_closed(self):
        self.rgba.write_bytes(bytes([0,0,0,0]))
        with self.assertRaises(ValueError):
            self.reuse()
        report = copy.deepcopy(self.report)
        report['executions'].append(report['executions'][0])
        with self.assertRaises(ValueError):
            self.reuse(report)


if __name__ == '__main__':
    unittest.main()
