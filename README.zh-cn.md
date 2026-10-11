[Read this in English](./README.md)

# RA2 Mod IntelliSense for Red Alert 2

**RA2 Mod IntelliSense** 是一个为《命令与征服: 红色警戒2》Mod开发量身打造的、功能强大的 Visual Studio Code 扩展。它旨在通过提供现代化的代码编辑体验，如动态语法高亮、深度智能感知、高级诊断和直观的继承关系可视化，来革命性地提升您在 `.ini` 配置文件上的工作效率和代码质量。

---

## 主要功能

### 素材工作台与随光标检查器

命令 **浏览项目对象** 打开可搜索、筛选和收藏的对象目录，支持自定义属性列、选中对象对比，以及“设置为 / 增加数值 / 按百分比调整”的批量修改预览。底栏 **属性** 页可展开生效与被覆盖声明，编辑本地覆盖并原生撤销；应用前检查文件版本和字典约束。**配置项目入口 INI** 可限定 rules/art/sound 的入口与包含关系，缺失来源会在上下文中列出。

素材预览支持自选图片背景和 VXL 透视全景天空；主光照与辅助光照相对镜头保持固定。地图标题栏的预览按钮打开底栏地图检查器，可缩放、平移、查看地图属性和跳转章节。完整地图渲染可选接入与 `ra2rmg-rs` 相同协议的 CNCMaps worker，需要配置渲染器及游戏资源；内嵌雷达预览和完整渲染明确区分。详见[配置与使用示例](docs/asset-workbench.md)。

**素材工作台**默认位于底栏。光标首次进入有效素材节时自动显示，保留文本编辑焦点；手动关闭后不会反复弹出。工作台解析对象类型、有效属性、继承来源、图标和素材，支持固定对象，也可以按个人习惯移动视图。节标题、`Image` 和图标引用旁会显示小缩略图；引用值上的悬停显示动态 PNG，并按素材类型提供查看或播放入口。

- **精确到列表成员**：光标位于 `AnimList=CannonExp1,CannonExp2,CannonExp3` 的第二项时预览 `CannonExp2`；位于 `VoiceMove=GuardianGIMove` 时解析 sound 节的 `Sounds` 并提供试听。`Sounds` 内的空格或逗号分隔样本也可以逐项选择。
- **字典驱动**：识别 `Sound`、`AnimType`、`Shape`、`SHPFile`、`PCXFile`、`PALFile` 和对象引用类型。新标签可以通过字典类型或 `media.semanticRules` 接入，无需修改渲染器。
- **SHP**：播放、逐帧、方向、速度、按用途启用的所属色、阴影、调色板和分页帧总览；步兵动作按 `Sequence` 解释，可修改起始帧、帧数、方向步长。保留序列的额外字段和注释，显示越界和共享序列提示。
- **VXL/HVA**：WebGL2 实例化渲染、游戏等轴视角/自由透视/法线/切片、车体与炮塔/炮管组合、HVA 时间轴、独立部件显隐、炮塔转向。使用素材法线、`voxels.vpl` 和调色板；读取 `[AudioVisual]` 的 `VoxelLightSource` 与 `UseFixedVoxelLighting`，可以调整方向并写回两项设置。
- **FLH**：模型上只显示 art 中已定义的发射点，名称和数值放在旁边，可隐藏点标记。点击模型上的点或在旁边选择名称后，仅该点显示拖动坐标轴；也可输入坐标、观察发射射线。坐标换算比例可调，修改以一次原生撤销操作写回 INI，不自动保存。
- **建筑与动画合成**：解析 `NewTheater`、`Theater`、主体、`Buildup`、附属动画、受损/生产状态与 `Foundation`；逐层开关并查看来源与缺失原因。普通动画可展开 `ConcurrentAnim` 与 `Next`，建筑附属动画只展开并行动画。步兵和建筑默认显示有效的阴影帧，读取 `Shadow` 设置；单帧素材不会凭空分出阴影。支持 Bib、气候切换、SHP/VXL 炮塔和受损火点编辑；`AlphaImage` 和完整粒子系统不参与合成；动画链按确定性预览展示，未模拟游戏概率和完整状态机。
- **游戏比例与光照**：VXL 默认正交游戏角度和 100% 像素比例，可单独选择适配窗口。光照坐标参考 RA2ArtStudio 校正，视图右上角的光照球可以拖动，并同步数值；提供游戏默认值、项目值与显式写回。静态 VXL 不显示播放按钮，具有多帧 HVA 时才显示时间轴。
- **素材库**：命令 **浏览素材库** 提供搜索、分页缩略图和来源选择。支持保留预览进行同步视角对比、导出 PNG/解码后的 WAV、替换当前引用、跳转定义与查看反向引用。命令 **检查项目资源** 按需检查缺失资源、歧义和序列越界。
- **音频**：目录或 MIX 内的 WAV，以及 IDX/BAG 中的 PCM/IMA ADPCM 样本；提供播放、停止、循环、音量和随机样本。MP3/OGG/FLAC 由 Webview 浏览器解码，实际支持取决于 VS Code 的媒体编解码器。

