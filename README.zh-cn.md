[Read this in English](./README.md)

# INI IntelliSense for Red Alert 2

**INI IntelliSense** 是一个为《命令与征服: 红色警戒2》Mod开发量身打造的、功能强大的 Visual Studio Code 扩展。它旨在通过提供现代化的代码编辑体验，如动态语法高亮、深度智能感知、高级诊断和直观的继承关系可视化，来革命性地提升您在 `.ini` 配置文件上的工作效率和代码质量。

---

## 主要功能 (Key Features)

### 1. 动态语法高亮 (Dynamic Syntax Highlighting)
超越传统静态语法文件，本扩展通过代码动态分析，提供更精确、更丰富的着色效果。
- **支持多级键**: 为 `Key.Part1.Part2` 的不同部分应用不同颜色。
- **复杂节语法**: 精确高亮 `[Section]:[Inherits]` 结构。
- **默认启用语义着色**: 为 RA2 INI 提供开箱即用的语义 Token 配色，并为 `.llf` 资源提供专门的高亮规则。

### 2. Schema 驱动的智能感知 (Schema-Driven IntelliSense)
本扩展的核心能力由一个可配置的规则文件 (`INICodingCheck.ini`) 驱动，提供无与伦比的上下文感知能力。
- **代码自动补全 (Auto-Completion)**:
    - **键 (Keys)**: 根据当前节的类型（包含继承），智能提示所有可用的键。
    - **值 (Values)**: 为布尔值 (`yes`/`no`)、颜色、以及所有在 `[Registries]` 中注册的ID（如单位、建筑、武器名等）提供补全。
- **悬停信息 (Hover Information)**:
    - **类型与来源**: 悬停在键上时，显示其在 Schema 中定义的类型 (e.g., `TechLevel: int`) 以及**来源**（如 `Ares`, `Phobos` 或原版），让您明确知道该功能来自哪个平台。
    - **CSF 预览**: 如果一个值引用了 CSF 字符串（例如 `UIName=Name:Apoc`），悬停时将直接显示对应的中文/英文文本（如“天启坦克”）。
    - **继承覆盖详情**: 当一个键覆盖了父节的值时，悬停信息会明确展示**被覆盖的父节名称、所在文件、行号以及旧的值**，并提供一键跳转链接。
- **跳转到定义 (Go to Definition)**:
    - 按住 `Ctrl` 并单击一个值（如单位ID），即可跨文件跳转到该单位的 `[Section]` 定义处。

### 3. 高级诊断与校验 (Advanced Diagnostics)
- **内置实时检查**:
    - **代码风格**: 检查等号周围、行首的多余空格；检查注释前后的空格是否规范。
    - **类型校验**: 根据 Schema 实时验证值的类型是否正确（如 `int`, `float`, 数值范围, 枚举值等）。
- **外部校验器集成**:
    - 与 `INIValidator.exe` 无缝集成，提供更深层次的、跨文件的逻辑有效性检查。可通过状态栏图标或命令轻松管理和运行。

### 4. 继承与引用可视化 (Inheritance & Reference Visualization)
- **继承覆盖指示器**: 在行号旁显示一个清晰的向上箭头 (↑)，直观地告诉您这一行的键覆盖了父类中的定义。
- **代码透镜 (CodeLens)**: 在每个节 `[Section]` 的上方，显示该节在整个工作区中被作为“值”引用的次数和被“继承”的次数。
- **查找所有引用 (Find All References)**: 右键点击一个节名，即可找到所有引用或继承它的地方。

### 5. 其他实用功能 (More Handy Features)
- **MIX 档案浏览器**: 在专属视图中浏览 `.mix` 档案，并可直接作为工作区打开，或在新窗口中打开。
- **MIX 资源操作**: 可直接在 VS Code 中导入、导出、重命名、删除和整理档案内容。
- **资源预览器**: 内置预览 `pcx`、`pal`、`map`、`mpr`、`yrm`、`shp`、`vxl` 和 `hva` 文件。
- **体素预览工作流**: 既支持切片模式，也支持更接近游戏内观感的 3D 预览，并提供旋转、平移、缩放、部件切换和相机重置等操作。
- **资源对比**: 可递归比较文件夹与 MIX 档案，支持筛选结果并直接跳转到差异视图或文件打开操作。
- **CSF 文件原生支持**: 内置 `.csf` 二进制文件解析器，自动索引工作区内的字符串表，为悬停预览、补全和专属 CSF 大纲视图提供数据支持。
- **LLF 文件支持**: 为 `.llf` 文件提供专门语法高亮，改善标签、注释和多行文本的可读性。
- **颜色拾取器**: 为 `R,G,B` 格式的颜色值提供可视化颜色选择器和预览。
- **INI 项目浏览器**: 在活动栏提供一个专属视图，以树状结构清晰地展示您工作区内所有被索引的 INI 文件及其内部结构（节、键），方便快速导航。
- **代码折叠**: 支持按 `[Section]` 折叠代码块。
- **性能优化**: 通过可配置的文件索引规则，插件只会扫描您指定的 `*.ini` 文件（默认只扫描根目录下的核心游戏文件），在大型工作区中也能保持极速响应。

