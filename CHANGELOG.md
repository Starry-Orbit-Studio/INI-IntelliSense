[Read this in Chinese (简体中文)](./CHANGELOG.zh-cn.md)

# Change Log

All notable changes to the "ra2-ini-intellisense" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Cover all four SuperAnim and SpecialAnim slots, including damaged variants. Unify building turret and vehicle VXL orientation with RA2's 30-degree game projection, native normals and project VPL lighting.
- Apply TurretOffset in lepton coordinates and read FireAngle barrel elevation. Bind unnamed HVA sections by their original order, restoring V22 rotor placement and animation.
- Resolve elite, numbered weapon, burst and alternate FLH points; keep point editing collapsed until explicitly opened, prefer selected overlapping points and synchronize cancelled drags.
- Replace shrinking source cards with bounded, non-overlapping name/provenance/path rows. Generate cached, bounded APNG hover previews in the decode worker; inline decorations stay static and all animation frames share one trimmed canvas.

- Share animated building composition and default house color between hover and details, including Bib and voxel turrets. Trim SHP using one union of all authored frame rectangles, preserving frame alignment without decoding every frame.
- Add searchable, width-limited palette controls, viewport wheel zoom and drag/middle-drag pan with a floating zoom input. Hide building animation palette controls and bound the compact layer list.

- Unify project voxel lighting, preserve native INI light axes and the game's vertical secondary light and keep VPL shading in both game orthographic and true perspective views. Add camera pan and a spherical light control.
- Move FLH editing into the viewport; support direct point and axis dragging with perspective-aware coordinates, readable selected-point labels and native INI undo.
- Show normal and promoted SHP/PCX icons expanded. Share media capabilities so audio has audio export and no palette, PNG or image-comparison controls.
- Resolve theater palette prefixes separately from exact CustomPalette filenames. Building animation palettes inherit the body only when unspecified, while keeping explicit animation palettes independent. Add project-scoped theater selection shared by hover, inline previews and workbench, with synchronized body/Bib/buildup/animation filenames and palette prefixes; it does not change INIs or settings.
- Render BibShape, production/door/deployment/upgrade animation layers and combined damaged states with a shared game ground anchor. Keep body/Bib normal and damaged frames static, hide Bib during buildup, and compose SHP buildings with VXL turrets using project VPL lighting. Replace inaccurate particle/smoke simulation and building Next explosions with DamageFireTypes from the building or General, using animation palettes and editable fire points.
- Play infantry actions by selected direction with clip-relative timelines, source frame numbers and an eight-direction contact sheet. Resolve VoxelAnimType resources as VXL without requiring an art Voxel flag.

## [0.1.3] - 2026-10-10

- Fix file category globs crossing directory separators: `rules*.ini` no longer classifies `Rules/artes.ini` or `Rules/soundes.ini` as rules. This restores voxel format decisions and art/sound lookup when opening the full mod workspace; recursive paths use `**`.
- Refresh cached section queries when background include discovery changes a file category; retain art `Voxel=yes` across unchanged documents and duplicate art sections. Verify ALTNK through the actual extension hover and inspector.
- Expose voxel art property sources in the inspector, including the `Voxel` format decision.

## [0.1.2] - 2026-10-10

- Resolve the mod root for Rules/Resources child-folder workspaces, nested INIs, directly opened assets and MIX entries; honor the configured project directory within its scope and watch sibling resource changes.
- Add cached root resolution, building theater filename fallback (respecting explicit NewTheater=no), and decoding for theater-named SHP sprites.
- Resolve cross-directory includes through the mod root and unique catalog filenames, preserving relative-match precedence and Windows case-insensitive paths.
- Accept legacy VXL limb normal-mode metadata with RA2 game lighting instead of rejecting otherwise valid ES models.
- Support padded transparent SHP row tails and empty-frame format metadata; share a bounded one-million-voxel budget for large models and assembled parts.
- Add real Rules-workspace acceptance, a complete registered techno resource survey and an optional full Resources SHP/VXL decoding report.

## [0.1.1] - 2026-10-10

- Moved the inspector to the bottom panel with a compact horizontal layout and one-time automatic reveal that preserves editor focus.
- Added background project and audio-bank indexing, targeted cache invalidation, visible source cards and lower-priority backup sources.
- Corrected encrypted MIX Blowfish byte order and legacy CRC filename lookup; nested media now use directory and sample range reads.
- Added NewTheater building resolution, attached animations, buildup/damaged/production states, foundation grids and animation ConcurrentAnim/Next chains with provenance.
- Corrected voxel light/normal coordinate conversion, game-scale camera defaults and interactive light dragging; playback controls now follow media capabilities.
- Changed FLH overlays to unobtrusive points with names/coordinates beside the preview, visibility control and axes for the selected point only. Game hover thumbnails now share VPL lighting and the default house remap.
- Fixed actual PNG media hovers and stock nested IDX/BAG sound resolution, including dollar-prefixed sound names and event volume.
- Added real mod acceptance and VS Code hover-image checks, alongside bottom-panel, scene and lighting browser regressions.