所属色按绘制用途启用：单位、建筑及使用单位绘制器的建筑动画支持重映射，普通动画只有 `AltPalette=yes` 时启用。普通动画、粒子、图标和未识别用途的 SHP 保留色盘原色；自定义色盘本身不决定所属色。详情、悬停、帧总览、对比和导出使用相同规则。

资源自动识别 MOD 根目录：例如 `ES/Rules` 的 INI 与同级 `ES/Resources` 的素材共用索引，只打开其中一个子文件夹也会查找另一侧及根目录 MIX，并监听外部素材变更。嵌套 INI 和直接打开的素材使用同一规则；`validationFolderPath` 可指定所属项目根目录。资源默认先查项目目录，再查 MIX；额外目录通过 `ra2-ini-intellisense.media.resourceRoots` 配置。所有候选来源直接列出，用 `media.archiveOrder` 明确指定 MIX 文件名优先级；`MixBackup` 等备份来源保留但降优先级，`media.excludedDirectories` 默认跳过 `.tmp`、`.cache`、`Tools`。后台索引 INI 包含关系、MIX 目录和音频映射，按需解码选中资源与音频样本；冷启动悬停先返回简短入口，后台准备图片。兼容嵌套 MIX 和加密 MIX 的只读读取。多工作区项目不会互相串用同名单位；打开文档的未保存内容优先参与解析。

```jsonc
{
    "ra2-ini-intellisense.media.resourceRoots": ["D:/Games/RA2"],
    "ra2-ini-intellisense.media.archiveOrder": ["expandmd99.mix", "ra2md.mix"],
    "ra2-ini-intellisense.media.theater": "tem",
    "ra2-ini-intellisense.media.semanticRules": [
        { "owner": "TechnoType", "key": "PreviewArt", "kind": "image", "extension": ".pcx" }
    ]
}
```

请在现有文件分类设置中将自定义 rules/art/sound 文件归入相应类别。浏览器渲染是预览近似，最终游戏效果仍需游戏内确认；预览统一使用 RA2 游戏法线表，并兼容保留旧模式元数据的 RA2 素材。FLH 预览不模拟游戏的完整武器开火逻辑。单图解码上限为 4M 像素，单模型及组合模型为 100 万体素；首次上下文加载最多 2,000 个 INI，素材目录最多 100,000 项/16 层，素材库显示最多 10,000 项，单次资源检查最多 2,000 个引用。复杂解析在 Worker 中进行，界面不会自动启动全项目资源检查。

配置、使用流程与开发说明见 [素材工作台使用与开发指南](docs/asset-workbench.md)。

### 1. 动态语法高亮
超越传统静态语法文件，本扩展通过代码动态分析，提供更精确、更丰富的着色效果。
- **支持多级键**: 为 `Key.Part1.Part2` 的不同部分应用不同颜色。
- **复杂节语法**: 精确高亮 `[Section]:[Inherits]` 结构。
- **默认启用语义着色**: 为 RA2 INI 提供开箱即用的语义 Token 配色，并为 `.llf` 资源提供专门的高亮规则。

### 2. Schema 驱动的智能感知
本扩展的核心能力由一个可配置的规则文件 (`INIDictionary.ini`) 驱动，提供无与伦比的上下文感知能力。
- **代码自动补全 (Auto-Completion)**:
    - **键 (Keys)**: 根据当前节的类型（包含继承），智能提示所有可用的键。
    - **值 (Values)**: 为布尔值 (`yes`/`no`)、颜色、以及所有在 `[Registries]` 中注册的ID（如单位、建筑、武器名等）提供补全。
- **悬停信息 (Hover Information)**:
    - **类型与来源**: 悬停在键上时，显示其在 Schema 中定义的类型 (e.g., `TechLevel: int`) 以及**来源**（如 `Ares`, `Phobos` 或原版），让您明确知道该功能来自哪个平台。
    - **CSF 预览**: 如果一个值引用了 CSF 字符串（例如 `UIName=Name:Apoc`），悬停时将直接显示对应的中文/英文文本（如"天启坦克"）。
    - **继承覆盖详情**: 当一个键覆盖了父节的值时，悬停信息会明确展示**被覆盖的父节名称、所在文件、行号以及旧的值**，并提供一键跳转链接。
