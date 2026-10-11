# Asset Workbench: Usage and Development Guide

The Asset Workbench is the extension's bottom-panel inspector for INI-linked sprites, voxel models and audio. This guide covers how to use and configure it, how its resource and rendering layers fit together, and how to verify changes. See the [user overview](../README.md#asset-workbench-and-cursor-following-inspector) for the feature summary and the [changelog](../CHANGELOG.md) for release history.

## User workflow

1. Open a mod as a VS Code workspace and configure its dictionary and file categories as usual.
2. The **RA2 Asset Workbench** defaults to the bottom panel, with a horizontal layout on wide windows. The first valid cursor target reveals it once without taking editor focus; `media.autoReveal=false` disables that behavior. VS Code allows moving it to another location. Cursor movement follows the current section or reference value; **Pin** retains a target while editing elsewhere.
3. Select a particular `AnimList` member or sound event value to inspect that reference. Key documentation remains available on the tag; media hover targets the value.
4. Edit SHP actions, existing FLH points or global voxel lighting and use **Apply to INI**. Edits preserve comments and additional action fields, use the native undo stack and leave saving to the user. An inherited action/point is overridden in its owning section rather than silently changing the parent. Shared sequence edits affect all users displayed by the inspector.
5. Use **Browse assets** for the project library, or open a resource directly in its custom editor. The editor attempts to recover the asset's rules/art owner. **Keep for comparison** retains a media snapshot and synchronizes the view; **Clear comparison** releases it.
6. Use **Check project resources** for an explicit, cancellable audit. It does not run automatically when editing.

## Project objects and safe edits

Use **Browse project objects** from the command palette or **Project objects** in the workbench. Search matches IDs, translated CSF names, type and source paths. Category/type filters and favorites narrow the catalogue; pages contain at most 100 rows. Select 2–8 objects to compare effective attributes, or up to 1,000 to prepare a batch change. Set, add and percentage operations display old/new values and destination files before applying. Changing the inputs or selection invalidates that preview. Saving remains explicit, and VS Code provides native undo.

The inspector's **Attributes** tab shows winning and overridden declarations with their source and inheritance path. Editing inherited values creates an override in the inspected object's last local section. Read-only archive sources and objects outside the effective load context cannot be edited here. Removing a declaration removes duplicates in that selected section block, keeps inline comments as standalone comments, then recalculates the value. It does not remove overrides in other repeated section blocks.

Configure **Project entry INIs** to select rules/art/sound roots. Paths are relative to the mod root; included files inherit the root's category. Entry array order and include traversal determine precedence, with later visited files winning. This is an extension load context, not a guarantee that every engine or patch loader behaves identically. Without entries, editor context retains current-document precedence. Missing includes and incomplete indexing remain visible while editing known declarations; review these before relying on effective values from a partial graph. Changed parents or resources invalidate a prepared batch.

```jsonc
{
    "ra2-ini-intellisense.project.entryPoints": {
        "rules": ["Rules/ruleses.ini"],
        "art": ["Rules/artes.ini"],
        "sound": ["Rules/soundes.ini"]
    },
    "ra2-ini-intellisense.project.objectColumns": ["Strength", "Cost", "Speed", "Armor"]
}
```

## Preview environments

**Choose background image** accepts local PNG/JPEG/WebP files up to 8 MiB. Images are downsampled to at most 2,048 pixels per dimension. **360° panorama sky** uses a 2:1 equirectangular image and switches voxel viewing to perspective. The sky follows camera orientation using the model camera's field of view; it supplies scenery, not environment lighting. Images are personal to the current webview session. Transparent PNG export continues to contain the asset itself.

Both primary and auxiliary voxel lighting are reconstructed in the current camera basis from the authored game-view direction. Orbiting preserves the screen-space light direction; dragging the light orb changes that direction. The original game camera retains the project's original light vector. Applying light edits writes authored values, not transient camera-transformed vectors.

## Maps

The map editor title-bar preview button opens the bottom-panel inspector. It displays the embedded radar preview when present, map/basic/lighting metadata, and links to map sections. Wheel zoom, drag pan and reset work on map images. Embedded previews are labeled because they can be stale. The older **Preview Map to Side** command remains available.

