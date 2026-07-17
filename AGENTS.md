# AGENTS.md - RA2 Mod IntelliSense

本文档为在此 VS Code 扩展项目中工作的智能编码助手（Agentic coding assistants）提供关键信息。

## 编译命令

### 开发构建
```bash
npm run compile          # 类型检查、代码校验并构建（运行 check-types, lint 和 esbuild）
npm run watch            # TypeScript 和 esbuild 的监视模式（并行运行）
npm run watch:esbuild    # 仅 esbuild 的监视模式
npm run watch:tsc        # 仅 TypeScript 类型检查的监视模式
```

### 生产构建
```bash
npm run package          # 生产环境构建（类型检查、代码校验和生产环境 esbuild）
npm run vscode:prepublish # package 命令的别名
```

### 类型检查
```bash
npm run check-types      # 仅进行 TypeScript 类型检查（不输出文件）
```

### 代码校验 (Linting)
```bash
npm run lint             # 对 src 目录运行 ESLint
```

## 测试命令

### 运行测试
```bash
npm test                 # 通过 vscode-test 运行所有测试
npm run pretest          # 测试前编译测试文件、编译扩展并进行代码校验
npm run compile-tests    # 编译测试文件到 out/ 目录
npm run watch-tests      # 测试编译的监视模式
```

### 运行单个测试
没有特定的脚本用于执行单个测试。请直接使用 vscode-test CLI：
```bash
npx @vscode/test-cli --config .vscode-test.mjs --testPattern "**/specific.test.js"
```

### 测试配置
- 测试文件被编译到 `out/test/` 目录
- 测试配置位于 `.vscode-test.mjs`
- 调试配置位于 `.vscode/launch.json` 中

## 代码风格指南

### TypeScript 配置
- 目标版本 (Target): ES2022
- 模块规范 (Module): Node16
- 启用严格模式 (Strict mode)
- 启用源映射 (Source maps)
- 根目录: `src/`
- 禁用的额外检查（但可以启用）: `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedParameters`

### ESLint 规则
- **命名规范 (Naming Convention)**: `@typescript-eslint/naming-convention` 对导入进行警告，期望使用 camelCase 或 PascalCase。
- **花括号 (Curly Braces)**: `curly: "warn"` - 强制执行一致的花括号使用。
- **等号 (Equality)**: `eqeqeq: "warn"` - 要求使用 `===` 和 `!==`。
- **不抛出字面量 (No Throw Literal)**: `no-throw-literal: "warn"` - 仅允许抛出 Error 对象。
- **分号 (Semicolons)**: `semi: "warn"` - 要求使用分号。

### 导入 (Imports)
- 使用 ES6 导入/导出语法。
- 导入分组：VS Code API、Node.js 模块、本地模块。
- 对拥有多个导出的模块使用 `import * as`（例如：`import * as vscode from 'vscode'`）。
- 本地导入使用相对路径，并省略 `.js` 扩展名。
- 导入顺序：
  1. 外部依赖（vscode，node 模块）
  2. 内部模块（相对路径）

示例：
```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
```

### 命名约定
- **类 (Classes)**: PascalCase（例如：`INIManager`, `INIOutlineProvider`）
- **接口 (Interfaces)**: PascalCase（通常带有 I 前缀，但并不完全一致）
- **方法/函数 (Methods/Functions)**: camelCase（例如：`activate`, `initializeNls`）
- **变量/常量 (Variables/Constants)**: camelCase（例如：`outputChannel`, `isIndexing`）
- **常量 (Constants)**: 真正的常量使用 UPPER_SNAKE_CASE（例如：`LANGUAGE_ID`）
- **私有字段 (Private Fields)**: 无特殊前缀约定，仅使用 camelCase。
- **文件名 (File Names)**: kebab-case（例如：`welcome-panel.ts`, `schema-manager.ts`）

### 错误处理
- 对可能失败的同步操作使用 `try/catch` 块。
- 倾向于抛出 `Error` 对象（而非字符串或字面量）。
- 将错误记录到控制台，并附带描述性消息。
- 对于面向用户的错误，使用带有本地化字符串的 `vscode.window.showErrorMessage()`。
- 使用来自 `./i18n` 的 `localize` 函数进行国际化。

示例：
```typescript
try {
    // 操作内容
} catch (e) {
    console.error('[Module] 操作失败', e);
    vscode.window.showErrorMessage(localize('error.message', '操作失败'));
}
```

### 国际化 (i18n)
- 所有面向用户的字符串必须使用 `localize` 函数进行本地化。
- 翻译键定义在 `i18n/bundle.nls.json` 和特定语言的文件中。
- 在扩展激活期间使用 `initializeNls` 函数。
- 模式：`localize('key.name', '默认英文文本', ...args)`

### 格式化
- 缩进：4 个空格（在源文件中观察所得）。
- 行长度：无明确限制，但需保持可读性。
- 花括号：左花括号与语句在同一行。
- 在运算符周围和逗号后使用空格。
- 注释风格：单行注释使用 `//`，JSDoc 使用 `/** */`。

### 注释
- 对公共 API（类、方法、函数）使用 JSDoc。
- 使用 `//` 进行行内解释。
- 注释使用英文（部分文件中存在中文）。
- 包含用于后续工作的 TODO 注释。

### 文件结构
- 源代码位于 `src/` 目录。
- 功能子目录：`diagnostics/`（诊断）, `refactoring/`（重构）, `formatting/`（格式化）。
- 资源文件位于 `assets/` 目录。
- 语法定义位于 `syntaxes/` 目录。
- Webview UI 位于 `webview-ui/` 目录。
- 国际化文件位于 `i18n/` 目录。

## VS Code 扩展细节

### 激活事件 (Activation Events)
- 扩展在语言为 `ra2-ini` 时激活。
- 激活函数位于 `src/extension.ts`。

### 贡献点 (Contribution Points)
- 语言、语法、语义令牌、视图、命令、配置。
- 详见 `package.json`。

### 开发
- 使用 `npm run watch` 进行持续开发。
- 使用 F5 (Run Extension) 在扩展宿主中进行测试。
- 扩展输出通道："RA2 Mod IntelliSense"。

## Git 工作流
- 未定义特定的分支模型。
- 提交消息：使用常规提交（Conventional Commits）风格（在 CHANGELOG 中观察所得）。
- 预提交钩子 (Pre-commit hooks)：未配置。
- 提交信息使用无前缀的一句话中文。

## Cursor/Copilot 规则
未发现 Cursor 规则（`.cursorrules` 或 `.cursor/rules/`）或 Copilot 指令（`.github/copilot-instructions.md`）。

## 助手指令 (Agent Instructions)
在处理此代码库时：

1. **在提交更改前始终运行类型检查和代码校验**：
   ```bash
   npm run check-types && npm run lint
   ```

2. **通过在开发模式下运行扩展来测试更改**。

3. **遵循现有模式** —— 检查类似的文件以保持风格一致性。

4. **对所有面向用户的字符串使用国际化**。

5. **保持向后兼容性** —— 这是一个被其他用户使用的 VS Code 扩展。

6. **针对用户可见的更改更新 CHANGELOG.md**。

7. **使用 `npm run package` 构建生产环境 VSIX** 以进行发布。

## 故障排除
- 如果构建失败，请先通过 `npm run check-types` 检查 TypeScript 错误。
- 如果代码校验失败，请修复 ESLint 警告（它们被设置为警告级别而非错误级别）。
- 如果扩展未激活，请检查 `package.json` 中的激活事件。
- 对于测试问题，请确保编译后测试文件位于 `out/test/` 中。