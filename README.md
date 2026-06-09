[Read this in Chinese (简体中文)](./README.zh-cn.md)

# INI IntelliSense for Red Alert 2

**INI IntelliSense** is a powerful, feature-rich Visual Studio Code extension tailor-made for *Command & Conquer: Red Alert 2* mod development. It aims to revolutionize your workflow on `.ini` configuration files by providing a modern coding experience, including dynamic syntax highlighting, deep language intelligence, advanced diagnostics, and intuitive inheritance visualization.

---

## Key Features

### 1. Dynamic Syntax Highlighting
Going beyond traditional static syntax files, this extension provides more accurate and richer coloring through dynamic code analysis.
- **Multi-level Keys**: Applies different colors to different parts of `Key.Part1.Part2`.
- **Complex Section Syntax**: Accurately highlights the `[Section]:[Inherits]` structure.
- **Semantic Colors Enabled by Default**: The extension ships with semantic token defaults for RA2 INI files and dedicated token colors for `.llf` resources.

### 2. Schema-Driven IntelliSense
The core capabilities of this extension are driven by a configurable rule file (`INICodingCheck.ini`), providing unparalleled contextual awareness.
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
To get full IntelliSense and diagnostics, you need to configure the dictionary file (`INICodingCheck.ini`) and your Mod root directory.
1. The extension will prompt you with a **Setup Wizard** upon first activation.
2. You can also click the `$(rocket) INI: Show Setup Guide` command or use the status bar menu to reopen the wizard.
3. The wizard helps you download the official dictionary (with latest Ares/Phobos support) and set up your workspace paths automatically.

---

## Diagnostic Error Codes

You can use these codes in `ra2-ini-intellisense.diagnostics.severity` to customize the error level (Error, Warning, Information, Hint, None) for each rule.

| Code | Category | Description |
| :--- | :--- | :--- |
| **STYLE-101** | Style | Unnecessary leading whitespace at the beginning of the line. |
| **STYLE-102** | Style | Extra spaces before the `=` sign. |
| **STYLE-103** | Style | Extra spaces after the `=` sign. |
| **STYLE-104** | Style | Incorrect number of spaces before a comment (`;`). |
| **STYLE-105** | Style | Missing space after a comment (`;`). |
| | | |
| **TYPE-201** | Type | Invalid integer value. |
| **TYPE-202** | Type | Invalid floating-point value. |
| **TYPE-203** | Type | Number out of range (min/max). |
| **TYPE-204** | Type | Value not in allowed list (Enumeration). |
| **TYPE-205** | Type | Value does not match required prefix. |
| **TYPE-206** | Type | Value does not match required suffix. |
| **TYPE-207** | Type | List has invalid length (too short/long). |
| | | |
| **LOGIC-301** | Logic | Reference to an undefined section. |
| **LOGIC-303** | Logic | Key has an empty value. |
| **LOGIC-304** | Logic | Duplicate key in a registry list (e.g., `0=A`, `0=B`). |

## Settings
You can configure this extension in detail in your VS Code `settings.json` file (`Ctrl+,`).

| Setting | Description | Default |
| :--- | :--- | :--- |
| **`ra2-ini-intellisense.schemaFilePath`** | Absolute path to the INI rule definition file (`INICodingCheck.ini`). This is the core of the IntelliSense. | `null` |
| **`ra2-ini-intellisense.validationFolderPath`** | Root directory for `INIValidator.exe` and file indexing (usually your Mod's root directory). | `null` |
| | |
| `ra2-ini-intellisense.indexing.fileCategories` | Defines file categories (e.g., Rules, Art) and their corresponding Glob patterns. Used for context-aware IntelliSense. | `{ "rules": ["rules*.ini"], ... }` |
| `ra2-ini-intellisense.indexing.excludePatterns` | An array of Glob patterns to exclude files from the included set. | `[]` |
| | |
| `ra2-ini-intellisense.decorations.overrideIndicator.enabled` | Enables the inheritance override indicator (arrow icon next to the line number). | `true` |
| `ra2-ini-intellisense.codeLens.enabled` | Shows CodeLens (reference counts) above sections. | `true` |
| | |
| `ra2-ini-intellisense.diagnostics.enabled` | Enables all built-in diagnostic checks. | `true` |
| `ra2-ini-intellisense.diagnostics.severity` | Customize severity for specific error codes (e.g. `{"STYLE-101": "Information"}`). | `{}` |
| `ra2-ini-intellisense.diagnostics.spacesBeforeComment` | The number of spaces required before a `;` comment symbol. Set to `null` to disable. | `1` |
| | |
| `ra2-ini-intellisense.exePath` | Absolute path to `INIValidator.exe`. | `null` |
| `ra2-ini-intellisense.validationFiles` | List of files for `INIValidator.exe` to check. | `{...}` |

Semantic colors for RA2 INI tokens and the default TextMate colors for `.llf` can also be overridden through VS Code's standard `editor.semanticTokenColorCustomizations` and `editor.tokenColorCustomizations` settings.

---

## 📄 License
This project is licensed under the MIT License. See the `LICENSE` file for details.
