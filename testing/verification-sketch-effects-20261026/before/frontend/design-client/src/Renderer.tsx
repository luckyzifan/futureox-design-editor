import { color_controls_matrix } from './generated/design-kernel/design_kernel'
import { expandRepeats } from './repeat-transforms'
import { EditableSvgText } from './svg-editable-text'
import { kernelTextLayout, kernelStrokePaths, kernelSvgPaths } from './kernel/picking'
import React, { useMemo, useRef } from 'react'
import { maskChild } from './model'
import type { DesignDocument, DesignNode, Paint, Effect, Matrix, Bounds, Point } from './model'
import {
  shapeD as approximateShapeD,
  matrixString,
  worldMatrix,
  inverse,
  scene,
  intersects,
  allParents,
} from './geometry'
function shapeD(n: DesignNode, fill = false) {
  const paths = kernelSvgPaths(n)
  return paths ? (fill ? paths.fill : paths.stroke) : approximateShapeD(n, fill)
}
function cssBlend(mode: DesignNode['blend']): React.CSSProperties['mixBlendMode'] {
  if (mode === 'linear-burn' || mode === 'linear-dodge')
    throw new Error('线性加深/减淡需要内核渲染，请导出 PNG')
  return mode === 'pass-through' ? 'normal' : mode
}
// Preserve the existing document's normalized projection. Moving the SVG
// endpoints, instead of changing the rasterizer, keeps old PNGs unchanged.
export function gradientLine(angle: number) {
  const radians = (angle * Math.PI) / 180,
    x = Math.cos(radians),
    y = Math.sin(radians)
  const half = (Math.abs(x) + Math.abs(y)) / 2
  return { x1: 0.5 - x * half, y1: 0.5 - y * half, x2: 0.5 + x * half, y2: 0.5 + y * half }
}
function Color({ paint: p, id, n }: { paint: Paint; id: string; n: DesignNode }) {
  if (p.kind === 'linear')
    return (
      <linearGradient id={id} {...(p.transform?{x1:0,y1:0,x2:1,y2:0}:gradientLine(p.angle))} gradientTransform={p.transform?matrixString(p.transform):undefined} colorInterpolation="sRGB">
        {p.stops.map((s, i) => (
          <stop key={i} offset={s.offset} stopColor={s.color} />
        ))}
      </linearGradient>
    )
  if (p.kind === 'radial')
    return (
      <radialGradient id={id} gradientTransform={p.transform?matrixString(p.transform):undefined}>
        {p.stops.map((s, i) => (
          <stop key={i} offset={s.offset} stopColor={s.color} />
        ))}
      </radialGradient>
    )
  if (p.kind === 'image')
    return (
      <pattern id={id} patternUnits="userSpaceOnUse" width={n.width} height={n.height}>
        <image
          href={p.image}
          width={n.width}
          height={n.height}
          preserveAspectRatio={
            p.fit === 'stretch' ? 'none' : p.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'
          }
        />
      </pattern>
    )
  return null
}
const color = (p: Paint, id: string) => (p.kind === 'solid' ? p.color : `url(#${id})`)
function colorControlValues(controls: NonNullable<Effect['colorControls']>) {
  const m = color_controls_matrix(JSON.stringify(controls))
  return [m[0],m[1],m[2],0,m[3],m[4],m[5],m[6],0,m[7],m[8],m[9],m[10],0,m[11],0,0,0,1,0].join(' ')
}
function Filter({ id, effects }: { id: string; effects: Effect[] }) {
  let input = 'SourceGraphic'
  const children: React.ReactNode[] = []
  for (const [i, e] of effects
    .filter((e) => e.visible && !['background-blur', 'glass'].includes(e.kind))
    .entries()) {
    const out = `fx${i}`,
      alpha = `a${i}`
    if (e.kind === 'color-controls' && e.colorControls)
      children.push(<feColorMatrix key={i} in={input} type="matrix" colorInterpolationFilters={e.colorControls.space ? "sRGB" : "linearRGB"} values={colorControlValues(e.colorControls)} result={out} />)
    else if (e.kind === 'blur')
      children.push(
        <feGaussianBlur key={i} in={input} stdDeviation={Math.max(0, e.radius) / 2} result={out} />,
      )
    else if (e.kind === 'shadow' || e.kind === 'inner-shadow') {
      children.push(
        <feColorMatrix
          key={`${i}a`}
          in={input}
          type="matrix"
          values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"
          result={alpha}
        />,
      )
      let shadow = alpha
      if (e.spread !== 0) {
        children.push(
          <feMorphology
            key={`${i}m`}
            in={alpha}
            operator={e.spread > 0 ? 'dilate' : 'erode'}
            radius={Math.abs(e.spread)}
            result={`${out}spread`}
          />,
        )
        shadow = `${out}spread`
      }
      children.push(
        <feGaussianBlur
          key={`${i}b`}
          in={shadow}
          stdDeviation={Math.max(0, e.radius) / 2}
          result={`${out}blur`}
        />,
        <feOffset key={`${i}o`} in={`${out}blur`} dx={e.x} dy={e.y} result={`${out}offset`} />,
      )
      if (e.kind === 'inner-shadow')
        children.push(
          <feComposite
            key={`${i}cut`}
            in={alpha}
            in2={`${out}offset`}
            operator="out"
            result={`${out}mask`}
          />,
        )
      children.push(
        <feFlood
          key={`${i}f`}
          floodColor={e.color}
          floodOpacity={e.opacity}
          result={`${out}color`}
        />,
        <feComposite
          key={`${i}c`}
          in={`${out}color`}
          in2={e.kind === 'inner-shadow' ? `${out}mask` : `${out}offset`}
          operator="in"
          result={`${out}shadow`}
        />,
      )
      children.push(
        <feMerge key={i} result={out}>
          {(e.kind === 'inner-shadow' ? [input, `${out}shadow`] : [`${out}shadow`, input]).map(
            (v) => (
              <feMergeNode key={v} in={v} />
            ),
          )}
        </feMerge>,
      )
    } else if (e.kind === 'noise')
      children.push(
        <feTurbulence
          key={`${i}n`}
          type="fractalNoise"
          baseFrequency={Math.max(0.005, e.amount)}
          numOctaves={3}
          seed={7}
          result={`${out}noise`}
        />,
        <feColorMatrix
          key={`${i}nc`}
          in={`${out}noise`}
          type="saturate"
          values="0"
          result={`${out}gray`}
        />,
        <feComponentTransfer key={`${i}na`} in={`${out}gray`} result={`${out}opacity`}>
          <feFuncA type="linear" slope={e.opacity} />
        </feComponentTransfer>,
        <feComposite
          key={`${i}clip`}
          in={`${out}opacity`}
          in2={input}
          operator="in"
          result={`${out}masked`}
        />,
        <feBlend key={i} in={`${out}masked`} in2={input} mode="soft-light" result={out} />,
      )
    else if (e.kind === 'texture')
      children.push(
        <feTurbulence
          key={`${i}t`}
          type="fractalNoise"
          baseFrequency=".08"
          numOctaves={3}
          seed={13}
          result={`${out}noise`}
        />,
        <feDisplacementMap
          key={i}
          in={input}
          in2={`${out}noise`}
          scale={Math.max(0, e.amount) * 2 * e.opacity}
          xChannelSelector="R"
          yChannelSelector="G"
          result={out}
        />,
      )
    input = out
  }
  return (
    <filter id={id} x="-100%" y="-100%" width="300%" height="300%" colorInterpolationFilters="sRGB">
      {children}
    </filter>
  )
}
const Surface = React.memo(function Surface({ n, fonts, textMode }: { n: DesignNode; fonts?: DesignDocument['fonts']; textMode?: 'outlines' | 'editable' }) {
  const fillD = shapeD(n, true),
    strokeD = shapeD(n)
  const expanded = n.strokes.some((s) => (s.widthProfile?.length || (s.startMarker && s.startMarker !== 'none') || (s.endMarker && s.endMarker !== 'none'))) ? kernelStrokePaths(n) : null
  const shape = (props: React.SVGProps<SVGPathElement>, key: string) =>
    n.kind === 'text' && textMode === 'editable' ? <EditableSvgText key={key} n={n} fonts={fonts} paintProps={props} /> : n.kind === 'text' && props.fill !== 'none' && n.textRuns?.some(r=>r.color||r.underline||r.strikethrough||r.link) ? <g key={key}>{kernelTextLayout(n).spans.map((span,i)=>span.link?<a key={i} href={span.link} target="_blank" rel="noopener noreferrer"><path d={span.path} {...props} fill={span.color||props.fill}/></a>:<path key={i} d={span.path} {...props} fill={span.color||props.fill}/>)}</g> : n.kind === 'text' && !kernelSvgPaths(n) ? (
      <text
        key={key}
        {...(props as unknown as React.SVGProps<SVGTextElement>)}
        fontSize={n.fontSize}
        fontFamily={'"Noto Sans SC", Inter, ui-sans-serif, system-ui, sans-serif'}
        letterSpacing={n.textStyle?.letterSpacing || undefined}
        dominantBaseline="text-before-edge"
      >
        {n.text.split('\n').map((line, i) => (
          <tspan key={i} x={0} y={i * n.fontSize * (n.textStyle?.lineHeight || 1.35)}>
            {line || ' '}
          </tspan>
        ))}
      </text>
    ) : (
      <path key={key} d={props.fill === 'none' ? strokeD : fillD} {...props} />
    )
  return (
    <>
      {n.fills
        .filter((p) => p.visible)
        .map((p, i) =>
          shape(
            {
              fill: color(p, `paint-${n.id}-${i}`),
              fillOpacity: p.opacity,
              fillRule: n.kind === 'text' ? 'nonzero' : n.vectorGeometry?.fillRule || n.network?.fillRule || 'evenodd',
              style: { mixBlendMode: cssBlend(p.blend) },
            },
            p.id,
          ),
        )}
      {n.strokes
        .filter((s) => s.visible)
        .map((s, i) =>
          (s.widthProfile?.length || (s.startMarker && s.startMarker !== 'none') || (s.endMarker && s.endMarker !== 'none')) ? (
            <path
              key={s.id}
              d={expanded![n.strokes.indexOf(s)]}
              fill={color(s.paint, `stroke-${n.id}-${i}`)}
              fillOpacity={s.paint.opacity}
              fillRule="nonzero"
              clipPath={s.align === 'inside' ? `url(#clip-${n.id})` : undefined}
              mask={s.align === 'outside' ? `url(#outside-${n.id})` : undefined}
              style={{ mixBlendMode: cssBlend(s.paint.blend) }}
            />
          ) : (
            shape(
              {
                fill: 'none',
                stroke: color(s.paint, `stroke-${n.id}-${i}`),
                strokeOpacity: s.paint.opacity,
                strokeWidth: s.width * (s.align === 'center' ? 1 : 2),
                strokeLinecap: s.cap,
                strokeLinejoin: s.join,
                strokeMiterlimit: 4,
                strokeDasharray: s.dash || undefined,
                strokeDashoffset: s.dashOffset || undefined,
                clipPath: s.align === 'inside' ? `url(#clip-${n.id})` : undefined,
                mask: s.align === 'outside' ? `url(#outside-${n.id})` : undefined,
                style: { mixBlendMode: cssBlend(s.paint.blend) },
              },
              s.id,
            )
          ),
        )}
    </>
  )
})
type Props = { doc: DesignDocument; pageId: string; viewport?: Bounds; exporting?: boolean; retainedNodeId?: string; textMode?: 'outlines' | 'editable' }
export function Scene({ doc, pageId, viewport, exporting = false, retainedNodeId, textMode = 'outlines' }: Props) {
  doc = expandRepeats(doc)
  const page = doc.pages.find((p) => p.id === pageId)!
  const definitions = useRef(new Map<string, {node:DesignNode; children:string; mask:DesignNode|undefined; fonts:DesignDocument['fonts']; textMode: 'outlines' | 'editable'; element:React.ReactNode}>())
  const parents = useMemo(() => allParents(doc), [doc])
  const retainedBranches = useMemo(() => {
    const ids = new Set<string>()
    for (let id = retainedNodeId; id && !ids.has(id); id = parents.get(id)) ids.add(id)
    return ids
  }, [parents, retainedNodeId])
  const entries = useMemo(() => scene(doc, pageId), [doc, pageId])
  const backdropBounds = useMemo(() => new Map(entries.map(e => [e.id, e.bounds])), [entries])
  const effectOutset = useMemo(() => Math.max(0, ...Object.values(doc.nodes).flatMap(n => n.effects.filter(e => e.visible)
    .map(e => Math.max(0, e.radius) * 3 + Math.abs(e.spread || 0) + Math.abs(e.x || 0) + Math.abs(e.y || 0)))), [doc])
  const visibleRoots = useMemo(
    () =>
      new Set(
        entries
          .filter(
            (e) =>
              !viewport || e.id === retainedNodeId || (!!retainedNodeId && e.ancestors.includes(retainedNodeId)) ||
              intersects(
                {
                  x: e.bounds.x - 200,
                  y: e.bounds.y - 200,
                  width: e.bounds.width + 400,
                  height: e.bounds.height + 400,
                },
                viewport,
              ),
          )
          .flatMap((e) => [e.id, ...e.ancestors]),
      ),
    [entries, viewport, retainedNodeId],
  )
  const visible = entries.filter((e) => visibleRoots.has(e.id))
  for (const id of definitions.current.keys()) if (!visibleRoots.has(id)) definitions.current.delete(id)
  function prefix(id: string, target: string, ancestors: Set<string>, capture: Bounds): React.ReactNode {
    if (id === target) return null
    const n = doc.nodes[id]
    if (!n?.visible) return null
    // SVG <use> instantiates its referenced subtree. Recursively replaying
    // distant blurred boards makes the expanded tree grow exponentially even
    // outside the clipped filter. Cull before creating the reference.
    const box = backdropBounds.get(id)
    if (box && !retainedBranches.has(id) && !ancestors.has(id) && !intersects({ x: box.x - effectOutset, y: box.y - effectOutset,
      width: box.width + effectOutset * 2, height: box.height + effectOutset * 2 }, capture)) return null
    if (!ancestors.has(id)) return <use key={id} href={`#visual-${id}`} />
    const at = n.children.findIndex((c) => c === target || ancestors.has(c))
    return (
      <g key={id} transform={matrixString(n.transform)} opacity={n.opacity}>
        <use href={`#surface-${id}`} />
        <g clipPath={n.clip ? `url(#clip-${id})` : undefined}>
          {n.children.slice(0, at + 1).map((c) => prefix(c, target, ancestors, capture))}
        </g>
      </g>
    )
  }
  function backdrop(n: DesignNode, e: Effect) {
    const chain = new Set<string>()
    let p = parents.get(n.id)
    while (p && doc.nodes[p]) {
      chain.add(p)
      p = parents.get(p)
    }
    const i = page.children.findIndex((id) => id === n.id || chain.has(id))
    const m = worldMatrix(doc, n.id, parents)
    const box = backdropBounds.get(n.id)!
    const capture = { x: box.x - effectOutset, y: box.y - effectOutset,
      width: box.width + effectOutset * 2, height: box.height + effectOutset * 2 }
    return (
      <g clipPath={`url(#clip-${n.id})`}>
        <g filter={`url(#backdrop-${n.id})`}>
          <rect
            x={-n.width}
            y={-n.height}
            width={n.width * 3}
            height={n.height * 3}
            fill={page.background}
          />
          <g transform={matrixString(inverse(m))}>
            {page.children.slice(0, i + 1).map((id) => prefix(id, n.id, chain, capture))}
          </g>
        </g>
        {e.kind === 'glass' && (
          <path d={shapeD(n, true)} fill={`url(#glass-light-${n.id})`} opacity={e.opacity} />
        )}
      </g>
    )
  }
  return (
    <>
      <defs>
        {visible.map(({ id }) => {
          const n = doc.nodes[id]
          const background = n.effects.find(
            (e) => e.visible && (e.kind === 'glass' || e.kind === 'background-blur'),
          )
          const mask = maskChild(doc, n)
          const children = n.children.filter(child => doc.nodes[child]?.visible && !doc.nodes[child]?.mask && visibleRoots.has(child)).join(',')
          const old = definitions.current.get(id)
          // Ordinary definitions use local geometry and references to child
          // definitions. A parent translation does not change either.
          if (!background && old?.node === n && old.children === children && old.mask === mask && old.fonts === doc.fonts && old.textMode === textMode) return old.element
          const element = (
            <React.Fragment key={id}>
              {n.fills
                .filter((p) => p.visible)
                .map((p, i) => (
                  <Color key={p.id} paint={p} id={`paint-${id}-${i}`} n={n} />
                ))}
              {n.strokes
                .filter((s) => s.visible)
                .map((s, i) => (
                  <Color key={s.id} paint={s.paint} id={`stroke-${id}-${i}`} n={n} />
                ))}
              {(n.clip || background || n.strokes.some(s => s.visible && s.align === 'inside')) && <clipPath id={`clip-${id}`}>
                <path d={shapeD(n, true)} fillRule={n.vectorGeometry?.fillRule || n.network?.fillRule || 'evenodd'} />
              </clipPath>}
              {n.strokes.some(s => s.visible && s.align === 'outside') && <mask id={`outside-${id}`} x="-100%" y="-100%" width="300%" height="300%">
                <rect
                  x={-n.width}
                  y={-n.height}
                  width={n.width * 3}
                  height={n.height * 3}
                  fill="white"
                />
                <path
                  d={shapeD(n, true)}
                  fill="black"
                  fillRule={n.vectorGeometry?.fillRule || n.network?.fillRule || 'evenodd'}
                />
              </mask>}
              {mask && (
                <mask
                  id={`mask-${id}`}
                  maskUnits="userSpaceOnUse"
                  x={-1e5}
                  y={-1e5}
                  width={2e5}
                  height={2e5}
                  style={{ maskType: mask.maskType || 'alpha' }}
                >
                  <use href={`#visual-${mask.id}`} />
                </mask>
              )}
              {n.effects.some(e => e.visible && !['background-blur', 'glass'].includes(e.kind)) && <Filter id={`effects-${id}`} effects={n.effects} />}
              {background && (
                <>
                  <filter
                    id={`backdrop-${id}`}
                    filterUnits="userSpaceOnUse"
                    x={-Math.max(32, background.radius * 3)}
                    y={-Math.max(32, background.radius * 3)}
                    width={n.width + Math.max(64, background.radius * 6)}
                    height={n.height + Math.max(64, background.radius * 6)}
                    colorInterpolationFilters="sRGB"
                  >
                    <feGaussianBlur stdDeviation={Math.max(0, background.radius) / 2} />
                    {background.colorControls && <feColorMatrix type="matrix" colorInterpolationFilters={background.colorControls.space ? "sRGB" : "linearRGB"} values={colorControlValues(background.colorControls)} />}
                    {background.kind === 'glass' && (
                      <>
                        <feTurbulence
                          type="fractalNoise"
                          baseFrequency=".012"
                          numOctaves={2}
                          seed={5}
                          result="refraction"
                        />
                        <feDisplacementMap
                          in="SourceGraphic"
                          in2="refraction"
                          scale={background.amount}
                          xChannelSelector="R"
                          yChannelSelector="G"
                        />
                        <feGaussianBlur stdDeviation={Math.max(0, background.radius) / 3} />
                      </>
                    )}
                  </filter>
                  <linearGradient id={`glass-light-${id}`} x1="0" y1="0" x2="1" y2="1">
                    <stop stopColor="white" stopOpacity=".65" />
                    <stop offset=".45" stopColor="white" stopOpacity=".02" />
                    <stop offset="1" stopColor="white" stopOpacity=".3" />
                  </linearGradient>
                </>
              )}
              <g id={`surface-${id}`}>
                <Surface n={n} fonts={doc.fonts} textMode={textMode} />
              </g>
              <g
                id={`visual-${id}`}
                data-edit-node={id}
                transform={matrixString(n.transform)}
                opacity={n.opacity}
                style={{
                  mixBlendMode: cssBlend(n.blend),
                  isolation: n.blend === 'pass-through' ? 'auto' : 'isolate',
                }}
              >
                <g
                  filter={
                    n.effects.some(
                      (e) => e.visible && !['background-blur', 'glass'].includes(e.kind),
                    )
                      ? `url(#effects-${id})`
                      : undefined
                  }
                >
                  {background && backdrop(n, background)}
                  <use href={`#surface-${id}`} />
                  <g
                    clipPath={n.clip ? `url(#clip-${id})` : undefined}
                    mask={mask ? `url(#mask-${id})` : undefined}
                  >
                    {n.children
                      .filter(
                        (c) => !n.booleanOperation && doc.nodes[c].visible && !doc.nodes[c].mask && visibleRoots.has(c),
                      )
                      .map((c) => (
                        <use key={c} href={`#visual-${c}`} />
                      ))}
                  </g>
                </g>
              </g>
            </React.Fragment>
          )
          definitions.current.set(id, {node:n,children,mask,fonts:doc.fonts,textMode,element})
          return element
        })}
      </defs>
      <g style={{ isolation: 'isolate' }}>
        {page.children
          .filter((id) => visibleRoots.has(id) && doc.nodes[id].visible)
          .map((id) => (
            <use key={id} href={`#visual-${id}`} data-node-id={id} />
          ))}
      </g>
      {!exporting &&
        visible
          .filter((e) => ['frame', 'section'].includes(doc.nodes[e.id].kind))
          .map((e) => (
            <text
              key={e.id}
              transform={matrixString(e.matrix)}
              y={-12}
              fontSize={12}
              fill="#73778b"
              pointerEvents="none"
              data-editor="true"
            >
              {doc.nodes[e.id].name}
            </text>
          ))}
    </>
  )
}
