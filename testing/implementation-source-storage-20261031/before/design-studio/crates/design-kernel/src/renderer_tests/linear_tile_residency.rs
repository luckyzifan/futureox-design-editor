use super::*;
use serde_json::json;

fn engine_and_options(width: u32, height: u32) -> (Engine, RenderOptions) {
    let mut engine = Engine::new();
    engine.load_document(&json!({
        "schemaVersion":3,"id":"residency","name":"residency",
        "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
        "pages":[{"id":"p","name":"p","children":[],"background":"#ffffff"}],"nodes":{}
    }).to_string()).unwrap();
    let options = serde_json::from_value(json!({
        "pageId":"p","width":width,"height":height,"view":{"x":0,"y":0,"zoom":1},
        "rasterProfile":"analytic","interactiveEffects":true
    })).unwrap();
    (engine, options)
}

fn seed_tiles(engine: &mut Engine, options: &RenderOptions, addresses: &[[i32; 2]], revision: u64) {
    let instruction = engine.render_instruction_for(options).unwrap();
    let level = crate::tiled_renderer::level_index_for_scale(instruction.level_scale);
    engine.linear_tiles_options = Some((instruction.page_id, instruction.options, instruction.color_space));
    // Shared immutable white content keeps these eviction tests small. Each
    // logical tile still has its own real map entry and eviction record.
    let white = Arc::new(vec![Pixel::rgba(1., 1., 1., 1.); 512 * 512]);
    for address in addresses {
        let key = (level, *address);
        engine.linear_tiles.insert(key, (revision, Arc::clone(&white)));
        engine.linear_tiles_order.push(key);
    }
}

#[test]
fn visible_tiles_survive_a_frame_larger_than_the_retained_cache() {
    let (mut engine, options) = engine_and_options(6145, 513);
    let instruction = engine.render_instruction_for(&options).unwrap();
    let addresses = crate::tile_stack::raster_addresses(instruction.viewport, 1., 256, [0., 0.]).unwrap();
    assert_eq!(addresses.len(), 26);
    let revision = engine.geo_revision;
    seed_tiles(&mut engine, &options, &addresses[..24], revision);
    let frame = engine.render_linear_reused(&options).unwrap();
    assert!(frame.iter().all(|p| *p == Pixel::rgba(1., 1., 1., 1.)), "eviction must not punch holes in the current frame");
    assert_eq!(engine.linear_tiles.len(), 24);
    assert_eq!(engine.linear_tiles_order.len(), 24);
}

#[test]
fn rebuilding_a_key_does_not_evict_its_new_revision() {
    let (mut engine, options) = engine_and_options(1, 1);
    let addresses: Vec<_> = (0..24).map(|x| [x, 0]).collect();
    let stale_revision = engine.geo_revision;
    seed_tiles(&mut engine, &options, &addresses, stale_revision);
    engine.geo_revision += 1;
    let frame = engine.render_linear_reused(&options).unwrap();
    assert_eq!(frame, vec![Pixel::rgba(1., 1., 1., 1.)]);
    let key = (crate::tiled_renderer::level_index_for_scale(1.), [0, 0]);
    assert_eq!(engine.linear_tiles[&key].0, engine.geo_revision);
    assert_eq!(engine.linear_tiles_order.iter().filter(|k| **k == key).count(), 1);
    assert_eq!(engine.linear_tiles.len(), 24);
    assert_eq!(engine.linear_tiles_order.len(), 24);
}
