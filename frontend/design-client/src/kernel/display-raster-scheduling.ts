/** Scheduling authority comes from the worker's request/lane, never a scene
 * packet. Exact exports, reference readbacks and object-pose captures retain
 * their independent completion contracts. */
export function displayRasterBackpressure(options:{renderIntent?:string;interactionChannel?:boolean;retainInteractionGraph?:boolean;
  exportFormat?:unknown;exportRegion?:unknown;pixelPreview?:number;rasterProfile?:string},
  request:{channel:string;png?:boolean;readback?:boolean;hdr:boolean}) {
  return import.meta.env.VITE_DESIGN_RASTER_BACKPRESSURE!=='0'&&request.channel==='canvas'&&!request.png&&!request.readback&&!request.hdr&&
    (options.renderIntent==='canvas'||options.renderIntent==='preview')&&!options.interactionChannel&&!options.retainInteractionGraph&&
    options.exportFormat===undefined&&options.exportRegion===undefined&&!options.pixelPreview&&options.rasterProfile!=='figmaSoftware'
}