## [0.1.0] - 2026-10-10

- Added a cursor-following object inspector, inline thumbnails and media hovers with dictionary-driven, exact-member reference resolution.
- Added project-scoped rules/art/sound resolution, unsaved document support, source selection, asset roots and explicit MIX precedence.
- Rebuilt SHP previews with playback, directions, house colors, contact sheets and sequence editing with native undo.
- Added WebGL2 VXL/HVA rendering, body/turret/barrel assembly, Phobos voxel lighting controls, HVA playback and visual FLH editing.
- Added IDX/BAG/WAV audition, an asset library, snapshot comparison, PNG/WAV export, semantic reference replacement and on-demand resource audits.
- Added encrypted MIX read access with explicit read-only protection, bounded/cancellable decoding workers and caches, CSP restrictions and localized workbench UI.
- Added extension-host integration tests and browser regressions covering decoders, project isolation, references, edits, rendering and media lifecycle.

## [0.0.5] - 2026-07-17

- Added format document and format on save support for INI files.
- Added a "Preview Map" command in the editor title bar; map files (`.map`, `.mpr`, `.yrm`) now open as text by default and can be previewed in a side panel.
- Added Phobos `$Inherits=` section inheritance support, including multiple parents, recursive depth-first lookup, references, rename, and override indicators.
- Expanded project indexing and file watching to map-style INI files (`.map`, `.mpr`, `.yrm`) so inheritance and references work outside regular `.ini` files.
- Improved save performance significantly — saving large INI files no longer causes noticeable lag.
- Unified the product name to "RA2 Mod IntelliSense" with new extension and activity bar icons.
- Made the INIValidator download URL configurable.
- Fixed duplicate registry key detection so it now correctly fires.
- Fixed missing localized strings displaying as `!key!` instead of readable text.

## [0.0.4] - 2026-06-09

- Added LLF language support with its own grammar and token colors for labels, values, comments, and multiline continuations.
- Added dedicated INI and MIX explorer views in the activity bar, backed by lazy loading so large archives and workspaces stay responsive.
- Added a virtual `ra2mix:` file system with open-as-workspace support for `.mix` archives, including opening in a new window.
- Added MIX archive management commands for import, export, rename, delete, folder creation, and save-all style workflows inside the explorer.
- Added default-open resource previews for `pcx`, `pal`, `map`, `mpr`, `yrm`, `shp`, `vxl`, and `hva` files through a custom editor.
- Added CSF outline browsing so localized string entries can be inspected directly from the extension side bar.
- Added a dedicated resource comparison workflow for MIX archives and folders, including recursive scans, result summaries, filtering, text diffs, and direct open actions.
- Reworked the resource explorer layout to focus on INI files, MIX files, and CSF content instead of the older all-in-one outline view.
- Improved SHP preview behavior with palette selection and better fallback handling for missing palettes.
- Upgraded VXL/HVA previews with both slice and perspective/game-style rendering modes.
- Switched voxel previews to open in the gameplay-oriented view by default for a more representative first impression.
- Refined voxel interaction with orbit, pan, zoom, limb switching, camera reset, tighter overlay controls, and a layout that adapts better to smaller editor sizes.

## [0.0.3] - 2025-11-22

- Added a localized welcome page and setup wizard to guide first-time schema and project configuration.
- Added automatic section registration helpers to speed up registry maintenance workflows.
- Added per-error-code diagnostic severity overrides so each rule can be downgraded, promoted, or disabled individually.
- Switched to the RA2-specific `ra2-ini` language identity, semantic token defaults, and improved scope naming for more reliable highlighting.
- Replaced the older custom theme-driven coloring approach with the official semantic-highlighting path for better editor compatibility.
- Improved diagnostics performance by moving from whole-document refreshes to incremental parsing with visible-range priority.
- Reworked indexing rules from a flat include list into file-category based matching such as Rules, Art, Sound, UI, Theme, and AI.

## [0.0.2] - 2025-11-13

- Added schema-driven IntelliSense for RA2 INI files, including key completion, typed hover details, and cross-file go-to-definition.
- Added support for `INIValidator.exe`, including configurable executable and validation root paths.
- Added an INI project explorer view in the activity bar for browsing indexed sections.
- Added CodeLens reference counts above sections and an override indicator for inherited keys.
- Added configurable built-in diagnostics for whitespace, comments, and value validation behavior.
- Added customizable syntax colors, a schema path command, debug helpers, and command-based validator management.
- Added language registration for `.ini` files under a dedicated RA2-oriented language mode.
- Expanded configuration options for indexed files, validator targets, and editor behavior.
- Improved command surface and context menu integration for common INI editing workflows.

## [0.0.1] - 2024-12-28

### Added

- Initial marketplace release.
- Added syntax highlighting for INI sections, keys, values, and comments, including support for more complex `[]:[]` section syntax.
- Added hover tooltips for section and value descriptions.
- Added basic diagnostics for common spacing and comment-style issues.
- Added section folding support.
- Added jump-to-definition for related INI keys and values.