- **跳转到定义 (Go to Definition)**:
    - 按住 `Ctrl` 并单击一个值（如单位ID），即可跨文件跳转到该单位的 `[Section]` 定义处。

### 3. 高级诊断与校验
- **内置实时检查**:
    - **代码风格**: 检查等号周围、行首的多余空格；检查注释前后的空格是否规范。
    - **类型校验**: 根据 Schema 实时验证值的类型是否正确（如 `int`, `float`, 数值范围, 枚举值等）。
- **外部校验器集成**:
    - 与 `INIValidator.exe` 无缝集成，提供更深层次的、跨文件的逻辑有效性检查。可通过状态栏图标或命令轻松管理和运行。

### 4. 继承与引用可视化
- **继承覆盖指示器**: 在行号旁显示一个清晰的向上箭头 (↑)，直观地告诉您这一行的键覆盖了父类中的定义。
- **代码透镜 (CodeLens)**: 在每个节 `[Section]` 的上方，显示该节在整个工作区中被作为"值"引用的次数和被"继承"的次数。
- **查找所有引用 (Find All References)**: 右键点击一个节名，即可找到所有引用或继承它的地方。

### 5. 其他实用功能
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

## 安装与配置

### 安装
1. 从 Visual Studio Marketplace 安装，或从发布页面下载最新的 `.vsix` 文件。
2. 在 VS Code 中，打开扩展面板 (`Ctrl+Shift+X`)。
3. 点击右上角的三点菜单 (`...`)，选择 "**从 VSIX 安装...**" (Install from VSIX...)。
4. 选择您下载的 `.vsix` 文件并安装。
5. 重新加载 VS Code。

### 初始配置
为了获得完整的智能提示和诊断功能，您需要配置 Schema 文件 (`INIDictionary.ini`) 和 Mod 根目录。
1. 插件首次激活时会自动弹出 **设置向导 (Setup Wizard)**。
2. 您也可以点击状态栏的 `$(rocket) INI: 显示设置向导` 或使用命令重新打开它。
3. 向导将帮助您一键下载包含最新 Ares/Phobos 支持的官方字典，并自动识别您的工作区路径。

---

## 诊断错误码

您可以在 `ra2-ini-intellisense.diagnostics.severity` 设置中使用这些代码来自定义每条规则的报错等级 (Error, Warning, Information, Hint, None)。

| 错误码 | 分类 | 描述 |
| :--- | :--- | :--- |
| **S001** | 风格 | 行首存在不必要的空格。 |
| **S002** | 风格 | 等号 `=` 左侧有多余空格。 |
| **S003** | 风格 | 等号 `=` 右侧有多余空格。 |
| **S004** | 风格 | 注释符号 `;` 前的空格数量不正确。 |
| **S005** | 风格 | 注释符号 `;` 后缺少空格。 |
| | | |
| **T001** | 类型 | 无效的整数值。 |
| **T002** | 类型 | 无效的浮点数值。 |
| **T003** | 类型 | 数值超出允许范围 (最大/最小)。 |
| **T004** | 类型 | 值不在允许的列表中 (枚举)。 |
| **T005** | 类型 | 值不符合前缀要求。 |
| **T006** | 类型 | 值不符合后缀要求。 |
| **T007** | 类型 | 列表长度无效 (太短/太长)。 |
| | | |
| **L001** | 逻辑 | 引用了不存在的节。 |
| **L002** | 逻辑 | ID 列表中存在未注册的节（当前未启用 — 保留）。 |
| **L003** | 逻辑 | 键的值为空。 |
| **L004** | 逻辑 | 注册表列表中存在重复的键 (例如 `0=A`, `0=B`)。 |

## 命令

