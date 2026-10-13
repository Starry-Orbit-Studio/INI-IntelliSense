[Read this in Chinese (简体中文)](./README.zh-cn.md)

# RA2 Mod IntelliSense for Red Alert 2

The RA2 sidebar is your project workbench: browse game objects, search across definitions, open maps, and inspect project settings. Selecting an object shows its media in the bottom panel; comparison and batch editing stay in the project tab.

**RA2 Mod IntelliSense** is a powerful, feature-rich Visual Studio Code extension tailor-made for *Command & Conquer: Red Alert 2* mod development. It aims to revolutionize your workflow on `.ini` configuration files by providing a modern coding experience, including dynamic syntax highlighting, deep language intelligence, advanced diagnostics, and intuitive inheritance visualization.

---

The **INI check center** in the sidebar collects results, configures individual rule levels and exposes extension settings. **Logic chain** in the editor context menu explores incoming/outgoing typed references and opens their producing Tags. Configure **Project entry INIs** separately from **Set INI file category**; files outside the loading chain retain editor features without overriding game definitions. See [checks and logic chains](docs/asset-workbench.md#ini-checks-and-logic-chains).


## Key Features

### Asset Workbench and Cursor-following Inspector

**Browse project objects** opens a searchable, filterable catalogue with favorites, configurable property columns, object comparison and reviewed set/add/percentage batch changes. The inspector's **Attributes** tab exposes effective and overridden declarations, local override editing and native undo. Dictionary constraints and document snapshots are checked before writes. **Configure project entry INIs** limits rules/art/sound resolution to explicit roots and includes, with missing sources reported in the context summary.

Previews support reference images and perspective panorama skies, with primary and auxiliary voxel lighting fixed relative to the camera. The map title-bar preview opens a bottom-panel inspector with zoom, pan, metadata and section links. Full rendering optionally uses the CNCMaps worker protocol shared with `ra2rmg-rs`; configure a compatible executable and game resources. Embedded radar imagery and freshly rendered maps are labeled separately. See the [configuration examples](docs/asset-workbench.md).

The **Asset Workbench** defaults to the bottom panel and reveals once on the first valid resource section while preserving editor focus. Closing it does not cause repeated popups. Cursor movement resolves the section type, effective properties, inheritance sources, icon and assets. Pin an object or move the view to your preferred location. Section headers and image references support inline thumbnails; reference hovers show animated PNG images with actions appropriate to the media type.

- **Precise references**: target the selected member of `AnimList`, resolve `VoiceMove` through sound sections, and audition individual whitespace/comma-separated `Sounds` samples.
- **Dictionary-driven semantics**: supports `Sound`, `AnimType`, `Shape`, `SHPFile`, `PCXFile`, `PALFile` and object references. Add contextual rules through `media.semanticRules` without changing a renderer.
- **SHP**: animation, frame stepping, directions, speed, contextual house colors, shadows, palette selection and paginated contact sheets. Edit sequence start/count/direction stride while retaining extra fields and comments; shared actions and frame bounds are reported.
- **VXL/HVA**: WebGL2 instancing, isometric/free perspective/normal/slice views, body/turret/barrel assembly, HVA playback, independent limb visibility and turret heading. Uses authored normals, VPL and palettes. Reads and edits `VoxelLightSource` and `UseFixedVoxelLighting` in `[AudioVisual]`.
- **FLH**: unobtrusive model points with names and coordinates beside the preview, plus a visibility toggle. Click a point or select its name to reveal that point's edit axes and firing ray. Coordinates use an adjustable scale; INI edits use native undo and do not save automatically.
- **Building and animation scenes**: NewTheater/Theater filenames, body, buildup, attached animations, damaged/production states and foundation grids, with layer visibility and resolution traces. Ordinary animation scenes expand ConcurrentAnim and Next; building attachments only expand concurrent animations. Infantry/building shadow defaults respect Shadow and available frame layout. Bibs, theater selection, SHP/voxel turrets and editable damage-fire points are composed; AlphaImage and full particle systems are not simulated; animation chains use deterministic previews rather than simulating probability or the complete game state machine.
- **Game scale and lighting**: voxel game view defaults to the game angle and 100% pixel scale, with a separate fit-to-window action. Drag the light orb to update numeric light coordinates, restore game/project values or explicitly apply edits. Static voxels hide playback; multi-frame HVA exposes a timeline.
- **Library and tools**: searchable, paginated assets and thumbnails, source selection, synchronized snapshot comparison, PNG/decoded-WAV export, semantic reference replacement, definition links and incoming references. Run **Check project resources** explicitly to report missing or ambiguous resources and invalid actions.
- **Audio**: WAV from directories/MIX and PCM/IMA ADPCM samples from IDX/BAG, with playback, volume, loop and random audition. MP3/OGG/FLAC depend on the VS Code Webview's available codecs.

House colors follow the game drawer: technos and building animations using the unit drawer remap, while ordinary animations require `AltPalette=yes`. Ordinary animations, particles, cameos and unclassified SHPs preserve original palette colors. A custom palette alone does not determine remapping. Inspector frames, hovers, contact sheets, comparisons and exports share this policy.

Split layouts such as `ES/Rules` and `ES/Resources` share a mod-root catalog even when only a child folder is open, including root MIX archives and sibling resource change monitoring. Nested INIs and directly opened assets resolve the same root; `validationFolderPath` can explicitly identify their project. Project files take priority over MIX archives; configure additional directories with `ra2-ini-intellisense.media.resourceRoots` and archive precedence with `media.archiveOrder` (MIX filenames, highest first). All source candidates are visible, with backup sources ranked lower. `media.excludedDirectories` defaults to `.tmp`, `.cache` and `Tools`. Background indexing discovers INI includes, MIX directories and sound mappings; selected media and audio samples decode on demand. Cold hovers return a quick entry while the thumbnail is prepared. Nested MIX and encrypted MIX read access are supported. Unsaved INI text participates in resolution; separate workspace projects remain isolated. Categorize custom rules/art/sound filenames through the existing file category settings.

Rendering approximates the game and should be verified in game. Previews consistently use the RA2 game normal table, including RA2 assets retaining legacy mode metadata. FLH previews do not simulate the complete firing logic. Bounds: 4M image pixels, 1,000,000 voxels per decoded or assembled model, 2,000 INIs on initial context load, 100,000 catalog entries/16 directory levels, 10,000 library entries and 2,000 references per audit. Heavy decoding runs in workers; project audits run on demand.

See [Asset Workbench architecture and development](docs/asset-workbench.md) for configuration examples, implementation boundaries and verification commands.

### Files and MIX browser

Open Files and MIX from the project sidebar for a directory/archive browser that defaults to one pane, with optional dual panes and native editor groups. Selection uses the shared bottom preview, including searchable CSF/LLF string tables. Supports nested navigation, virtualized lists, multi-selection, lasso, drag/drop, copy/cut/paste, extraction, conflict handling, undo and content comparison. Save archive INIs through the native editor with nested writeback. Content detection recognizes MIX renamed to DLL/BIG while leaving ordinary DLLs alone.

### 1. Dynamic Syntax Highlighting
Going beyond traditional static syntax files, this extension provides more accurate and richer coloring through dynamic code analysis.
- **Multi-level Keys**: Applies different colors to different parts of `Key.Part1.Part2`.
- **Complex Section Syntax**: Accurately highlights the `[Section]:[Inherits]` structure.
- **Semantic Colors Enabled by Default**: The extension ships with semantic token defaults for RA2 INI files and dedicated token colors for `.llf` resources.

### 2. Schema-Driven IntelliSense
The core capabilities of this extension are driven by a configurable rule file (`INIDictionary.ini`), providing unparalleled contextual awareness.
- **Auto-Completion**:
    - **Keys**: Intelligently suggests all available keys based on the current section's type (including inheritance).
    - **Values**: Provides completion for boolean values (`yes`/`no`), colors, and all IDs registered in `[Registries]` (e.g., unit, building, weapon names).
- **Hover Information**:
    - **Type & Source**: Displays the key's type (e.g., `TechLevel: int`) and its source (e.g., `Ares`, `Phobos`, or Original Game), helping you distinguish between vanilla and extension features.
    - **CSF Preview**: If a value refers to a CSF string (e.g., `UIName=Name:Apoc`), hovering will show the actual localized text (e.g., "Apocalypse Tank").
    - **Override Details**: When a key overrides a value from a parent section, the hover information clearly shows the **overridden parent section's name, file, line number, and the old value**, with a one-click link to jump to it.
- **Go to Definition**:
    - Hold `Ctrl` and click on a value (like a unit ID) to jump across files to that unit's `[Section]` definition.

### 3. Advanced Diagnostics
- **Built-in Real-time Checks**:
    - **Code Style**: Checks for extra spaces around the equals sign, leading whitespace; ensures proper spacing before/after comments.
    - **Type Validation**: Validates value types in real-time against the schema (e.g., `int`, `float`, numeric ranges, enum values).
- **External Validator Integration**:
    - Seamlessly integrates with `INIValidator.exe` for deeper, cross-file logical validation. Easily manage and run it via a status bar icon or command.

### 4. Inheritance & Reference Visualization
- **Override Indicator**: Displays a clear up-arrow (↑) next to the line number, intuitively showing that the key on this line overrides a definition from a parent class.
- **CodeLens**: Above each `[Section]`, it shows how many times that section is referenced as a "value" and "inherited from" across the entire workspace.
- **Find All References**: Right-click a section name to find all places that reference or inherit from it.

### 5. More Handy Features
- **MIX Archive Explorer**: Browse `.mix` archives from a dedicated explorer view, open them as workspaces, or open them in a new window.
- **MIX Resource Operations**: Import, export, rename, delete, and organize archive contents without leaving VS Code.
- **Resource Previews**: Open `pcx`, `pal`, `map`, `mpr`, `yrm`, `shp`, `vxl`, and `hva` files in a built-in preview editor.
- **Voxel Preview Workflow**: Inspect voxel assets in slice mode or a gameplay-style 3D preview with orbit, pan, zoom, limb switching, and camera reset controls.
- **Resource Comparison**: Compare folders and MIX archives recursively, filter the result set, and jump straight into diffs or direct file opens.
- **CSF File Support**: Native support for parsing binary `.csf` string files in your workspace, powering hover previews and a dedicated CSF outline view.
- **LLF File Support**: Dedicated grammar support for `.llf` files with readable highlighting for labels, comments, and multiline values.
- **Color Picker**: Provides a visual color picker and preview for `R,G,B` formatted color values.
- **INI Project Explorer**: A dedicated view in the activity bar that clearly displays all indexed INI files and their internal structure (sections, keys) in a tree, for quick navigation.
- **Code Folding**: Supports folding code blocks by `[Section]`.
- **Performance Optimized**: With configurable file indexing rules, the extension only scans the `*.ini` files you specify (by default, only core game files in the root), ensuring swift response even in large workspaces.

---

## Installation & Configuration

### Installation
1. Install from the Visual Studio Marketplace, or download the latest `.vsix` file from the release page.
2. In VS Code, open the Extensions view (`Ctrl+Shift+X`).
3. Click the three-dots menu (`...`) in the top-right corner and select "**Install from VSIX...**".
4. Choose the `.vsix` file you downloaded and install it.
5. Reload VS Code.

### Initial Setup
To get full IntelliSense and diagnostics, you need to configure the dictionary file (`INIDictionary.ini`) and your Mod root directory.
1. The extension will prompt you with a **Setup Wizard** upon first activation.
2. You can also click the `$(rocket) INI: Show Setup Guide` command or use the status bar menu to reopen the wizard.
3. The wizard helps you download the official dictionary (with latest Ares/Phobos support) and set up your workspace paths automatically.

---

## Diagnostic Error Codes

You can use these codes in `ra2-ini-intellisense.diagnostics.severity` to customize the error level (Error, Warning, Information, Hint, None) for each rule.

| Code | Category | Description |
| :--- | :--- | :--- |
| **S001** | Style | Unnecessary leading whitespace at the beginning of the line. |
| **S002** | Style | Extra spaces before the `=` sign. |
| **S003** | Style | Extra spaces after the `=` sign. |
| **S004** | Style | Incorrect number of spaces before a comment (`;`). |
| **S005** | Style | Missing space after a comment (`;`). |
| | | |
| **T001** | Type | Invalid integer value. |
| **T002** | Type | Invalid floating-point value. |
| **T003** | Type | Number out of range (min/max). |
| **T004** | Type | Value not in allowed list (Enumeration). |
| **T005** | Type | Value does not match required prefix. |
| **T006** | Type | Value does not match required suffix. |
| **T007** | Type | List has invalid length (too short/long). |
| | | |
| **L001** | Logic | Reference to an undefined section. |
| **L002** | Logic | Unregistered section in an ID list (currently inactive — reserved). |
| **L003** | Logic | Key has an empty value. |
| **L004** | Logic | Duplicate key in a registry list (e.g., `0=A`, `0=B`). |

## Commands

| Command | Title | Description |
| :--- | :--- | :--- |
| `ra2-ini-intellisense.showMainQuickPick` | INI: Show Main Menu | Opens the main quick-pick menu for all extension actions. |
| `ra2-ini-intellisense.showWelcomePage` | INI: Show Setup Guide | Reopens the first-time configuration wizard. |
| `ra2-ini-intellisense.configureSchemaPath` | INI: Set INI Dictionary File Path | Sets the path to the INI Dictionary file. |
| `ra2-ini-intellisense.format.document` | Format Document | Formats the active INI document (also via `Shift+Alt+F`). |
| `ra2-ini-intellisense.format.selection` | Format Selection/Line | Formats the selected lines or the current line. |
| `ra2-ini-intellisense.previewMapToSide` | Preview Map | Opens the map preview image in a side panel (`.map`, `.mpr`, `.yrm`). |
| `ra2-ini-intellisense.refactor.extractSuperclass` | Extract Superclass... | Extracts common key-value pairs into a new parent section. |
| `ra2-ini-intellisense.registerSectionContext` | Register Section ID to... | Registers the current section into an ID list registry. |
| `ra2-ini-intellisense.jumpToOverride` | INI: Go to Overridden Definition | Jumps to the parent definition of an overridden key. |
| `ra2-ini-intellisense.manageValidator` | INI: Manage INI Validator | Opens the INIValidator configuration panel. |
| `ra2-ini-intellisense.runValidator` | INI: Run INI Validator | Runs INIValidator on the configured validation files. |
| `ra2-ini-intellisense.compareResources` | Resources: Compare Two Sources | Compares two MIX archives or folders recursively. |
| `ra2-ini-intellisense.showDebugInfo` | INI: Show Current Context Debug Info | Shows diagnostic info about the current cursor context. |
| `ra2-ini-intellisense.refreshIniFiles` | Refresh INI Files | Refreshes the INI Files tree view. |
| `ra2-ini-intellisense.refreshMixFiles` | Refresh MIX Files | Refreshes the MIX Files tree view. |
| `ra2-ini-intellisense.refreshCsfOutline` | Refresh CSF Outline | Refreshes the CSF Outline tree view. |

## Settings
You can configure this extension in detail in your VS Code `settings.json` file (`Ctrl+,`).

| Setting | Description | Default |
| :--- | :--- | :--- |
| **`ra2-ini-intellisense.schemaFilePath`** | Absolute path to the INI rule definition file (`INIDictionary.ini`). This is the core of the IntelliSense. | `null` |
| **`ra2-ini-intellisense.validationFolderPath`** | Root directory for `INIValidator.exe` and file indexing (usually your Mod's root directory). | `null` |
| | |
| `ra2-ini-intellisense.indexing.fileCategories` | Defines file categories (e.g., Rules, Art) and their corresponding Glob patterns. Used for context-aware IntelliSense. | `{ "rules": ["rules*.ini"], ... }` |
| `ra2-ini-intellisense.indexing.excludePatterns` | An array of Glob patterns to exclude files from the included set. | `[]` |
| | |
| `ra2-ini-intellisense.decorations.overrideIndicator.enabled` | Enables the inheritance override indicator (arrow icon next to the line number). | `true` |
| `ra2-ini-intellisense.codeLens.enabled` | Shows CodeLens (reference counts) above sections. | `true` |
| | |
| `ra2-ini-intellisense.diagnostics.enabled` | Enables all built-in diagnostic checks. | `true` |
| `ra2-ini-intellisense.diagnostics.severity` | Customize severity for specific error codes (e.g. `{"S001": "Information"}`). | `{}` |
| `ra2-ini-intellisense.diagnostics.spaceBeforeEquals` | Check and warn about extra spaces before `=`. | `true` |
| `ra2-ini-intellisense.diagnostics.spaceAfterEquals` | Check and warn about extra spaces after `=`. | `true` |
| `ra2-ini-intellisense.diagnostics.leadingWhitespace` | Check and warn about unnecessary leading whitespace on lines. | `true` |
| `ra2-ini-intellisense.diagnostics.spaceAfterComment` | Check and warn about missing space after `;`. | `true` |
| `ra2-ini-intellisense.diagnostics.spacesBeforeComment` | The number of spaces required before a `;` comment symbol. Set to `null` to disable. | `1` |
| | |
| `ra2-ini-intellisense.exePath` | Absolute path to `INIValidator.exe`. | `null` |
| `ra2-ini-intellisense.validationFiles` | List of files for `INIValidator.exe` to check. | `{...}` |
| `ra2-ini-intellisense.iniValidator.downloadUrl` | Download page URL for INIValidator. Override if the default mirror is inaccessible. | `"https://..."` |
| `ra2-ini-intellisense.dontAskToConfigureValidator` | Suppress the startup prompt to configure INIValidator. | `false` |
| `ra2-ini-intellisense.dontAskToConfigureProject` | Suppress the startup prompt to configure the project. | `false` |

Semantic colors for RA2 INI tokens and the default TextMate colors for `.llf` can also be overridden through VS Code's standard `editor.semanticTokenColorCustomizations` and `editor.tokenColorCustomizations` settings.

---

## Author

**StarryOrbitStudio (星轨实验室)**

Maintained by **Astralette (小星星)**.

---

## License
This project is licensed under the MIT License. See the `LICENSE` file for details.

The top-level Project overview and settings page has Overview and Project configuration tabs, with typed controls for loading entries, resource directories/archive priority, dictionaries, preview preferences and map rendering. Configuration destinations and effective sources are explicit; grouped changes require Apply and isolated toggles save immediately. The check center contains results, rules/file exceptions and external-checker configuration, retaining existing rule preferences transparently.

### Dictionary authoring and contextual checks

Open **Dictionary editor** from the project workbench or an INI tag’s context menu. Search tags, descriptions, types and sources; edit inherited definitions, numbered keys, ranges, enumerations, lists, registries and multilingual Markdown. Editing an inherited tag creates an override in the current dictionary.

**Apply changes** updates unsaved VS Code documents and supports native undo. **Save and reload** saves dictionary and description documents and refreshes the extension. The visual and text editors share documents; stale edits are rejected. Downloaded dictionaries are read-only in the visual editor; **Create project copy** preserves customization across dictionary downloads.

The check center includes `C001–C004` for include/parent loading and cycles, `T009–T010` for registered reference types and empty list members, and `L007–L010` for numbered ranges, file purposes and registry integrity. Rules support severity overrides and file exceptions. Vanilla mode skips extension loading syntax; incomplete contexts defer dependent conclusions, and dictionary `CheckExist=false` declarations are respected.
