# Futureox Design

[简体中文](README.md) | [English](README.en.md)

**An open-source, local-first 2D design editor inspired by Figma and Sketch.**

Futureox Design aims to provide an open, extensible workspace for interface design, vector editing, and working with design files, built together by designers and developers.

The project includes a Rust kernel, a shared web and desktop client, an Electron desktop application, and a local MCP adapter. These parts evolve around a common canvas, document model, and editing workflow. Ideas, bug reports, and contributions are welcome—help us make Futureox Design better together.

## Project structure

```text
design-kernel/
├── frontend/
│   ├── design-client/          # Shared UI, editing, WASM and browser rendering adapters
│   ├── design-desktop/         # Electron host, native bridges and packaging
│   └── design-mcp/             # Local MCP protocol adapter
├── design-studio/
│   ├── crates/
│   │   ├── design-kernel/      # Documents, geometry, layout, history, formats and CPU rendering
│   │   ├── design-gpu/         # Native GPU devices, resources and rendering
│   │   ├── design-desktop-backend/ # Files, SQLite, recovery and source document sessions
│   │   ├── design-server/      # Server APIs
│   │   └── design-agent/       # Agent service adapter
│   └── scripts/                # Kernel builds, checks and test vector generation
├── docs/
│   ├── README.md               # Documentation index organized by topic
│   ├── architecture/           # Layer responsibilities and call flows
│   ├── rendering/history/      # Historical rendering delivery notes
│   ├── features/               # Feature contracts
│   └── history/                # Historical development records
├── testing/                    # Regression tests, fixtures and verification tools
├── evidence/                   # Verification evidence tracked in version control
├── vendor/                     # Local dependencies with their original licenses
└── .agents/skills/              # Project engineering guidelines
```

UI actions and automation use the same editing transactions. The desktop host provides local capabilities, while Rust/WASM/native code handles domain validation, layout, and rendering semantics. See the [architecture guide (Chinese)](docs/architecture/README.zh-CN.md) for responsibilities and call flows.

## Development and verification

The Rust toolchain is pinned in [rust-toolchain.toml](rust-toolchain.toml). Frontend packages use Bun. After changing Rust/WASM code, rebuild the kernel used by the client before testing.

```bash
# Run Rust tests from the repository root
cargo test --locked --manifest-path design-studio/Cargo.toml --workspace

# Install client dependencies and build the kernel
cd frontend/design-client
bun install
bun run build:kernel
bun run typecheck
bun run test
```

See [design-desktop](frontend/design-desktop/README.md) for desktop builds and development, and the [MCP operation guide (Chinese)](docs/MCP_OPERATION_GUIDE_V1.md) for automation. Client build scripts reference the Rust workspace through `../../design-studio`; keep these directories in their current relative locations.

## Documentation and test assets

- [Documentation index (Chinese)](docs/README.md): architecture, rendering, storage, automation, and feature contracts.
- [Development contract (Chinese)](docs/DEVELOPMENT_CONTRACT_V1.md) and [rendering acceptance criteria (Chinese)](docs/RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md): implementation boundaries and verification requirements.
- [Testing guide](testing/README.md): test commands, regression fixtures, and verification scope. Screenshots, format samples, and calibration fixtures support regression testing.
- [Third-party notices](THIRD_PARTY_NOTICES.md): notices and license texts retained with source code or distributed artifacts.

Build outputs such as `target/`, `node_modules/`, `dist/`, and `release/` are excluded from version control. Historical delivery notes are collected in [docs/rendering/history](docs/rendering/history/README.md); their results apply to the versions and environments recorded there.

## Contributing

Everyone is welcome to contribute to Futureox Design. Feature development, bug fixes, performance improvements, UI design, documentation, translations, and testing feedback all help the project.

- **Report a bug or suggest an idea:** open an [Issue](https://github.com/luckyzifan/futureoxDesgin/issues) with your use case, reproduction steps, and expected behavior.
- **Share an improvement:** submit a [Pull Request](https://github.com/luckyzifan/futureoxDesgin/pulls). For larger features or architecture changes, consider opening an Issue first to discuss the approach.
- **Start developing:** follow the commands above, read the [architecture guide (Chinese)](docs/architecture/README.zh-CN.md) and [contribution and testing requirements (Chinese)](docs/TESTING_CONTRIBUTIONS.zh-CN.md), and describe your changes and relevant verification results in the PR.

## Acknowledgments

Thank you to everyone who shares ideas, reports issues, submits changes, improves documentation, or helps with testing. From a small wording correction to a new feature or performance improvement, every contribution helps Futureox Design grow.

We thank [all contributors](https://github.com/luckyzifan/futureoxDesgin/graphs/contributors) and the open-source communities the project relies on. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency acknowledgments and license information.

## License

The project's original code is licensed under the [MIT License](LICENSE).

Copyright (c) 2026 Cookieboty and contributors

Third-party dependencies, fonts, assets, and tools retain their respective licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).
