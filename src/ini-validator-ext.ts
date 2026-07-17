import * as vscode from 'vscode';
import * as path from 'path';
import { DiagnosticSeverity } from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as fs from 'fs/promises';
import { localize } from './i18n';

type ValidatorStatus = 'ready' | 'invalid' | 'unconfigured';
const CONFIG_SECTION = 'ra2-ini-intellisense';
const CONFIG_KEY_EXE_PATH = 'ra2-ini-intellisense.exePath';
const CONFIG_KEY_FOLDER_PATH = 'ra2-ini-intellisense.validationFolderPath';
const CONFIG_KEY_FILES = 'ra2-ini-intellisense.validationFiles';
const CONFIG_KEY_DONT_ASK = 'ra2-ini-intellisense.dontAskToConfigureValidator';

/**
 * 封装与 INIValidator.exe 交互的所有逻辑
 */
export class INIValidatorExt {
    private diagnostics: vscode.DiagnosticCollection;
    public status: ValidatorStatus = 'unconfigured';
    public statusDetails: string = '';
    private exePath: string | undefined;

    private _onDidChangeStatus = new vscode.EventEmitter<void>();
    public readonly onDidChangeStatus = this._onDidChangeStatus.event;

    constructor(diagnostics: vscode.DiagnosticCollection) {
        this.diagnostics = diagnostics;
    }

