import type { ResidentFrame } from './resident-presenter'

/** Explicit wire projection: painted tiles also carry their document and
 * diagnostics at runtime. A TypeScript type does not remove those fields. */
export function residentFrameMessage(frame: ResidentFrame): ResidentFrame {
  return {
    presentationId: frame.presentationId,
    overlay: frame.overlay ? { pixelGrid: frame.overlay.pixelGrid, selection: frame.overlay.selection ? {
      handles: frame.overlay.selection.handles, owners:frame.overlay.selection.owners?.slice(), corners: frame.overlay.selection.corners.map(p => ({ x: p.x, y: p.y })) } : undefined,
      labels:frame.overlay.labels?.map(label=>({anchor:{x:label.anchor.x,y:label.anchor.y},offset:{x:label.offset.x,y:label.offset.y},
        text:label.text,size:label.size,color:label.color,basis:label.basis?.slice() as typeof label.basis,centered:label.centered,halo:label.halo,owners:label.owners?.slice()})),
      measurements:frame.overlay.measurements?.map(m=>({from:{x:m.from.x,y:m.from.y},to:{x:m.to.x,y:m.to.y}})),
      transforms:frame.overlay.transforms?Object.fromEntries(Object.entries(frame.overlay.transforms).map(([id,m])=>[id,[...m]])):undefined,
    } : undefined,
    view: { x: frame.view.x, y: frame.view.y, zoom: frame.view.zoom },
    width: frame.width,
    height: frame.height,
    dpr: frame.dpr,
    interaction: frame.interaction,
    allowEmpty: frame.allowEmpty,
    linearBlend: frame.linearBlend,
    backgroundLinear: frame.backgroundLinear ? [...frame.backgroundLinear] : undefined,
    input: frame.input ? { sequence: frame.input.sequence, at: frame.input.at,owner:frame.input.owner } : undefined,
    items: frame.items.map((item) => ({
      active: item.active,
      layer: item.layer,
      gutter: item.gutter,
      blend: item.blend,
      placement: item.placement
        ? {
            left: item.placement.left,
            top: item.placement.top,
            width: item.placement.width,
            height: item.placement.height,
          }
        : undefined,
      clip: item.clip
        ? {
            left: item.clip.left,
            top: item.clip.top,
            width: item.clip.width,
            height: item.clip.height,
          }
        : undefined,
      tile: {
        key: item.tile.key,
        serial: item.tile.serial,
        gpuTile: item.tile.gpuTile,
        x: item.tile.x,
        y: item.tile.y,
        width: item.tile.width,
        height: item.tile.height,
        zoom: item.tile.zoom,
        phaseX: item.tile.phaseX,
        phaseY: item.tile.phaseY,
      },
    })),
  }
}

export function residentFrameSignature(frame: ResidentFrame) {
  return JSON.stringify([
    frame.presentationId,
    frame.overlay,
    frame.view,
    frame.width,
    frame.height,
    frame.dpr,
    frame.interaction,
    frame.allowEmpty,
    frame.linearBlend,
    frame.backgroundLinear,
    frame.items
      .filter((item) => item.active)
      .map(({ tile, layer, placement, clip, gutter, blend }) => [
        tile.gpuTile,
        tile.x,
        tile.y,
        tile.width,
        tile.height,
        tile.zoom,
        tile.phaseX,
        tile.phaseY,
        layer,
        placement,
        clip,
        gutter,
        blend,
      ]),
  ])
}
