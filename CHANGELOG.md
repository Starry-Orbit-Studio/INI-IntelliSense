[Read this in Chinese (简体中文)](./CHANGELOG.zh-cn.md)

# Change Log

## [Unreleased]

- Added a visual dictionary editor with searchable types, tags and descriptions, inherited sources, numbered keys, typed constraints, multilingual Markdown, project examples, native undo and conflict-safe edits. Downloaded dictionaries can be copied into the project for customization.
- Added configurable include/parent cycle and missing-file checks, registered reference type checks, empty list members, numbered-key bounds, file-purpose checks and registry integrity checks; defer context-dependent results while loading is incomplete and treat intentional overrides/empty values as informational.

- Split the top-level project page into Overview and Project configuration, with direct entry/file/directory pickers, reorderable lists, file categories, display toggles and map renderer inputs.
- Keep the check center focused on results, rules/file exceptions and the external checker; remove duplicate general settings and hide compatibility switches behind the unified rules.
- Show configuration destinations and effective sources, preserve drafts, restore inheritance, detect external edits, roll back failed batches and check saved paths without running programs. Resolve dictionary/checker configuration in the selected project.

- Add a sidebar INI check center between resource checks and project settings, with rule levels, presets, configuration scopes, file exceptions, searchable results and source navigation.
- Share entry/include resolution across contextual editing, isolate non-loaded files, and expose compatibility modes and per-file categories.
- Add upstream/downstream logic exploration using effective typed references, inheritance, conditions and source locations, with search, bounded expansion and missing/stale indicators.
- Restore Tag documentation and inherited descriptions with bundled English/Chinese fallback; add boolean and repeated-key checks and fix configuration commands, diagnostic refresh and overlapping semantic tokens.

- Use INI terminology `VehicleType` for vehicle type labels and searches while retaining compatibility with existing dictionaries.
- Upgrade the extension sidebar into a project workbench with semantic object categories, cross-category search, recent items, maps and project overview/settings; keep file and archive tools available in collapsed views.
- Keep object previews in the bottom panel, preserve catalogue navigation, and separate sound events and auxiliary definitions from registered game objects.
- Fix map thumbnail LZO decoding, RGB channel order and preview dimensions; reject corrupt streams instead of displaying zero-filled images.

- Add a searchable, filterable project object catalogue with favorites, configurable property columns, object comparison and reviewed batch numeric changes.
- Add effective-property provenance and local override editing with comment preservation, native undo, dictionary constraints and stale-edit protection.
- Resolve configured project entry INIs and their include graphs, with explicit context and missing-file reporting.
- Keep primary and secondary VXL lighting fixed relative to the inspection camera without changing authored INI values; add reference images and perspective panorama skies.
- Open map title-bar previews in the bottom-panel map inspector, with embedded radar imagery, metadata and section navigation. Optionally render unsaved map text through a cancellable CNCMaps worker backend.
- Recover asset workbench opening when generated view commands are missing after an update, wait for the inspector to initialize, and keep automatic reveal retryable after failures. Show a reload action when VS Code has not registered the new view.

## [0.0.6] - 2026-10-11

- Add a bottom-panel asset workbench that follows the cursor, showing media, effective properties, inheritance and reference sources, with pinning and automatic reveal.
- Add inline thumbnails and animated media hovers with audio audition; show normal and elite cameos expanded by default.
- Resolve dictionary-driven media references and individual list members, with custom rules and declared-target inference for untyped tags.
- Resolve rules/art and assets across includes, inheritance and unsaved text, with split Rules/Resources layouts and background indexing.
- Expand SHP playback, frame stepping, directions, speed, shadows and contact sheets; share a trimmed canvas across frames for stable animation positions.
- Preview infantry action/direction combinations and edit sequences, preserving extra fields and comments, reporting invalid bounds and supporting native undo.
- Expand VXL/HVA assembly and animation with part visibility, turret heading, TurretOffset placement and FireAngle elevation.
- Provide game orthographic and free perspective views with game projection/pixel-scale defaults, rotation, pan, zoom and reset.
- Use RA2 normals, project VPL and Phobos lighting settings, with spherical light adjustment and writeback; keep lights fixed during camera rotation.
- Add visual FLH editing for standard, elite, numbered weapon, burst and AlternateFLH points, with point/axis dragging, visibility and undo.
- Compose building bodies, Bibs, buildup and foundation grids, with normal/damaged frame selection and Bibs hidden during construction.
- Preview building active, idle, production, door, deploying, upgrade and four special/superweapon animation groups, with combined states and layer sources.
- Compose SHP buildings with SHP/voxel turrets and building/global DamageFireTypes effects, including editable fire points.
- Add theater selection synchronized across building bodies, attachments, Bibs, buildup, palettes, hovers and inspector previews.
- Resolve default/explicit palettes by purpose, with independent building-animation palettes and palette search; remap only technos and eligible drawers, preserving ordinary animation/particle/cameo colors.
- Support assets and IDX/BAG/WAV audio in directories and nested/encrypted MIX archives, with sound-event resolution, sample audition, volume and loop controls.
- Add a searchable asset library and complete source lists, configurable resource priority, synchronized preview comparison and PNG/decoded-WAV export.
- Add media reference replacement, definition/incoming-reference links and on-demand resource audits; update English/Chinese user documentation and the workbench development guide.

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