Full rendering requires the CNCMaps JSON `--worker` backend used by `ra2rmg-rs`; a legacy CNCMaps executable is not necessarily compatible. No renderer binary or game data is bundled. Configure the complete resource context, then click **Render current map** in a trusted workspace:

```jsonc
{
    "ra2-ini-intellisense.maps.renderer": {
        "executable": "C:/Tools/CNCMaps/CNCMaps.Renderer.exe",
        "mixDirectory": "E:/Games/YurisRevenge",
        "modDirectories": ["E:/MyMod/Rules", "E:/MyMod/Resources"],
        "rulesFiles": ["ruleses.ini"],
        "artFiles": ["artes.ini"],
        "extraMixes": []
    }
}
```

The extension sends an unsaved-text snapshot through a temporary map, runs the worker without a shell, supports cancellation and a two-minute timeout, and removes its temporary files afterward. A changed map invalidates an in-flight result. Output is limited to 64 MiB and 64M pixels. Worker-protocol, cancellation and cleanup are covered by subprocess tests; final visual fidelity still requires acceptance against a compatible installed renderer and the project's game data. This view does not place or edit units on maps.

## Configuration

Split mod layouts such as `ES/Rules/*.ini` and `ES/Resources/Models/*.vxl` share the `ES` catalog. Opening only `Rules` or `Resources`, nested INI includes, and directly opened resources use that same mod root, including root MIX archives. Sibling resource changes are watched even outside the open workspace folder. `validationFolderPath` supplies an explicit project root for documents within that directory; additional asset locations use `media.resourceRoots`. Root resolution is cached and refreshed after workspace/configuration or catalog changes.

Building images without an explicit `NewTheater` value first use the authored filename, then try theater and generic prefixes. `NewTheater=no` disables the fallback. Theater-suffixed sprites are decoded as SHP and validated by their binary header; terrain TMP files with those suffixes are not SHP sprites. RA2 VXL lighting uses the game's normal table even when a mod model retains legacy limb normal-mode metadata.

House-color remapping follows the rendering context, not the SHP format or palette filename. Technos, building bodies/Bibs/buildup and building animations using the unit drawer remap indices 16–31; ordinary animations remap only with `AltPalette=yes`. Building animation layers respect `ShouldUseCellDrawer` and its project default. Ordinary animations, particles, cameos and unclassified SHPs keep the palette's original colors, and their previews omit the house-color control. An explicit/custom palette alone does not enable or disable remapping. This policy is shared by interactive frames, contact sheets, hover thumbnails, comparisons and PNG exports. Particle `Palette=` is an exact filename in rules; particles otherwise default to `anim.pal`. See the [Phobos animation rules](https://phobos.readthedocs.io/en/stable/Fixed-or-Improved-Logics.html#animations) and [Ares particle palettes](https://ares-developers.github.io/Ares-docs/new/particles.html).

```jsonc
{
    "ra2-ini-intellisense.media.enabled": true,
    "ra2-ini-intellisense.media.autoReveal": true,
    "ra2-ini-intellisense.media.excludedDirectories": [".tmp", ".cache", "Tools"],
    "ra2-ini-intellisense.media.inlineThumbnails": true,
    "ra2-ini-intellisense.media.hoverEnabled": true,
    "ra2-ini-intellisense.media.resourceRoots": ["D:/Games/RA2"],
    "ra2-ini-intellisense.media.archiveOrder": ["expandmd99.mix", "ra2md.mix"],
    "ra2-ini-intellisense.media.theater": "tem",
    "ra2-ini-intellisense.media.semanticRules": [
        { "owner": "TechnoType", "key": "PreviewArt", "kind": "image", "extension": ".pcx" },
        { "category": "rules", "key": "AlternateExplosion", "kind": "animation" }
    ]
}
```

Custom semantic rules are additive; the first matching custom rule precedes built-ins. They can match `owner` (with type inheritance), file `category`, `key`, and dictionary `valueType`; `kind` selects object, animation, sound, image, palette, sequence, FLH or lighting interpretation. The dictionary still governs completion and validation. Resource roots accept directories, relative paths or supported filesystem URIs.

Lookup uses loose project files first, then configured MIX order, then unlisted archives; additional roots follow the project root. Equal priorities retain every source and produce ambiguity warnings rather than hiding a choice. Known filenames resolve through MIX hashes even when a filename database cannot label the entry. Companion HVA/turret/barrel resources prefer the main asset's directory/archive before general fallback.

