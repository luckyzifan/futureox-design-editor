import importlib.util
from pathlib import Path
import unittest
import tempfile
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('build_web', Path(__file__).with_name('build-web.py'))
build_web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_web)


def leb(value):
    out = bytearray()
    while True:
        byte = value & 127
        value >>= 7
        out.append(byte | (128 if value else 0))
        if not value:
            return bytes(out)


def section(kind, payload):
    return bytes([kind]) + leb(len(payload)) + payload


def custom(name, payload):
    return section(0, leb(len(name)) + name + payload)


class BuildWebTests(unittest.TestCase):
    def test_only_optional_names_removed(self):
        header = b'\0asm\1\0\0\0'
        kept = [section(1, b'\0'), section(7, b'\0'), custom(b'target_features', b'features'),
                custom(b'producers', b'compiler'), section(11, bytes(range(256)) * 3)]
        source = header + kept[0] + custom(b'name', b'function names' * 30) + b''.join(kept[1:])
        self.assertEqual(build_web.strip_names(source), header + b''.join(kept))
        self.assertEqual(build_web.strip_names(header + b''.join(kept)), header + b''.join(kept))

    def test_malformed_input_is_not_published(self):
        for source in [b'', b'\0asm\1\0\0\0\0', b'\0asm\1\0\0\0\0\5\6name',
                       b'\0asm\1\0\0\0\1\xff\xff\xff\xff\xff']:
            with self.assertRaises(ValueError):
                build_web.strip_names(source)

    def test_simd_keeps_existing_flags_and_never_enables_relaxed_math(self):
        source = {'RUSTFLAGS': '-C opt-level=3 --cfg \'name="a b"\''}
        env = build_web.build_environment(True, source)
        flags = env['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')
        self.assertEqual(flags, ['-C', 'opt-level=3', '--cfg', 'name="a b"', '-C', 'target-feature=+simd128'])
        self.assertIn('RUSTFLAGS', source)
        self.assertNotIn('RUSTFLAGS', env)
        self.assertNotIn('relaxed-simd', env['CARGO_ENCODED_RUSTFLAGS'])
        self.assertEqual(build_web.build_environment(False, source), source)
        encoded = {'CARGO_ENCODED_RUSTFLAGS': '-C\x1fdebuginfo=0', 'RUSTFLAGS': 'ignored'}
        self.assertTrue(build_web.build_environment(True, encoded)['CARGO_ENCODED_RUSTFLAGS'].startswith('-C\x1fdebuginfo=0\x1f'))

    def test_experimental_flags_cannot_overwrite_live_assets(self):
        for simd, optimizer in [(True, False), (False, True)]:
            with patch.object(build_web.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    build_web.build(SimpleNamespace(simd=simd, wasm_opt=optimizer, output_dir=None))
                run.assert_not_called()

    def test_optimizer_failure_leaves_existing_output_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / 'design_kernel_bg.wasm').write_bytes(b'previous')
            def run(command, **_):
                if command[0] == 'binder':
                    staged = Path(command[command.index('--out-dir') + 1])
                    (staged / 'design_kernel_bg.wasm').write_bytes(b'\0asm\1\0\0\0')
                elif command[0] == 'optimizer':
                    raise subprocess.CalledProcessError(1, command)
            args = SimpleNamespace(simd=False, wasm_opt=True, output_dir=output, profile='release', keep_names=False)
            with patch.object(build_web, '_tool', side_effect=['binder', 'optimizer']), patch.object(build_web.subprocess, 'run', side_effect=run):
                with self.assertRaises(subprocess.CalledProcessError):
                    build_web.build(args)
            self.assertEqual((output / 'design_kernel_bg.wasm').read_bytes(), b'previous')

    def test_successful_isolated_build_strips_names_after_binding_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            wasm = b'\0asm\1\0\0\0' + custom(b'name', b'labels') + custom(b'producers', b'compiler')
            def run(command, **_):
                if command[0] == 'binder':
                    staged = Path(command[command.index('--out-dir') + 1])
                    for name in ['design_kernel.js', 'design_kernel.d.ts', 'design_kernel_bg.wasm.d.ts']:
                        (staged / name).write_text('binding')
                    (staged / 'design_kernel_bg.wasm').write_bytes(wasm)
            args = SimpleNamespace(simd=False, wasm_opt=False, output_dir=output, profile='release', keep_names=False)
            with patch.object(build_web, '_tool', return_value='binder'), patch.object(build_web.subprocess, 'run', side_effect=run):
                result = build_web.build(args)
            self.assertEqual((output / 'design_kernel.js').read_text(), 'binding')
            self.assertEqual((output / 'design_kernel_bg.wasm').read_bytes(), build_web.strip_names(wasm))
            self.assertLess(result['bytes'], result['originalBytes'])


if __name__ == '__main__':
    unittest.main()
