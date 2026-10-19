# Recovered GRAIN/NOISE shader sources

Extracted as printable ASCII strings from the reference engine WASM data
segments (signature constants 438.5453 / 12.9898 / 78.233), 2026-10-13.
The prior grain-notes.md conclusion "engine constants unidentified" is
obsolete: the generator is procedural (3-octave lattice gradient noise),
not a baked table. Recovered source conflicts with the Gabor structural
hypothesis; see grain-notes.md and texture_noise.rs Q19 (a bit-level port
of this shader family).

fullscreen-wasm.wasm: sha256=6954d044fc55c5e0ef0ace4ab5dd6d6d480baab118daaeb1111135298d140642 bytes=51816354
render-worker-wasm.wasm: sha256=1c7f1dcdb2112c8dd247b02c287b4e071c45ee9c543c2499c55b8039b4633cf1 bytes=29037999
grain-noise-shader-00d5a8360fa3.glsl: 2436 bytes, variants at fullscreen-wasm.wasm@47106095..47108531, fullscreen-wasm.wasm@47106095..47108531, fullscreen-wasm.wasm@47106095..47108531, render-worker-wasm.wasm@25679246..25681682 …
grain-noise-shader-015831f92e46.glsl: 3042 bytes, variants at fullscreen-wasm.wasm@46983458..46986500, fullscreen-wasm.wasm@46983458..46986500, fullscreen-wasm.wasm@46983458..46986500, render-worker-wasm.wasm@25556765..25559807 …
grain-noise-shader-055bab75d0f8.glsl: 3340 bytes, variants at fullscreen-wasm.wasm@47631983..47635323, fullscreen-wasm.wasm@47631983..47635323, render-worker-wasm.wasm@26205134..26208474, render-worker-wasm.wasm@26205134..26208474
grain-noise-shader-0b58efa73dbb.glsl: 853 bytes, variants at fullscreen-wasm.wasm@47665919..47666772, fullscreen-wasm.wasm@47665919..47666772, render-worker-wasm.wasm@26239070..26239923, render-worker-wasm.wasm@26239070..26239923
grain-noise-shader-0e7aeada455f.glsl: 913 bytes, variants at fullscreen-wasm.wasm@47663497..47664410, fullscreen-wasm.wasm@47663497..47664410, render-worker-wasm.wasm@26236648..26237561, render-worker-wasm.wasm@26236648..26237561
grain-noise-shader-11dfb9e12f4b.glsl: 2891 bytes, variants at fullscreen-wasm.wasm@46991124..46994015, fullscreen-wasm.wasm@46991124..46994015, fullscreen-wasm.wasm@46991124..46994015, render-worker-wasm.wasm@25564431..25567322 …
grain-noise-shader-1dc8ecf69fa0.glsl: 862 bytes, variants at fullscreen-wasm.wasm@47661759..47662621, fullscreen-wasm.wasm@47661759..47662621, render-worker-wasm.wasm@26234910..26235772, render-worker-wasm.wasm@26234910..26235772
grain-noise-shader-20faf9575893.glsl: 2013 bytes, variants at fullscreen-wasm.wasm@47638552..47640565, fullscreen-wasm.wasm@47638552..47640565, render-worker-wasm.wasm@26211703..26213716, render-worker-wasm.wasm@26211703..26213716
grain-noise-shader-2d57a9303921.glsl: 6740 bytes, variants at fullscreen-wasm.wasm@47422776..47429516, fullscreen-wasm.wasm@47422776..47429516, fullscreen-wasm.wasm@47422776..47429516, render-worker-wasm.wasm@25995927..26002667 …
grain-noise-shader-2ef0e8c21d5a.glsl: 3445 bytes, variants at fullscreen-wasm.wasm@48639400..48642845, fullscreen-wasm.wasm@48639400..48642845
grain-noise-shader-3474492c6d82.glsl: 874 bytes, variants at fullscreen-wasm.wasm@47662622..47663496, fullscreen-wasm.wasm@47662622..47663496, render-worker-wasm.wasm@26235773..26236647, render-worker-wasm.wasm@26235773..26236647
grain-noise-shader-377b6ba36bba.glsl: 2834 bytes, variants at fullscreen-wasm.wasm@47391410..47394244, fullscreen-wasm.wasm@47391410..47394244, render-worker-wasm.wasm@25964561..25967395, render-worker-wasm.wasm@25964561..25967395
grain-noise-shader-452476be659e.glsl: 5748 bytes, variants at fullscreen-wasm.wasm@47582181..47587929, fullscreen-wasm.wasm@47582181..47587929, fullscreen-wasm.wasm@47582181..47587929, render-worker-wasm.wasm@26155332..26161080 …
grain-noise-shader-48f1ee303e6f.glsl: 3259 bytes, variants at fullscreen-wasm.wasm@47628723..47631982, fullscreen-wasm.wasm@47628723..47631982, render-worker-wasm.wasm@26201874..26205133, render-worker-wasm.wasm@26201874..26205133
grain-noise-shader-493ee15c1ed8.glsl: 7153 bytes, variants at fullscreen-wasm.wasm@47611878..47619031, fullscreen-wasm.wasm@47611878..47619031, fullscreen-wasm.wasm@47611878..47619031, render-worker-wasm.wasm@26185029..26192182 …
grain-noise-shader-4a27590e4b20.glsl: 2802 bytes, variants at fullscreen-wasm.wasm@47397157..47399959, fullscreen-wasm.wasm@47397157..47399959, render-worker-wasm.wasm@25970308..25973110, render-worker-wasm.wasm@25970308..25973110
grain-noise-shader-4cc19e3b691e.glsl: 2768 bytes, variants at fullscreen-wasm.wasm@47429517..47432285, fullscreen-wasm.wasm@47429517..47432285, render-worker-wasm.wasm@26002668..26005436, render-worker-wasm.wasm@26002668..26005436
grain-noise-shader-4f4c7cc8a118.glsl: 3039 bytes, variants at fullscreen-wasm.wasm@46986501..46989540, fullscreen-wasm.wasm@46986501..46989540, fullscreen-wasm.wasm@46986501..46989540, render-worker-wasm.wasm@25559808..25562847 …
grain-noise-shader-569361307aec.glsl: 2918 bytes, variants at fullscreen-wasm.wasm@46994016..46996934, fullscreen-wasm.wasm@46994016..46996934, fullscreen-wasm.wasm@46994016..46996934, render-worker-wasm.wasm@25567323..25570241 …
grain-noise-shader-58a0ac42964f.glsl: 2086 bytes, variants at fullscreen-wasm.wasm@47506920..47509006, fullscreen-wasm.wasm@47506920..47509006, render-worker-wasm.wasm@26080071..26082157, render-worker-wasm.wasm@26080071..26082157
grain-noise-shader-58e01c2b363d.glsl: 2006 bytes, variants at fullscreen-wasm.wasm@47504913..47506919, fullscreen-wasm.wasm@47504913..47506919, render-worker-wasm.wasm@26078064..26080070, render-worker-wasm.wasm@26078064..26080070
grain-noise-shader-59a2a39e0ec0.glsl: 2583 bytes, variants at fullscreen-wasm.wasm@47701346..47703929, fullscreen-wasm.wasm@47701346..47703929
grain-noise-shader-5f64cb9acd5e.glsl: 2464 bytes, variants at fullscreen-wasm.wasm@47108532..47110996, fullscreen-wasm.wasm@47108532..47110996, fullscreen-wasm.wasm@47108532..47110996, render-worker-wasm.wasm@25681683..25684147 …
grain-noise-shader-630a01f87aa5.glsl: 7829 bytes, variants at fullscreen-wasm.wasm@47443029..47450858, fullscreen-wasm.wasm@47443029..47450858, render-worker-wasm.wasm@26016180..26024009, render-worker-wasm.wasm@26016180..26024009
grain-noise-shader-78fbf8c27271.glsl: 3227 bytes, variants at fullscreen-wasm.wasm@47635324..47638551, fullscreen-wasm.wasm@47635324..47638551, render-worker-wasm.wasm@26208475..26211702, render-worker-wasm.wasm@26208475..26211702
grain-noise-shader-87ac9b62d25e.glsl: 3019 bytes, variants at fullscreen-wasm.wasm@46980438..46983457, fullscreen-wasm.wasm@46980438..46983457, fullscreen-wasm.wasm@46980438..46983457, render-worker-wasm.wasm@25553745..25556764 …
grain-noise-shader-97e57e4de23c.glsl: 4753 bytes, variants at fullscreen-wasm.wasm@48645222..48649975, fullscreen-wasm.wasm@48645222..48649975
grain-noise-shader-a1dbe0605ad4.glsl: 414 bytes, variants at fullscreen-wasm.wasm@47694079..47694493, fullscreen-wasm.wasm@47694079..47694493, render-worker-wasm.wasm@26267230..26267644, render-worker-wasm.wasm@26267230..26267644
grain-noise-shader-a6772852dbf2.glsl: 4164 bytes, variants at fullscreen-wasm.wasm@47296334..47300498, fullscreen-wasm.wasm@47296334..47300498, render-worker-wasm.wasm@25869485..25873649, render-worker-wasm.wasm@25869485..25873649
grain-noise-shader-aa1c62fc401b.glsl: 1577 bytes, variants at fullscreen-wasm.wasm@47470055..47471632, fullscreen-wasm.wasm@47470055..47471632, render-worker-wasm.wasm@26043206..26044783, render-worker-wasm.wasm@26043206..26044783
grain-noise-shader-b806be07d369.glsl: 1558 bytes, variants at fullscreen-wasm.wasm@47466781..47468339, fullscreen-wasm.wasm@47466781..47468339, render-worker-wasm.wasm@26039932..26041490, render-worker-wasm.wasm@26039932..26041490
grain-noise-shader-c0adad1d2e22.glsl: 7021 bytes, variants at fullscreen-wasm.wasm@47436007..47443028, fullscreen-wasm.wasm@47436007..47443028, render-worker-wasm.wasm@26009158..26016179, render-worker-wasm.wasm@26009158..26016179
grain-noise-shader-c2856ea519c1.glsl: 748 bytes, variants at fullscreen-wasm.wasm@47664411..47665159, fullscreen-wasm.wasm@47664411..47665159, render-worker-wasm.wasm@26237562..26238310, render-worker-wasm.wasm@26237562..26238310
grain-noise-shader-d4d8a04514a4.glsl: 1230 bytes, variants at fullscreen-wasm.wasm@47640566..47641796, fullscreen-wasm.wasm@47640566..47641796, render-worker-wasm.wasm@26213717..26214947, render-worker-wasm.wasm@26213717..26214947
grain-noise-shader-da2038bc7f15.glsl: 2025 bytes, variants at fullscreen-wasm.wasm@47509007..47511032, fullscreen-wasm.wasm@47509007..47511032, render-worker-wasm.wasm@26082158..26084183, render-worker-wasm.wasm@26082158..26084183
grain-noise-shader-df7c851207c2.glsl: 1152 bytes, variants at fullscreen-wasm.wasm@47641797..47642949, fullscreen-wasm.wasm@47641797..47642949, render-worker-wasm.wasm@26214948..26216100, render-worker-wasm.wasm@26214948..26216100
grain-noise-shader-e5079f9606aa.glsl: 1792 bytes, variants at fullscreen-wasm.wasm@47522919..47524711, fullscreen-wasm.wasm@47522919..47524711, render-worker-wasm.wasm@26096070..26097862, render-worker-wasm.wasm@26096070..26097862
grain-noise-shader-e853966f8d20.glsl: 2911 bytes, variants at fullscreen-wasm.wasm@47394245..47397156, fullscreen-wasm.wasm@47394245..47397156, render-worker-wasm.wasm@25967396..25970307, render-worker-wasm.wasm@25967396..25970307
grain-noise-shader-e8da655c6d4c.glsl: 1714 bytes, variants at fullscreen-wasm.wasm@47468340..47470054, fullscreen-wasm.wasm@47468340..47470054, render-worker-wasm.wasm@26041491..26043205, render-worker-wasm.wasm@26041491..26043205
grain-noise-shader-ed1b312ae4bb.glsl: 2453 bytes, variants at fullscreen-wasm.wasm@47110997..47113450, fullscreen-wasm.wasm@47110997..47113450, fullscreen-wasm.wasm@47110997..47113450, render-worker-wasm.wasm@25684148..25686601 …
grain-noise-shader-f31292c139fb.glsl: 758 bytes, variants at fullscreen-wasm.wasm@47665160..47665918, fullscreen-wasm.wasm@47665160..47665918, render-worker-wasm.wasm@26238311..26239069, render-worker-wasm.wasm@26238311..26239069
grain-noise-shader-f96cbb22f388.glsl: 7906 bytes, variants at fullscreen-wasm.wasm@48649976..48657882, fullscreen-wasm.wasm@48649976..48657882
grain-noise-shader-fdf015693d79.glsl: 1012 bytes, variants at fullscreen-wasm.wasm@47581168..47582180, fullscreen-wasm.wasm@47581168..47582180, render-worker-wasm.wasm@26154319..26155331, render-worker-wasm.wasm@26154319..26155331
grain-noise-shader-fdf1f6eae8a9.glsl: 2903 bytes, variants at fullscreen-wasm.wasm@46996935..46999838, fullscreen-wasm.wasm@46996935..46999838, fullscreen-wasm.wasm@46996935..46999838, render-worker-wasm.wasm@25570242..25573145 …
grain-noise-shader-febeb26f2d2f.glsl: 4466 bytes, variants at fullscreen-wasm.wasm@47300499..47304965, fullscreen-wasm.wasm@47300499..47304965, render-worker-wasm.wasm@25873650..25878116, render-worker-wasm.wasm@25873650..25878116
grain-noise-shader-fed3f8e7ef3d.glsl: 1140 bytes, variants at fullscreen-wasm.wasm@47642950..47644090, fullscreen-wasm.wasm@47642950..47644090, render-worker-wasm.wasm@26216101..26217241, render-worker-wasm.wasm@26216101..26217241