INI resolution is project-scoped and includes open, unsaved text. Effective properties merge case-insensitive section IDs, duplicate property definitions and inherited parents with cycle/depth guards. When multiple INIs define the same property, the currently inspected document wins, followed by deterministic URI order. This is editor precedence, not an emulation of every engine/include loading order; use the source links to inspect overrides. Custom rules/art/sound filenames must match the extension's existing category configuration.

## Architecture

```mermaid
flowchart TD
    Cursor[Cursor / reference hover / resource editor] --> Inspection[InspectionService]
    Inspection --> Ini[ProjectIni + SemanticReferences]
    Inspection --> Media[MediaService]
    Media --> Catalog[ProjectResources: directories / MIX / IDX-BAG]
    Media --> Decoder[Bounded decoder worker]
    Inspection --> Session[WorkbenchSession: revisions / cancellation / capabilities]
    Session --> Webview[Localized Webview UI]
    Webview --> Sprite[Sprite worker + Canvas]
    Webview --> Voxel[WebGL2 instanced renderer]
    Webview --> Audio[Native audio element]
    Webview --> Edit[Capability-checked WorkspaceEdit]
    Edit --> Ini
```

- `src/context` owns semantic inspection, source links, hover/decorations, protocol, lifecycle, audits and visual edits. UI messages carry opaque session/capability IDs; the host retains paths, versions and original values.
- `src/resources/project-resources.ts` owns project scope, directory/archive indexing, precedence, range reads, cache invalidation and raw bytes. `mix-resource-index.ts` reads archive directories without loading their payloads; nested slices retain physical offsets in the original container. Legacy headers allow both TD and RA2 CRC lookup. Encrypted directories use standard Blowfish block byte order and little-endian plaintext fields, consistent with MixAgentCLI. Media reads use physical ranges; other `ra2mix:` consumers retain the existing archive manager.
- INI snapshots load separately from MIX metadata. Include order supplies deterministic precedence and category inheritance; open document text supplies unsaved values. Catalog generations prevent obsolete background builds from repopulating caches. Ordinary media changes retain filename catalogs; archive/structural changes rebuild them. Audio IDX catalogs resolve sample names once and pair each catalog with its sibling BAG.
- `sprite-scene.ts` resolves building theater names, attached animations, buildup, foundation and ConcurrentAnim/Next chains. `scene-renderer.ts` composes bounded layers and coalesces pending frame requests. All sprite workers in one scene share a 32 MiB frame-cache budget. Missing layers and unsupported separate effects remain visible in the trace.
- `src/media` contains independently testable format decoders, transforms and PNG/WAV encoders. A worker thread isolates binary parsing. Decode caches clone results before reuse so HVA attachment and limb composition cannot mutate cached models.
- `webview-ui/workbench` owns controls and drawing. A separate browser worker decodes SHP frames/contact sheets. VXL buffers use WebGL2 instancing; disposal releases workers, animation frames, GL buffers, textures and audio Blob URLs. Hidden views pause playback.
- The resource custom editor keeps existing map previews intact. Earlier SHP/VXL code remains available to legacy call sites; new resource editors use the shared workbench.
- Static browser scripts/styles are bundled locally. CSP disables remote scripts, only the inspector command is trusted in media hovers, and filenames/INI content are rendered as text rather than HTML.

## Formats and boundaries

| Resource | Supported path |
| --- | --- |
| TS/RA2 SHP | Raw and scanline formats 0–3, transparent frames, indexed palettes, house color, sequence directions |
| RA2 VXL/HVA | Span data, RA2 game normals with legacy mode metadata compatibility, case-insensitive HVA limb matching, body/turret/barrel assembly |
| PAL / VPL | 6-bit or 8-bit palettes, validated VPL tables, project or bundled fallback |
| PCX | Indexed and RGB planes, row padding, raw/RLE encoding |
| WAV | PCM and supported Microsoft/IMA ADPCM decoding to PCM WAV |
| IDX/BAG | Standard GABA v2 catalog, PCM/IMA sample flags, bounded selected-sample reads |
| MIX | Named/hash lookup, nested archives, RSA/Blowfish encrypted header reads; encrypted mutation is rejected |
| MP3/OGG/FLAC | Browser codec dependent; not decoded by the host |

