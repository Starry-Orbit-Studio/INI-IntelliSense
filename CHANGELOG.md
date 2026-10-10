[Read this in Chinese (简体中文)](./CHANGELOG.zh-cn.md)

# Change Log

All notable changes to the "ra2-ini-intellisense" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
