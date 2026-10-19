#!/usr/bin/env python3
"""Build the portable kernel; SIMD/wasm-opt experiments use isolated output."""
import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def _uleb(data, offset):
    value = 0
    for shift in range(0, 35, 7):
        if offset >= len(data):
            raise ValueError('Truncated WebAssembly section length')
        byte = data[offset]
        offset += 1
        if shift == 28 and byte > 15:
            raise ValueError('Invalid WebAssembly u32 length')
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError('Invalid WebAssembly section length')


def strip_names(data):
    """Remove only the optional name section; code/data/exports stay byte exact."""
    if data[:8] != b'\0asm\1\0\0\0':
        raise ValueError('Invalid WebAssembly header')
    output = bytearray(data[:8])
    offset = 8
    while offset < len(data):
        start = offset
        kind = data[offset]
        length, payload = _uleb(data, offset + 1)
        end = payload + length
        if end > len(data):
            raise ValueError('Truncated WebAssembly section')
        name = None
        if kind == 0:
            size, text = _uleb(data, payload)
            if text + size > end:
                raise ValueError('Invalid WebAssembly custom section')
            name = data[text:text + size]
        if name != b'name':
            output.extend(data[start:end])
        offset = end
    return bytes(output)


def build_environment(simd, source=None):
    env = dict(os.environ if source is None else source)
    if simd:
        flags = (env['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')
                 if env.get('CARGO_ENCODED_RUSTFLAGS') else shlex.split(env.get('RUSTFLAGS', '')))
        flags += ['-C', 'target-feature=+simd128']
        env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(flags)
        env.pop('RUSTFLAGS', None)
    return env


def _tool(variable, name, fallback=None):
    value = os.environ.get(variable) or shutil.which(name) or fallback
    if not value or not Path(value).is_file():
        raise RuntimeError(f'{name} is required; configure {variable} with its executable path')
    return str(value)


def _atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.', delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def build(args):
    if (args.simd or args.wasm_opt) and args.output_dir is None:
        raise ValueError('SIMD and wasm-opt experiments require --output-dir; portable assets are not overwritten')
    binder = _tool('WASM_BINDGEN', 'wasm-bindgen', str(ROOT / '.local/design-tools/bin/wasm-bindgen'))
    optimizer = _tool('WASM_OPT', 'wasm-opt') if args.wasm_opt else None
    env = build_environment(args.simd)
    target = Path(env['CARGO_TARGET_DIR']).resolve() if env.get('CARGO_TARGET_DIR') else ROOT / 'design-studio/target'
    profile_dir = 'debug' if args.profile == 'dev' else args.profile
    subprocess.run(['cargo', 'build', '--locked', '--profile', args.profile,
                    '--manifest-path', str(ROOT / 'design-studio/Cargo.toml'),
                    '-p', 'futureox-design-kernel', '--lib', '--target', 'wasm32-unknown-unknown'], check=True, env=env)
    with tempfile.TemporaryDirectory(prefix='design-kernel-bindings-') as directory:
        staged = Path(directory)
        subprocess.run([binder, str(target / 'wasm32-unknown-unknown' / profile_dir / 'futureox_design_kernel.wasm'),
                        '--target', 'web', '--out-dir', str(staged), '--out-name', 'design_kernel'], check=True)
        wasm = staged / 'design_kernel_bg.wasm'
        if optimizer:
            optimized = staged / 'optimized.wasm'
            command = [optimizer, str(wasm), '-O2', '-o', str(optimized)]
            if args.simd:
                command.append('--enable-simd')
            subprocess.run(command, check=True)
            wasm.write_bytes(optimized.read_bytes())
        original_bytes = wasm.stat().st_size
        if not args.keep_names:
            wasm.write_bytes(strip_names(wasm.read_bytes()))
        output = args.output_dir or ROOT / 'frontend/design-client/src/generated/design-kernel'
        contents = {name: (staged / name).read_bytes() for name in
                    ['design_kernel.js', 'design_kernel.d.ts', 'design_kernel_bg.wasm.d.ts', 'design_kernel_bg.wasm']}
        for name, data in contents.items():
            _atomic_write(output / name, data)
        if args.output_dir is None:
            public = ROOT / 'frontend/design-client/public/kernel'
            _atomic_write(public / 'design_kernel_bg.wasm', wasm.read_bytes())
            for name in ['design_kernel.js', 'design_kernel.d.ts', 'design_kernel_bg.wasm.d.ts']:
                (public / name).unlink(missing_ok=True)
        return {'profile': args.profile, 'simd': args.simd, 'wasmOpt': bool(optimizer),
                'originalBytes': original_bytes, 'bytes': wasm.stat().st_size, 'output': str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='release')
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--simd', action='store_true', help='Standard simd128 only; isolated output required')
    parser.add_argument('--wasm-opt', action='store_true', help='Run installed wasm-opt -O2; isolated output required')
    parser.add_argument('--keep-names', action='store_true', help='Retain function names for profiling')
    result = build(parser.parse_args())
    print(f"Kernel built: {result}")


if __name__ == '__main__':
    main()
