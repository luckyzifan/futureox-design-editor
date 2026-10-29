"""Read the requested archive incrementally; never rewrite the original."""
from pathlib import Path
import collections, hashlib, json, sys, zipfile
import ijson

source = Path('/Users/Apple/Downloads/拓扑素材.sketch')
output = Path(sys.argv[1]); output.mkdir(exist_ok=False)
counts = collections.Counter(); roots = []; examples = collections.defaultdict(list)
with zipfile.ZipFile(source) as archive:
    for part in archive.namelist():
        if not (part.startswith('pages/') and part.endswith('.json')): continue
        with archive.open(part) as stream:
            for offset, root in enumerate(ijson.items(stream, 'layers.item', use_float=True)):
                per = collections.Counter(); nodes = 0; stack = [(root, True)]
                while stack:
                    node, visible = stack.pop(); nodes += 1
                    visible = visible and node.get('isVisible', True)
                    stack.extend((child, visible) for child in node.get('layers', []))
                    style = node.get('style') or {}
                    effects = [('blur', style.get('blur'))] + [('blurs', v) for v in style.get('blurs', [])]
                    effects += [(key, v) for key in ['shadows', 'innerShadows'] for v in style.get(key, [])]
                    for family, fx in effects:
                        if not isinstance(fx, dict) or not fx.get('isEnabled', False): continue
                        kind = family if family in ['shadows', 'innerShadows'] else f'{family}:type{fx.get("type", 0)}'
                        if not visible: kind += ':hidden'
                        per[kind] += 1; counts[kind] += 1
                        if len(examples[kind]) < 12:
                            examples[kind].append({'part': part, 'rootOffset': offset, 'rootId': root.get('do_objectID'), 'rootName': root.get('name'),
                              'nodeId': node.get('do_objectID'), 'nodeName': node.get('name'), 'frame': node.get('frame'), 'effect': fx})
                row = {'part': part, 'offset': offset, 'id': root.get('do_objectID'), 'name': root.get('name'), 'nodes': nodes, 'effects': dict(per)}
                roots.append(row)
                # Keep modest real source roots with effects for local workset
                # conversion; the full-source benchmark is recorded separately.
                if per and nodes <= 3000:
                    file = f'root-{len(roots)-1}.json'
                    (output/file).write_text(json.dumps(root, ensure_ascii=False, separators=(',', ':')))
                    row['fixture'] = file
        print(part, 'roots', len(roots), 'effects', dict(counts), flush=True)
report = {'source': str(source), 'sha256': hashlib.file_digest(source.open('rb'), 'sha256').hexdigest(),
          'counts': dict(counts), 'nodes': sum(r['nodes'] for r in roots), 'roots': roots, 'examples': dict(examples), 'ijson': ijson.__version__}
(output/'inventory.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps({'output': str(output), 'nodes': report['nodes'], 'roots': len(roots), 'counts': counts}, ensure_ascii=False))