---

## 安装与配置 (Installation & Configuration)

### 安装 (Installation)
1. 从 Visual Studio Marketplace 安装，或从发布页面下载最新的 `.vsix` 文件。
2. 在 VS Code 中，打开扩展面板 (`Ctrl+Shift+X`)。
3. 点击右上角的三点菜单 (`...`)，选择 “**从 VSIX 安装...**” (Install from VSIX...)。
4. 选择您下载的 `.vsix` 文件并安装。
5. 重新加载 VS Code。

### 初始配置 (Initial Setup)
为了获得完整的智能提示和诊断功能，您需要配置 Schema 文件 (`INICodingCheck.ini`) 和 Mod 根目录。
1. 插件首次激活时会自动弹出 **设置向导 (Setup Wizard)**。
2. 您也可以点击状态栏的 `$(rocket) INI: 显示设置向导` 或使用命令重新打开它。
3. 向导将帮助您一键下载包含最新 Ares/Phobos 支持的官方字典，并自动识别您的工作区路径。

---

## 诊断错误码 (Diagnostic Error Codes)

您可以在 `ra2-ini-intellisense.diagnostics.severity` 设置中使用这些代码来自定义每条规则的报错等级 (Error, Warning, Information, Hint, None)。

| 错误码 | 分类 | 描述 |
| :--- | :--- | :--- |
| **STYLE-101** | 风格 | 行首存在不必要的空格。 |
| **STYLE-102** | 风格 | 等号 `=` 左侧有多余空格。 |
| **STYLE-103** | 风格 | 等号 `=` 右侧有多余空格。 |
| **STYLE-104** | 风格 | 注释符号 `;` 前的空格数量不正确。 |
| **STYLE-105** | 风格 | 注释符号 `;` 后缺少空格。 |
| | | |
| **TYPE-201** | 类型 | 无效的整数值。 |
| **TYPE-202** | 类型 | 无效的浮点数值。 |
| **TYPE-203** | 类型 | 数值超出允许范围 (最大/最小)。 |
| **TYPE-204** | 类型 | 值不在允许的列表中 (枚举)。 |
| **TYPE-205** | 类型 | 值不符合前缀要求。 |
| **TYPE-206** | 类型 | 值不符合后缀要求。 |
| **TYPE-207** | 类型 | 列表长度无效 (太短/太长)。 |
| | | |
| **LOGIC-301** | 逻辑 | 引用了不存在的节。 |
| **LOGIC-303** | 逻辑 | 键的值为空。 |
| **LOGIC-304** | 逻辑 | 注册表列表中存在重复的键 (例如 `0=A`, `0=B`)。 |

## 详细配置项 (Settings)
您可以在 VS Code 的 `settings.json` 文件中对本插件进行详细配置 (`Ctrl+,`)。

| 设置 (Setting) | 描述 (Description) | 默认值 (Default) |
| :--- | :--- | :--- |
| **`ra2-ini-intellisense.schemaFilePath`** | INI 规则定义文件 (`INICodingCheck.ini`) 的绝对路径。这是智能感知的核心。 | `null` |
| **`ra2-ini-intellisense.validationFolderPath`** | `INIValidator.exe` 和文件索引的根目录（通常是您的Mod根目录）。 | `null` |
| | |
| `ra2-ini-intellisense.indexing.fileCategories` | 定义文件分类（如 Rules, Art）及其对应的 Glob 模式。用于提供上下文感知的智能提示。 | `{ "rules": ["rules*.ini"], ... }` |
| `ra2-ini-intellisense.indexing.excludePatterns` | 一个Glob模式数组，用于从已包含的文件中排除特定文件或目录。 | `[]` |
| | |
| `ra2-ini-intellisense.decorations.overrideIndicator.enabled` | 是否启用继承覆盖指示器（行号旁的箭头图标）。 | `true` |
| `ra2-ini-intellisense.codeLens.enabled` | 是否在节上方显示代码透镜（引用计数）。 | `true` |
| | |
| `ra2-ini-intellisense.diagnostics.enabled` | 是否启用所有内置的诊断检查。 | `true` |
| `ra2-ini-intellisense.diagnostics.severity` | 自定义特定错误码的等级（如 `{"STYLE-101": "Information"}`）。 | `{}` |
| `ra2-ini-intellisense.diagnostics.spacesBeforeComment` | 注释符号 `;` 前应有的空格数。设为 `null` 可禁用。 | `1` |
| | |
| `ra2-ini-intellisense.exePath` | `INIValidator.exe` 的绝对路径。 | `null` |
| `ra2-ini-intellisense.validationFiles` | `INIValidator.exe` 需要校验的文件列表。 | `{...}` |

RA2 INI 的语义着色，以及 `.llf` 的默认 TextMate 配色，也可以通过 VS Code 标准的 `editor.semanticTokenColorCustomizations` 与 `editor.tokenColorCustomizations` 进一步覆盖。

---

## 📄 许可证 (License)
本项目采用 MIT 许可证。详情请查看 `LICENSE` 文件。