| 命令 (Command) | 标题 (Title) | 描述 (Description) |
| :--- | :--- | :--- |
| `ra2-ini-intellisense.showMainQuickPick` | INI: Show Main Menu | 打开主菜单，包含所有扩展操作。 |
| `ra2-ini-intellisense.showWelcomePage` | INI: Show Setup Guide | 重新打开首次配置向导。 |
| `ra2-ini-intellisense.configureSchemaPath` | INI: Set INI Dictionary File Path | 设置 INI Dictionary 文件路径。 |
| `ra2-ini-intellisense.format.document` | Format Document | 格式化当前 INI 文档（也可用 `Shift+Alt+F`）。 |
| `ra2-ini-intellisense.format.selection` | Format Selection/Line | 格式化选中的行或当前行。 |
| `ra2-ini-intellisense.previewMapToSide` | Preview Map | 在侧栏打开地图预览图（`.map`、`.mpr`、`.yrm`）。 |
| `ra2-ini-intellisense.refactor.extractSuperclass` | Extract Superclass... | 将共同的键值对提取到新的父节中。 |
| `ra2-ini-intellisense.registerSectionContext` | Register Section ID to... | 将当前节注册到 ID 列表中。 |
| `ra2-ini-intellisense.jumpToOverride` | INI: Go to Overridden Definition | 跳转到被覆盖键的父定义。 |
| `ra2-ini-intellisense.manageValidator` | INI: Manage INI Validator | 打开 INIValidator 配置面板。 |
| `ra2-ini-intellisense.runValidator` | INI: Run INI Validator | 对配置的校验文件运行 INIValidator。 |
| `ra2-ini-intellisense.compareResources` | Resources: Compare Two Sources | 递归比较两个 MIX 存档或文件夹。 |
| `ra2-ini-intellisense.showDebugInfo` | INI: Show Current Context Debug Info | 显示当前光标上下文的调试信息。 |
| `ra2-ini-intellisense.refreshIniFiles` | Refresh INI Files | 刷新 INI 文件树视图。 |
| `ra2-ini-intellisense.refreshMixFiles` | Refresh MIX Files | 刷新 MIX 文件树视图。 |
| `ra2-ini-intellisense.refreshCsfOutline` | Refresh CSF Outline | 刷新 CSF 大纲树视图。 |

## 详细配置项
您可以在 VS Code 的 `settings.json` 文件中对本插件进行详细配置 (`Ctrl+,`)。

| 设置 (Setting) | 描述 (Description) | 默认值 (Default) |
| :--- | :--- | :--- |
| **`ra2-ini-intellisense.schemaFilePath`** | INI 规则定义文件 (`INIDictionary.ini`) 的绝对路径。这是智能感知的核心。 | `null` |
| **`ra2-ini-intellisense.validationFolderPath`** | `INIValidator.exe` 和文件索引的根目录（通常是您的Mod根目录）。 | `null` |
| | |
| `ra2-ini-intellisense.indexing.fileCategories` | 定义文件分类（如 Rules, Art）及其对应的 Glob 模式。用于提供上下文感知的智能提示。 | `{ "rules": ["rules*.ini"], ... }` |
| `ra2-ini-intellisense.indexing.excludePatterns` | 一个Glob模式数组，用于从已包含的文件中排除特定文件或目录。 | `[]` |
| | |
| `ra2-ini-intellisense.decorations.overrideIndicator.enabled` | 是否启用继承覆盖指示器（行号旁的箭头图标）。 | `true` |
| `ra2-ini-intellisense.codeLens.enabled` | 是否在节上方显示代码透镜（引用计数）。 | `true` |
| | |
| `ra2-ini-intellisense.diagnostics.enabled` | 是否启用所有内置的诊断检查。 | `true` |
| `ra2-ini-intellisense.diagnostics.severity` | 自定义特定错误码的等级（如 `{"S001": "Information"}`）。 | `{}` |
| `ra2-ini-intellisense.diagnostics.spaceBeforeEquals` | 检查 `=` 前的多余空格。 | `true` |
| `ra2-ini-intellisense.diagnostics.spaceAfterEquals` | 检查 `=` 后的多余空格。 | `true` |
| `ra2-ini-intellisense.diagnostics.leadingWhitespace` | 检查行首不必要的空白字符。 | `true` |
| `ra2-ini-intellisense.diagnostics.spaceAfterComment` | 检查 `;` 后缺少空格的情况。 | `true` |
| `ra2-ini-intellisense.diagnostics.spacesBeforeComment` | 注释符号 `;` 前应有的空格数。设为 `null` 可禁用。 | `1` |
| | |
| `ra2-ini-intellisense.exePath` | `INIValidator.exe` 的绝对路径。 | `null` |
| `ra2-ini-intellisense.validationFiles` | `INIValidator.exe` 需要校验的文件列表。 | `{...}` |
| `ra2-ini-intellisense.iniValidator.downloadUrl` | INIValidator 下载页面 URL。如果默认镜像无法访问可在此覆盖。 | `"https://..."` |
| `ra2-ini-intellisense.dontAskToConfigureValidator` | 抑制启动时配置 INIValidator 的提示。 | `false` |
| `ra2-ini-intellisense.dontAskToConfigureProject` | 抑制启动时配置项目的提示。 | `false` |

RA2 INI 的语义着色，以及 `.llf` 的默认 TextMate 配色，也可以通过 VS Code 标准的 `editor.semanticTokenColorCustomizations` 与 `editor.tokenColorCustomizations` 进一步覆盖。

---

## 作者

**星轨实验室 (StarryOrbitStudio)**

由 **Astralette (小星星)** 维护。

---

## 许可证
本项目采用 MIT 许可证。详情请查看 `LICENSE` 文件。