Game view uses authored normals, VPL shading and Phobos light direction/fixed-light controls, but remains a preview approximation. It does not reproduce every game rendering pass, map lighting effect or firing rule. FLH uses an adjustable leptons-to-model-unit scale (default 8); validate placement and final visuals in game. The preview targets RA2 lighting rather than switching to Tiberian Sun lighting from legacy limb metadata. Missing companion files do not prevent viewing the main asset.

Limits are intentional: 4M pixels per decoded image, 1,000,000 voxels per VXL file and assembled model, 128 limbs, 4,096 HVA frames/65,536 limb poses, 64 MiB raw/decode caches, 16 queued decoder jobs, 15-second decode timeout, 100,000 catalog entries/16 traversal levels, 2,000 INIs on initial context load, 10,000 library tiles and 2,000 audited references. Library tiles and contact sheets are paginated. Range reads avoid loading a large BAG just to play one sample. New cursor requests cancel old work and obsolete responses cannot replace current state.

## Development and verification

```powershell
npm ci
npm run compile
npm run format:workbench
# Uses the locally cached VS Code when the version is set explicitly:
$env:VSCODE_TEST_VERSION='1.131.0'
npm test
# Either install Playwright Chromium or use installed Chrome:
npx playwright install chromium --only-shell
npm run test:webview
$env:PLAYWRIGHT_CHANNEL='chrome'
npm run test:webview
npm run package
npx @vscode/vsce package --no-dependencies
```

`npm test` launches the real extension development host. Tests cover malformed binary inputs, exact token ranges, dictionaries, rules/art/sound chains, project isolation, unsaved edits, MIX hash/range lookup, encrypted headers, cache ownership and native undo/stale edit protection. Fixtures are generated in temporary directories and cleanup validates those paths.

Optional read-only mod acceptance uses `RA2_WORKBENCH_REAL_PROJECT` and `RA2_WORKBENCH_DICTIONARY` to check GACNST, P_EXPA_120B, TanyaPrimeSelect and ALIFV, writing `out/real-media-acceptance.json`. For a dedicated UI run, set `RA2_WORKBENCH_TEST_PATTERN=out/test/real-project-media.test.js`, `RA2_WORKBENCH_UI_PORT=9328` and `RA2_WORKBENCH_VERIFY_PANEL=1`. This verifies actual hover PNGs, rendered automatic panel content, retained editor focus and suppression after manual close. The dictionary setting is restored after the test.

Release acceptance must also cover the installed bundle. On Windows, set `RA2_WORKBENCH_TEST_CODE` to the `Code.exe` being tested and run `node scripts/test-installed-vsix.cjs <vsix-path>` after compiling the tests; a separate minimal test driver ensures the installed extension is used, with an isolated profile and extension directory under `out`. Use a separate `RA2_WORKBENCH_TEST_USER_DATA` for each VS Code version. The native UI check also clicks the hover's View asset link after manually closing the panel. Opening failures remain retryable; if an extension update has not registered the new view contribution, the extension offers Reload Window instead of silently failing.

The ES catalog survey writes `out/real-project-catalog.json` with every registered infantry, vehicle, aircraft and building resource match or miss. Set `RA2_WORKBENCH_WORKSPACE=E:/Extreme Starry/Rules` to assert that the actual development host opens a child-folder workspace, `RA2_WORKBENCH_SURVEY_DECODE=1` to decode representatives across resource directories, and `RA2_WORKBENCH_SURVEY_BINARY=1` to validate every loose Resources SHP/VXL header/span structure plus the first populated SHP frame. Binary failures remain in the report; a resolved registered entry does not by itself prove full scene or animation playback.

`test:webview` runs bundled UI assets under a restrictive CSP in a browser and verifies sprite worker pixels, duplicate-name source IDs, sequence edit messages, comparison, PNG export, WebGL pixels, lighting messages, narrow layouts, audio visibility pause and library selection. Screenshots are saved under `out/webview-qa`. Browser tests complement extension-host integration; screenshots and a live game remain necessary to assess visual fidelity.

Release bundles contain `dist/extension.js`, `dist/media-worker.js`, `dist/workbench/{main.js,main.css,worker.js}`, localized strings, palettes and third-party license notices. Node dependencies are bundled; `--no-dependencies` avoids shipping development dependencies in the VSIX.
