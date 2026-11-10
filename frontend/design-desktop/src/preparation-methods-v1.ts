export const preparationProtocol = {
  "protocol": 1,
  "methods": [
    { "name": "warm_resources", "code": 1, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "initialize", "code": 2, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "load_document", "code": 3, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "apply_document_patch_with_damage", "code": 4, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "apply_interaction_transforms", "code": 5, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "compile_gpu_packet", "code": 6, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "render_linear", "code": 7, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "render_png", "code": 8, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "render_color_png", "code": 9, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "render_region_png", "code": 10, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "render_cpu_frame", "code": 11, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "stats", "code": 12, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "gpu_memory_breakdown", "code": 13, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "preparation_capabilities_v1", "code": 14, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "derive_document_v1", "code": 15, "dispatch": "all", "browser": true, "host": "renderer" },
    { "name": "load_source_snapshot", "code": 16, "dispatch": "native", "browser": false, "host": "private" },
    { "name": "source_hit", "code": 17, "dispatch": "native", "browser": false, "host": "renderer" },
    { "name": "interaction_pose_damage", "code": 18, "dispatch": "all", "browser": true, "host": "renderer" }
  ],
  "codecMethods": ["serialize", "serialize_delta", "parse"]
} as const

export type PreparationMethod = typeof preparationProtocol.methods[number]['name']
