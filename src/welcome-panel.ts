import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { localize } from './i18n';
import { DictionaryService } from './dictionary-service';

/**
 * 管理欢迎和设置向导的 Webview 面板
 */
export class WelcomePanel {
    public static currentPanel: WelcomePanel | undefined;
    public static readonly viewType = 'iniWelcome';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (WelcomePanel.currentPanel) {
            WelcomePanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            WelcomePanel.viewType,
            localize('welcome.panel.title', 'RA2 Mod IntelliSense Setup Wizard'),
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview-ui')]
            }
        );

        WelcomePanel.currentPanel = new WelcomePanel(panel, context);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._context = context;

        this._update();
        this.sendInitialConfig();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this._disposables
        );
    }

    private async handleMessage(message: any) {
        switch (message.command) {
            case 'selectModPath':
                this.selectModPath(message.useWorkspaceFolder);
                return;
            case 'downloadDictionary':
                const service = new DictionaryService(this._context);
                try {
                    const path = await service.downloadAndConfigure();
                    this._panel.webview.postMessage({ command: 'downloadFinished', path: path });
                } catch (error: any) {
                    this._panel.webview.postMessage({ command: 'downloadFailed', error: error.message });
                }
                return;
            case 'selectDictionary':
                this.selectDictionary();
                return;
            case 'openSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'ra2-ini-intellisense.indexing');
                return;
            case 'closeWelcome':
                this._panel.dispose();
                return;
            case 'updateConfig': {
                const { key, value } = message;
                let valueToUpdate: any = value;
                
                // 如果是 fileCategories，尝试解析 JSON
                if (key === 'indexing.fileCategories') {
                    try {
                        valueToUpdate = JSON.parse(value);
                    } catch (e) {
                        // 如果 JSON 解析失败，暂时不更新或提示错误（Webview端已有校验更好，这里做兜底）
                        vscode.window.showErrorMessage(localize('welcome.error.invalidJson', 'Invalid JSON format for File Categories.'));
                        return;
                    }
                }
                // 旧逻辑兼容：如果是数组形式的字符串
                else if (key === 'indexing.includePatterns') {
                    valueToUpdate = value.split('\n').map((s: string) => s.trim()).filter((s: string) => s);
                }

                await vscode.workspace.getConfiguration('ra2-ini-intellisense').update(key, valueToUpdate, vscode.ConfigurationTarget.Workspace);
                return;
            }
        }
    }
    
    private sendInitialConfig() {
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        const modPath = config.get<string>('validationFolderPath');
        const dictPath = config.get<string>('schemaFilePath');
        
        // 获取 fileCategories 配置
        const fileCategories = config.get('indexing.fileCategories');
        const defaultFileCategories = config.inspect('indexing.fileCategories')?.defaultValue;
        
        const categoriesToShow = fileCategories || defaultFileCategories || {};

        this._panel.webview.postMessage({
            command: 'initialConfig',
            config: {
                modPath: modPath || '',
                dictPath: dictPath || '',
                // 将对象格式化为 JSON 字符串展示
                fileCategories: JSON.stringify(categoriesToShow, null, 4)
            }
        });
    }

    private async selectModPath(useWorkspaceFolder: boolean) {
        let folderPath: string | undefined;
        if (useWorkspaceFolder) {
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            } else {
                vscode.window.showErrorMessage(localize('welcome.error.noWorkspace', 'No folder is currently open. Please select manually.'));
                this._panel.webview.postMessage({ command: 'pathSelectionFailed' });
                return;
            }
        } else {
            const options: vscode.OpenDialogOptions = {
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: localize('welcome.dialog.selectModRoot', 'Select Mod Root Directory')
            };
            const folderUri = await vscode.window.showOpenDialog(options);
            if (folderUri && folderUri[0]) {
                folderPath = folderUri[0].fsPath;
            }
        }

        if (folderPath) {
            this._panel.webview.postMessage({ command: 'pathSelected', path: folderPath });
        } else {
            this._panel.webview.postMessage({ command: 'pathSelectionFailed' });
        }
    }

    private async selectDictionary() {
        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            openLabel: localize('welcome.dialog.selectDictionary', 'Select INI Dictionary File'),
            filters: { [localize('welcome.dialog.iniFilter', 'INI Files')]: ['ini'] }
        };
        const fileUri = await vscode.window.showOpenDialog(options);
        if (fileUri && fileUri[0]) {
            const filePath = fileUri[0].fsPath;
            this._panel.webview.postMessage({ command: 'dictionarySelected', path: filePath });
        } else {
             this._panel.webview.postMessage({ command: 'dictionarySelectionFailed' });
        }
    }

    public dispose() {
        WelcomePanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'style.css'));
        
        const nonce = getNonce();

        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleUri}" rel="stylesheet">
				<title>Welcome to RA2 Mod IntelliSense</title>
			</head>
			<body>
                <div class="main-container">
                    <div class="left-panel">
                        <div class="brand-header animated">
                            <svg class="brand-logo" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path fill="#00aaff" d="M50 0L61.2 38.8L100 50L61.2 61.2L50 100L38.8 61.2L0 50L38.8 38.8L50 0Z"/></svg>
                            <div class="brand-name">
                                <h2>${localize('welcome.brand.name', 'Starry Orbit Studio')}</h2>
                                <p>${localize('welcome.brand.subname', 'Presents')}</p>
                            </div>
                        </div>

                        <div class="info-module animated" style="animation-delay: 0.1s;">
                            <h3>${localize('welcome.welcome.title', 'A Revolution in INI Modding')}</h3>
                            <p>${localize('welcome.welcome.p1', 'We know every Red Alert 2 mod author has spent countless nights with Notepad, grappling with errors from a single typo. RA2 Mod IntelliSense is here to end that.')}</p>
                            <p>${localize('welcome.welcome.p2', 'This is more than a plugin; it\'s a modern development solution crafted by us—Starry Orbit Studio—to bring the power and intelligence of a modern IDE to the classic INI world, letting you focus on creativity, not debugging.')}</p>
                        </div>

                         <div class="info-module animated" style="animation-delay: 0.2s;">
                            <h3>${localize('welcome.features.title', 'Core Feature Highlights')}</h3>
                            <ul class="features-list">
                                <li>
                                    <span class="feature-icon">💡</span>
                                    <div class="feature-text"><strong>${localize('welcome.features.f1.title', 'Total IntelliSense')}</strong><p>${localize('welcome.features.f1.desc', 'Context-aware completion for keys based on section type (including inheritance), hover-to-inspect with override details, and type-driven value completion (booleans, colors, registered IDs).')}</p></div>
                                </li>
                                <li>
                                    <span class="feature-icon">🔗</span>
                                    <div class="feature-text"><strong>${localize('welcome.features.f2.title', 'Inheritance & Reference Visualization')}</strong><p>${localize('welcome.features.f2.desc', 'A clear arrow (↑) indicates overridden keys. CodeLens above sections shows reference and inheritor counts, demystifying your codebase structure.')}</p></div>
                                </li>
                                <li>
                                    <span class="feature-icon">🔎</span>
                                    <div class="feature-text"><strong>${localize('welcome.features.f3.title', 'Global Navigation & Traceability')}</strong><p>${localize('welcome.features.f3.desc', 'Ctrl+Click any ID to jump to its definition across files. Right-click a section name to find all its references for easy refactoring and analysis.')}</p></div>
                                </li>
                                <li>
                                    <span class="feature-icon">🛡️</span>
                                    <div class="feature-text"><strong>${localize('welcome.features.f4.title', 'Built-in Real-time Diagnostics')}</strong><p>${localize('welcome.features.f4.desc', 'Live checking for code style violations (e.g., spacing) and robust type validation (int, float, ranges, enums) that catches errors as you type.')}</p></div>
                                </li>
                            </ul>
                        </div>

                        <div class="info-module animated" style="animation-delay: 0.3s;">
                            <h3>${localize('welcome.philosophy.title', 'The Philosophy: Schema-Driven Intelligence')}</h3>
                            <p>${localize('welcome.philosophy.p1', 'The "secret weapon" behind this extension\'s power is that it\'s Schema-Driven. We\'ve abstracted the entire ruleset of Red Alert 2 INI—object types, properties, value types, and inheritance—into a configurable file: the INI Dictionary.')}</p>
                            <p>${localize('welcome.philosophy.p2', 'This "dictionary" is the brain of the extension. It allows the tool to truly "understand" your code, not just "see" it. Activating its full potential starts with configuring this file on the right.')}</p>
                        </div>
                        
                         <div class="info-module animated" style="animation-delay: 0.4s;">
                            <h3>${localize('welcome.dictionary.title', 'About the INI Dictionary Project')}</h3>
                            <p>${localize('welcome.dictionary.p1', 'The INI Dictionary file is not a static document. It\'s a vibrant, open-source project initiated and maintained by Starry Orbit Studio. It represents the collective wisdom of the community, constantly updated to keep pace with the latest modding platforms (like Phobos and Ares).')}</p>
                            <a href="https://github.com/Starry-Orbit-Studio/RA2-INI-Dictionary" class="github-button" title="${localize('welcome.dictionary.button.tooltip', 'Contribute to the INI Dictionary')}">
                                <svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>GitHub</title><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
                                ${localize('welcome.dictionary.button.text', 'Contribute to INI Dictionary')}
                            </a>
                        </div>
                    </div>
                    <div class="right-panel">
                        <header class="header animated" style="animation-delay: 0.5s;">
                            <h1>${localize('welcome.rightPanel.title', 'Configuration Wizard')}</h1>
                            <p class="subtitle">${localize('welcome.rightPanel.subtitle', 'Let\'s unlock the full potential for your project')}</p>
                        </header>
                        
                        <div class="progress-stepper animated" style="animation-delay: 0.6s;">
                           <div class="progress-node" id="progress-node-1"><div class="node-circle"><span>1</span></div><div class="node-label">${localize('welcome.step1.label', 'Project Directory')}</div></div>
                           <div class="progress-node" id="progress-node-2"><div class="node-circle"><span>2</span></div><div class="node-label">${localize('welcome.step2.label', 'INI Dictionary')}</div></div>
                           <div class="progress-node" id="progress-node-3"><div class="node-circle"><span>🎉</span></div><div class="node-label">${localize('welcome.step3.label', 'Finish')}</div></div>
                        </div>

                        <div class="steps-container">
                            <div id="step1" class="step-module animated" style="animation-delay: 0.7s;">
                                <div class="step-header">
                                    <h2 class="step-title">${localize('welcome.step1.title', '1. Configure Project Directory (Required)')}</h2>
                                </div>
                                <p class="step-description">${localize('welcome.step1.desc', 'Set your Mod project\'s root directory. This is the starting point for all intelligent analysis.')}</p>
                                <div class="input-container">
                                    <input type="text" id="mod-path-input" class="config-input" placeholder="${localize('welcome.step1.placeholder', 'e.g., C:\\Games\\RA2\\MyMod')}">
                                </div>
                                <div class="actions">
                                    <button id="use-workspace-btn">
                                        <span>📁</span> ${localize('welcome.step1.button.workspace', 'Use Current Workspace')}
                                    </button>
                                    <button id="browse-folder-btn">
                                        <span>🔍</span> ${localize('welcome.step1.button.browse', 'Browse Manually...')}
                                    </button>
                                </div>
                            </div>

                            <div id="step2" class="step-module animated" style="animation-delay: 0.8s;">
                                <div class="step-header">
                                    <h2 class="step-title">${localize('welcome.step2.title', '2. Configure INI Dictionary')}</h2>
                                </div>
                                <p class="step-description">${localize('welcome.step2.desc', 'Inject the official INI Dictionary to power code completion and error checking.')}</p>
                                <div class="input-container">
                                    <input type="text" id="dict-path-input" class="config-input" placeholder="${localize('welcome.step2.placeholder', 'e.g., C:\\...\\INIDictionary.ini')}">
                                </div>
                                <div class="actions">
                                    <button id="download-dict-btn" class="button-primary">
                                       <span>☁️</span> ${localize('welcome.step2.button.download', 'Auto-Download & Configure')}
                                    </button>
                                    <button id="select-dict-btn">
                                        <span>📄</span> ${localize('welcome.step2.button.local', 'Use Local Dictionary...')}
                                    </button>
                                </div>
                            </div>

                            <div id="step3" class="step-module animated" style="animation-delay: 0.9s;">
                                <div class="step-header">
                                    <h2 class="step-title">${localize('welcome.step3.title', '3. Configure File Categories (Optional)')}</h2>
                                </div>
                                <p class="step-description">${localize('welcome.step3.desc', 'Define which files the extension should track. You can edit the rules below (JSON format).')}</p>
                                <div class="input-container">
                                    <textarea id="file-categories-input" class="config-textarea" rows="8" placeholder='{ "rules": ["rules*.ini"], "art": ["art*.ini"] }'></textarea>
                                </div>
                                <div class="actions">
                                    <button id="customize-indexing-btn">
                                        <span>⚙️</span> ${localize('welcome.step3.button.settings', 'Edit in settings.json')}
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div class="finish-button-container animated" style="animation-delay: 1s;">
                            <button id="finish-btn">
                                <span>${localize('welcome.finishButton.text', 'Finish Setup & Close')}</span>
                            </button>
                        </div>
                    </div>
                </div>

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}