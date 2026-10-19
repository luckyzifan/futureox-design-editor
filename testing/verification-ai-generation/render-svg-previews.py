#!/usr/bin/env python3
"""CPU-only inspection of exported SVG using installed librsvg and Cairo.

These images are not screenshots of the product renderer or browser acceptance.
No browser, networking, display server, software installation, or GPU is used.
"""
import ctypes as C
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
rsvg = C.CDLL('librsvg-2.so.2')
cairo = C.CDLL('libcairo.so.2')
gobject = C.CDLL('libgobject-2.0.so.0')
rsvg.rsvg_handle_new_from_file.argtypes = [C.c_char_p, C.c_void_p]
rsvg.rsvg_handle_new_from_file.restype = C.c_void_p
rsvg.rsvg_handle_render_cairo.argtypes = [C.c_void_p, C.c_void_p]
rsvg.rsvg_handle_render_cairo.restype = C.c_int
cairo.cairo_image_surface_create.argtypes = [C.c_int, C.c_int, C.c_int]
cairo.cairo_image_surface_create.restype = C.c_void_p
cairo.cairo_create.argtypes = [C.c_void_p]
cairo.cairo_create.restype = C.c_void_p
cairo.cairo_surface_write_to_png.argtypes = [C.c_void_p, C.c_char_p]
cairo.cairo_surface_write_to_png.restype = C.c_int
cairo.cairo_destroy.argtypes = [C.c_void_p]
cairo.cairo_surface_destroy.argtypes = [C.c_void_p]
gobject.g_object_unref.argtypes = [C.c_void_p]
results = []
for page in ['workspace', 'files', 'settings']:
    source = root / page / 'design.svg'
    output = root / page / 'cpu-svg-preview.png'
    handle = rsvg.rsvg_handle_new_from_file(str(source).encode(), None)
    if not handle:
        raise RuntimeError(f'Cannot read {source}')
    surface = cairo.cairo_image_surface_create(0, 1440, 1000)
    context = cairo.cairo_create(surface)
    try:
        if not rsvg.rsvg_handle_render_cairo(handle, context):
            raise RuntimeError(f'Cannot render {source}')
        if cairo.cairo_surface_write_to_png(surface, str(output).encode()) != 0:
            raise RuntimeError(f'Cannot save {output}')
    finally:
        cairo.cairo_destroy(context)
        cairo.cairo_surface_destroy(surface)
        gobject.g_object_unref(handle)
    results.append({'page': page, 'source': f'{page}/design.svg', 'output': f'{page}/cpu-svg-preview.png', 'width': 1440, 'height': 1000,
                    'sha256': hashlib.sha256(output.read_bytes()).hexdigest()})
report = {'renderer': 'Installed librsvg + Cairo, CPU only', 'browserRun': False, 'productRendererScreenshot': False, 'gpuRun': False, 'results': results}
(root / 'cpu-preview-provenance.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