    /**
     * 初始化验证器, 检查配置, 设置监听器和状态栏
     * @param context 扩展上下文
     */
    public async initialize(context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                await this.validatePath();
            }
        }));

        context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.manageValidator', () => {
            this.showQuickPick();
        }));

        context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.runValidator', () => {
            this.runValidatorCommand();
        }));

        await this.validatePath();
        // this.promptIfUnconfigured();
    }

    /**
     * 获取 INIValidator 的下载页面 URL（可由用户在配置中覆盖）。
     */
    private getDownloadUrl(): string {
        return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('iniValidator.downloadUrl')
            || 'https://www.bilibili.com/opus/1022686010171981842';
    }

    /**
     * 弹出文件对话框让用户选择 .exe 文件
     */
    private async promptToSelectExePath() {
        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            openLabel: localize('validator.selectExe.label', 'Select INIValidator.exe'),
            filters: process.platform === 'win32' ? { [localize('validator.selectExe.filter.executable', 'Executable Files')]: ['exe'], [localize('validator.selectExe.filter.all', 'All Files')]: ['*'] } : undefined
        };
        const fileUri = await vscode.window.showOpenDialog(options);
        if (fileUri && fileUri[0]) {
            await vscode.workspace.getConfiguration().update(CONFIG_KEY_EXE_PATH, fileUri[0].fsPath, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(localize('validator.pathSet.success', 'INI Validator path has been set to: {0}', fileUri[0].fsPath));
        }
    }

    /**
     * 弹出文件夹选择对话框让用户选择 Mod 根目录
     */
    private async promptToSelectModFolder() {
        const options: vscode.OpenDialogOptions = {
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: localize('validator.selectFolder.label', 'Select Mod Root Folder')
        };
        const folderUri = await vscode.window.showOpenDialog(options);
        if (folderUri && folderUri[0]) {
            await vscode.workspace.getConfiguration().update(CONFIG_KEY_FOLDER_PATH, folderUri[0].fsPath, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(localize('validator.folderSet.success', 'Mod validation root folder has been set to: {0}', folderUri[0].fsPath));
        }
    }
    
    /**
     * 显示一个交互式菜单来管理要校验的文件列表
     */
    private async manageValidationFiles() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        let files = config.get<{[key: string]: string}>('validationFiles', {});

        const toQuickPickItem = (key: string, value: string): vscode.QuickPickItem => ({
            label: `[${key}] = ${value}`,
            description: localize('validator.manageFiles.item.description', 'Click to edit or delete this entry')
        });

        const items: vscode.QuickPickItem[] = [
            { label: localize('validator.manageFiles.add.label', '$(add) Add New File Entry...'), description: localize('validator.manageFiles.add.description', 'Add a new key-value pair to the [Files] section') },
            ...Object.entries(files).map(([key, value]) => toQuickPickItem(key, value))
        ];

        const selection = await vscode.window.showQuickPick(items, { placeHolder: localize('validator.manageFiles.placeholder', 'Manage File List for Validation') });
        if (!selection) {
            return;
        }

        if (selection.label.startsWith('$(add)')) {
            const key = await vscode.window.showInputBox({ prompt: localize('validator.manageFiles.inputKey.prompt', 'Enter the key name (e.g., rulesext)') });
            if (!key) {
                return;
            }
            const value = await vscode.window.showInputBox({ prompt: localize('validator.manageFiles.inputValue.prompt', 'Enter the filename for key "{0}" (e.g., rulesext.ini)', key) });
            if (value === undefined) {
                return;
            }
            files[key] = value;
        } else {
            const match = selection.label.match(/\[(.*?)\]/);
            if (!match) {return;}
            const key = match[1];
            const action = await vscode.window.showQuickPick([localize('validator.manageFiles.action.edit', 'Edit Value'), localize('validator.manageFiles.action.delete', 'Delete Entry')], { placeHolder: localize('validator.manageFiles.action.placeholder', 'Action for "{0}"', selection.label) });
            if (!action) {
                return;
            }

            if (action === localize('validator.manageFiles.action.edit', 'Edit Value')) {
                const newValue = await vscode.window.showInputBox({ prompt: localize('validator.manageFiles.editValue.prompt', 'Enter the new filename for key "{0}"', key), value: files[key] });
                if (newValue !== undefined) {
                    files[key] = newValue;
                }
            } else if (action === localize('validator.manageFiles.action.delete', 'Delete Entry')) {
                delete files[key];
            }
        }
        await config.update('validationFiles', files, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(localize('validator.fileListUpdated', 'Validation file list has been updated.'));
    }

    /**
     * 显示管理验证器的快速选择菜单
     */
    public async showQuickPick() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const notSetDescription = localize('validator.quickPick.notSet', 'Not currently set');
        const items: vscode.QuickPickItem[] = [];
        
        const exePath = config.get<string>('exePath');
        const folderPath = config.get<string>('validationFolderPath');
        const files = config.get<object>('validationFiles', {});
        const fileCount = Object.keys(files).length;

        items.push({ 
            label: localize('validator.quickPick.setPath.label', '$(file-code) Set INI Validator Path...'), 
            description: exePath ? path.basename(exePath) : notSetDescription 
        });
        items.push({ 
            label: localize('validator.quickPick.setFolder.label', '$(folder) Set Mod Root Folder...'), 
            description: folderPath ? path.basename(folderPath) : notSetDescription 
        });
        items.push({ 
            label: localize('validator.quickPick.editList.label', '$(list-selection) Edit Validation File List...'), 
            description: localize('validator.quickPick.filesConfigured', '{0} files configured', fileCount) 
        });
        items.push({ 
            label: localize('validator.quickPick.run.label', '$(play) Run Validation Manually'), 
            description: localize('validator.quickPick.run.description', 'Generate Settings.ini and run validation immediately') 
        });
        items.push({ 
            label: localize('validator.quickPick.download.label', '$(cloud-download) Go to Download INI Validator'), 
            description: localize('validator.quickPick.download.description', 'Open the download page in your browser') 
        });
        items.push({ 
            label: localize('validator.quickPick.openSettings.label', '$(settings) Open Extension Settings (JSON)'), 
            description: localize('validator.quickPick.openSettings.description', 'For advanced configuration') 
        });

        const selection = await vscode.window.showQuickPick(items, { placeHolder: localize('validator.quickPick.placeholder', 'Manage INI Validator Integration') });
        if (!selection) {
            return;
        }

        if (selection.label.startsWith('$(file-code)')) {
            this.promptToSelectExePath();
        } else if (selection.label.startsWith('$(folder)')) {
            this.promptToSelectModFolder();
        } else if (selection.label.startsWith('$(list-selection)')) {
            this.manageValidationFiles();
        } else if (selection.label.startsWith('$(play)')) {
            vscode.commands.executeCommand('ra2-ini-intellisense.runValidator');
        } else if (selection.label.startsWith('$(cloud-download)')) {
            vscode.env.openExternal(vscode.Uri.parse(this.getDownloadUrl()));
        } else if (selection.label.startsWith('$(settings)')) {
            vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
        }
    }

    /**
     * 检查验证器路径是否有效, 并更新内部状态和UI
     */
    private async validatePath() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        let configuredPath = config.get<string>('exePath');
        if (!configuredPath) {
            this.updateStatus('unconfigured'); return;
        }
        this.exePath = path.resolve(configuredPath.startsWith('~/') ? path.join(os.homedir(), configuredPath.slice(2)) : configuredPath);
        try {
            const stats = await fs.stat(this.exePath);
            this.updateStatus(stats.isFile() ? 'ready' : 'invalid', stats.isFile() ? '' : localize('validator.status.pathIsDirectory', 'The path points to a directory, not a file.'));
        } catch (error) {
            this.updateStatus('invalid', localize('validator.status.pathNotFound', 'The path does not exist or is not accessible.'));
        }
    }

    /**
     * 更新验证器状态并触发事件
     * @param status 新的状态
     * @param details 附加信息
     */
    private updateStatus(status: ValidatorStatus, details: string = '') {
        this.status = status;
        this.statusDetails = details;
        this._onDidChangeStatus.fire();
    }

    /**
     * 如果未配置验证器, 则向用户发出首次使用提示
     */
    private async promptIfUnconfigured() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const dontAsk = config.get<boolean>('dontAskToConfigureValidator');

        if (this.status === 'unconfigured' && !dontAsk) {
            const configureAction = localize('validator.prompt.configure.action.configure', 'Configure Path');
            const downloadAction = localize('validator.prompt.configure.action.download', 'Go to Download');
            const dontAskAction = localize('validator.prompt.configure.action.dontAsk', "Don't Ask Again");

            const selection = await vscode.window.showInformationMessage(
                localize('validator.prompt.configure.message', 'INI Validator is not configured. Would you like to set it up to enable advanced diagnostics?'),
                configureAction, downloadAction, dontAskAction
            );

            if (selection === configureAction) {
                this.promptToSelectExePath();
            } else if (selection === downloadAction) {
                vscode.env.openExternal(vscode.Uri.parse(this.getDownloadUrl()));
            } else if (selection === dontAskAction) {
                await config.update('dontAskToConfigureValidator', true, vscode.ConfigurationTarget.Workspace);
            }
        }
    }

    public isReady(): boolean {
        return this.status === 'ready';
    }

    /**
     * 作为命令独立执行校验流程, 并提供用户反馈
     */
    public async runValidatorCommand() {
        if (!this.isReady()) {
            vscode.window.showWarningMessage(localize('validator.run.notReady', 'INI Validator is not configured, cannot run validation.'));
            return;
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: localize('validator.run.progress.title', 'Running INI Validator...'),
            cancellable: false
        }, async (progress) => {
            const success = await this.runValidation();
            if (success) {
                progress.report({ message: localize('validator.run.progress.success', 'Validation complete!') });
            } else {
                progress.report({ message: localize('validator.run.progress.failure', 'Validation failed.') });
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        });
    }

    /**
     * 核心校验逻辑: 生成Settings.ini, 调用外部程序, 并处理结果
     * @returns 一个布尔值, 表示操作是否成功
     */
    public async runValidation(): Promise<boolean> {
        if (!this.isReady() || !this.exePath) {
            return false;
        }

        // 优先使用配置的路径，如果没有，则使用当前工作区
        let folderPath = vscode.workspace.getConfiguration('ra2-ini-intellisense').get<string>('validationFolderPath');
        if (!folderPath && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }

        if (!folderPath) {
            vscode.window.showWarningMessage(localize('validator.run.folderNotSet', 'Mod validation root folder is not configured. Skipped INI Validator check.'));
            return false;
        }

        const files = vscode.workspace.getConfiguration('ra2-ini-intellisense').get<object>('validationFiles');
        const exeDir = path.dirname(this.exePath);
        const filesSectionContent = Object.entries(files || {}).map(([k, v]) => `${k}=${v}`).join('\n');
        const settingsContent = `[INIValidator]\nFolderPath=${folderPath}\nJsonLog=true\n\n[Files]\n${filesSectionContent}\n`;

        try {
            const settingsIniPath = path.join(exeDir, 'Settings.ini');
            await fs.writeFile(settingsIniPath, settingsContent, 'utf-8');
            
            const command = `"${this.exePath}"`;
            await this.executeCommand(command, { cwd: exeDir });

            const resultPath = path.join(exeDir, "Checker.json");
            const resultsJson = await fs.readFile(resultPath, 'utf8');
            const results = JSON.parse(resultsJson);
            if (Array.isArray(results)) {
                this.processValidationResults(results);
            }
            return true;

        } catch (error: any) {
            const errorMessage = localize('validator.run.executionError', 'Failed to run INI Validator: {0}. Please check the path, file permissions, and write access to the "{1}" directory.', error.message, path.basename(exeDir));
            vscode.window.showErrorMessage(errorMessage);
            console.error('INI Validator 执行错误:', error);
            return false;
        }
    }
    
    /**
     * 将验证器返回的JSON结果转换为VS Code的诊断信息
     * @param results 从 Checker.json 读取到的结果数组
     */
    private async processValidationResults(results: any[]) {
        this.diagnostics.clear();
        const diagnosticsByFile: Map<string, vscode.Diagnostic[]> = new Map();
        for (const error of results) {
            if (!error.filename || error.line === undefined || !error.message) {
                continue;
            }
            const line = Math.max(0, error.line - 1);
            const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_VALUE), error.message, this.toDiagnosticSeverity(error.level));
            diagnostic.source = 'INI Validator';
            if (!diagnosticsByFile.has(error.filename)) {
                diagnosticsByFile.set(error.filename, []);
            }
            diagnosticsByFile.get(error.filename)?.push(diagnostic);
        }
        for (const [fileName, fileDiagnostics] of diagnosticsByFile.entries()) {
            const fileUris = await vscode.workspace.findFiles('**/' + fileName, null, 1);
            if (fileUris.length > 0) {
                this.diagnostics.set(fileUris[0], fileDiagnostics);
            }
        }
    }

    /**
     * 将错误级别字符串转换为VS Code的DiagnosticSeverity枚举
     * @param level 错误级别字符串, 如 "错误", "warn"
     */
    private toDiagnosticSeverity(level: string): DiagnosticSeverity {
        switch (level) {
            case "错误": return DiagnosticSeverity.Error;
            case "warn": return DiagnosticSeverity.Warning;
            case "建议": return DiagnosticSeverity.Information;
            default: return DiagnosticSeverity.Hint;
        }
    }
    
    /**
     * 将 child_process.exec 包装成一个 Promise, 以便使用 async/await
     * @param command 要执行的完整命令字符串
     * @param options child_process.exec 的选项
     */
    private executeCommand(command: string, options: cp.ExecOptions): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.exec(command, options, (error, stdout, stderr) => {
                if (error) {
                    reject(error); return;
                }
                if (stderr) {
                    console.warn(localize('validator.exec.stderr', 'INI Validator produced output on stderr:'), stderr);
                }
                resolve(stdout);
            });
        });
    }
}