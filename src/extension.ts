import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';
import { INIOutlineProvider } from './outline-provider';
import { SchemaManager } from './schema-manager';
import { IniSemanticTokensProvider, legend } from './semantic-tokens-provider';
import { DiagnosticManager } from './diagnostics/engine';
import { OverrideDecorator } from './override-decorator';
import { ValuePreviewDecorator } from './value-preview-decorator';
import { WelcomePanel } from './welcome-panel';
import { localize, initializeNls } from './i18n';
import { IniRenameProvider } from './refactoring/rename-provider';
import { IniCodeActionProvider } from './refactoring/code-actions';
import { registerRegisterIdCommand } from './refactoring/register-id';
import { registerExtractSuperclassCommand } from './refactoring/extract-superclass';
import { registerFormattingCommands } from './formatting/formatter';
import { DictionaryService } from './dictionary-service';
import { FileTypeManager } from './file-type-manager';
import { CsfManager } from './csf-manager';
import { CsfOutlineProvider } from './csf-outline-provider';
import { DescriptionManager } from './description-manager';

const LANGUAGE_ID = 'ra2-ini';

export async function activate(context: vscode.ExtensionContext) {
    initializeNls(context);
	const outputChannel = vscode.window.createOutputChannel(localize('output.channel.name', 'INI IntelliSense'));
	
	const iniManager = new INIManager();
	const outlineProvider = new INIOutlineProvider(context, iniManager);
	const schemaManager = new SchemaManager();
    const fileTypeManager = new FileTypeManager();
    const csfManager = new CsfManager();
    const csfOutlineProvider = new CsfOutlineProvider(csfManager);
    const descriptionManager = new DescriptionManager();
    
    // 等待CSF管理器初始化完成，然后刷新树状视图
    csfManager.waitForInitialization().then(() => {
        csfOutlineProvider.refresh();
    }).catch(err => {
        console.error('Failed to initialize CSF manager:', err);
    });
	iniManager.setSchemaManager(schemaManager);
    iniManager.setFileTypeManager(fileTypeManager);

    // 使用新的诊断管理器
	const diagnosticManager = new DiagnosticManager(context, schemaManager, iniManager);
    
	let isIndexing = false; 

	const selector = { language: LANGUAGE_ID };

	context.subscriptions.push(
		vscode.languages.registerDocumentSemanticTokensProvider(selector, new IniSemanticTokensProvider(), legend)
	);

	const overrideDecorator = new OverrideDecorator(context, iniManager, schemaManager, fileTypeManager);
	context.subscriptions.push(overrideDecorator);

    const valuePreviewDecorator = new ValuePreviewDecorator(iniManager, schemaManager, csfManager);
    context.subscriptions.push(valuePreviewDecorator);

	const mainStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	mainStatusBar.command = 'ra2-ini-intellisense.showMainQuickPick';
	context.subscriptions.push(mainStatusBar);

    const fileTypeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    fileTypeStatusBar.command = 'workbench.action.openSettings';
    fileTypeStatusBar.tooltip = "Current INI File Type (Click to Configure)";
    context.subscriptions.push(fileTypeStatusBar);

    // INIValidator 使用独立的 DiagnosticCollection，避免与内部诊断冲突
	const validatorDiagnostics = vscode.languages.createDiagnosticCollection('ini-validator');
	const iniValidator = new INIValidatorExt(validatorDiagnostics);
    const dictionaryService = new DictionaryService(context);
	
	iniValidator.initialize(context);
	context.subscriptions.push(iniValidator.onDidChangeStatus(() => updateMainStatus()));
	context.subscriptions.push(validatorDiagnostics);
    // DiagnosticManager 内部管理了自己的 collection，记得 dispose
    context.subscriptions.push(diagnosticManager);

	context.subscriptions.push(vscode.window.createTreeView('ini-outline', { treeDataProvider: outlineProvider }));
	context.subscriptions.push(vscode.window.createTreeView('csf-outline', { treeDataProvider: csfOutlineProvider }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.refreshOutline', () => outlineProvider.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.refreshCsfOutline', () => csfOutlineProvider.refresh()));

    function getProjectRoot(): string | undefined {
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        const configPath = config.get<string | null>('validationFolderPath');
        if (configPath) {
            return configPath;
        }
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            return vscode.workspace.workspaceFolders[0].uri.fsPath;
        }
        return undefined;
    }

	async function indexWorkspaceFiles() {
		if (isIndexing) { return; }
		isIndexing = true;
		updateMainStatus();

		try {
			const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
			const includePatterns = config.get<string[]>('indexing.includePatterns', []);
			const excludePatterns = config.get<string[]>('indexing.excludePatterns', []);
            const categoryPatterns = fileTypeManager.getAllCategoryPatterns();
            const combinedIncludePatterns = Array.from(new Set([...includePatterns, ...categoryPatterns]));
			
            const projectRoot = getProjectRoot();

			if (!projectRoot || combinedIncludePatterns.length === 0) {
				console.log('INI IntelliSense: 未找到有效项目根目录或包含模式，跳过文件索引。');
				await iniManager.indexFiles([]);
				outlineProvider.refresh();
				return;
			}
            
            const searchRoot = vscode.Uri.file(projectRoot);
			const includePattern = new vscode.RelativePattern(searchRoot, `{${combinedIncludePatterns.join(',')}}`);
			const excludePattern = excludePatterns.length > 0 ? new vscode.RelativePattern(searchRoot, `{${excludePatterns.join(',')}}`) : null;
			
			const iniFiles = await vscode.workspace.findFiles(includePattern, excludePattern);
			await iniManager.indexFiles(iniFiles);
			const indexedFiles = Array.from(iniManager.documents.keys()).map(p => path.basename(p));
			console.log(`INI IntelliSense: 已索引 ${iniManager.documents.size} 个INI文件: [${indexedFiles.join(', ')}]`);
			outlineProvider.refresh();
		} finally {
			isIndexing = false;
			updateMainStatus();
		}
	}
	
    function updateFileTypeStatus(editor: vscode.TextEditor | undefined) {
        if (editor && editor.document.languageId === LANGUAGE_ID) {
            const type = fileTypeManager.getFileType(editor.document.uri);
            fileTypeStatusBar.text = `INI Type: ${type}`;
            fileTypeStatusBar.show();
        } else {
            fileTypeStatusBar.hide();
        }
    }

	function updateMainStatus() {
		if (isIndexing) {
			mainStatusBar.text = `$(sync~spin) INI: ${localize('statusbar.indexing', 'Indexing...')}`;
			mainStatusBar.tooltip = localize('statusbar.indexing.tooltip', 'Indexing INI files in the workspace, some features may be temporarily unavailable.');
			mainStatusBar.backgroundColor = undefined;
			mainStatusBar.show();
			return;
		}

		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        const projectRoot = getProjectRoot();

		if (!projectRoot) {
			mainStatusBar.text = `$(folder) INI: ${localize('statusbar.setProjectRoot', 'Set Project Root')}`;
			mainStatusBar.tooltip = localize('statusbar.setProjectRoot.tooltip', 'Mod root directory is not set. Click to configure to enable file indexing and diagnostics.');
			mainStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else if (!schemaManager.isSchemaLoaded()) {
			const dictPath = config.get<string>('schemaFilePath');
			mainStatusBar.text = `$(book) INI: ${localize('statusbar.setDictionary', 'Set Dictionary')}`;
			mainStatusBar.tooltip = dictPath 
				? localize('statusbar.setDictionary.tooltip.failed', 'Failed to load INI Dictionary file: {0}\nClick to reconfigure.', dictPath)
				: localize('statusbar.setDictionary.tooltip.notSet', 'INI Dictionary file is not set. Click to configure to enable IntelliSense.');
			mainStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else if (iniValidator.status === 'invalid') {
			mainStatusBar.text = `$(error) INI Validator`;
			mainStatusBar.tooltip = localize('statusbar.validator.invalid.tooltip', 'INI Validator configuration error: {0}\nClick to manage.', iniValidator.statusDetails);
			mainStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		} else {
			mainStatusBar.text = `$(check) INI: ${localize('statusbar.ready', 'Ready')}`;
			const dictPath = config.get<string>('schemaFilePath')!;
			
			let tooltip = localize('statusbar.ready.tooltip.base', 'INI IntelliSense is ready') +
				`\n- ${localize('statusbar.ready.tooltip.project', 'Project')}: ${path.basename(projectRoot)}` +
				`\n- ${localize('statusbar.ready.tooltip.dictionary', 'Dictionary')}: ${path.basename(dictPath)}` +
				`\n- ${localize('statusbar.ready.tooltip.indexed', 'Indexed Files')}: ${iniManager.documents.size}`;
			
			if(iniValidator.status === 'ready') {
				tooltip += `\n- ${localize('statusbar.ready.tooltip.validator', 'Validator')}: ${localize('statusbar.ready.tooltip.validator.ready', 'Ready')}`;
			} else {
				tooltip += `\n- ${localize('statusbar.ready.tooltip.validator', 'Validator')}: ${localize('statusbar.ready.tooltip.validator.notConfigured', 'Not Configured')}`;
			}
			mainStatusBar.tooltip = tooltip;
			mainStatusBar.backgroundColor = undefined;
		}
		mainStatusBar.show();
	}
    
	async function loadSchemaFromConfiguration() {
		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
		let schemaPath = config.get<string | null>('schemaFilePath', null);
		
		if (schemaPath) {
			try {
				const schemaUri = vscode.Uri.file(schemaPath);
				const schemaContentBytes = await vscode.workspace.fs.readFile(schemaUri);
				const schemaContent = Buffer.from(schemaContentBytes).toString('utf-8');
				schemaManager.loadSchema(schemaContent, schemaPath);
				
				// 加载描述文件
				try {
					// 设置描述管理器语言
					const language = vscode.env.language;
					descriptionManager.setLanguage(language);
					
					// 设置描述文件目录（字典文件所在目录）
					const dictDir = path.dirname(schemaPath);
					descriptionManager.setDescriptionDir(dictDir);
					
					// 从字典文件加载描述
					const loaded = descriptionManager.loadFromDictionary(schemaPath);
					if (loaded) {
						console.log(`[INI IntelliSense] Loaded descriptions for language: ${language}`);
					} else {
						console.log(`[INI IntelliSense] No descriptions loaded for language: ${language}`);
					}
				} catch (descError) {
					console.error('[INI IntelliSense] Failed to load descriptions:', descError);
					// 描述加载失败不应阻止主流程
				}
			} catch (error) {
				schemaManager.clearSchema();
				vscode.window.showErrorMessage(localize('schema.load.failure', 'Failed to load the specified INI Dictionary file: {0}.', schemaPath));
			}
		} else {
			schemaManager.clearSchema();
		}
		
		indexWorkspaceFiles();
        
        // 初始全量诊断（现在是异步调度）
        if (vscode.window.activeTextEditor) {
            diagnosticManager.handleDocumentChange(vscode.window.activeTextEditor.document);
        }
	}
	
	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.configureSchemaPath', async () => {
		const options: vscode.OpenDialogOptions = {
			canSelectMany: false,
			openLabel: localize('command.configureSchema.openLabel', 'Select INIDictionary.ini'),
			filters: { [localize('command.configureSchema.filterLabel', 'INI Files')]: ['ini'] }
		};
		const fileUri = await vscode.window.showOpenDialog(options);
		if (fileUri && fileUri[0]) {
			await vscode.workspace.getConfiguration('ra2-ini-intellisense').update('schemaFilePath', fileUri[0].fsPath, vscode.ConfigurationTarget.Workspace);
		}
	}));
	
	async function configureModPath() {
        const options: vscode.OpenDialogOptions = {
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '选择Mod根目录'
        };
        const folderUri = await vscode.window.showOpenDialog(options);
        if (folderUri && folderUri[0]) {
            await vscode.workspace.getConfiguration('ra2-ini-intellisense').update('validationFolderPath', folderUri[0].fsPath, vscode.ConfigurationTarget.Workspace);
        }
    }

	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.showWelcomePage', () => {
		WelcomePanel.createOrShow(context);
	}));
	
	registerExtractSuperclassCommand(iniManager);
	registerRegisterIdCommand(iniManager, schemaManager);
	registerFormattingCommands();

	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.showMainQuickPick', async () => {
		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        const notSetDescription = localize('mainMenu.description.notSet', 'Click to set');

        const projectRoot = getProjectRoot();
        const dictPath = config.get<string>('schemaFilePath');

        const modPathDesc = projectRoot 
            ? localize('mainMenu.description.modPath', 'Current: {0}', path.basename(projectRoot)) 
            : notSetDescription;
        const dictPathDesc = dictPath
            ? localize('mainMenu.description.dictPath', 'Current: {0}', path.basename(dictPath))
            : notSetDescription;

        let validatorStatusText: string;
        switch(iniValidator.status) {
            case 'ready': validatorStatusText = localize('validator.status.ready.short', 'Ready'); break;
            case 'invalid': validatorStatusText = localize('validator.status.invalid.short', 'Invalid Path'); break;
            case 'unconfigured': default: validatorStatusText = localize('validator.status.unconfigured.short', 'Not Configured'); break;
        }
        const validatorDesc = localize('mainMenu.description.validatorStatus', 'Status: {0}', validatorStatusText);

		const items: vscode.QuickPickItem[] = [
			{ label: "$(rocket) 显示设置向导", description: "重新打开首次配置页面" },
			{ label: "$(folder) 设置Mod根目录...", description: modPathDesc },
			{ label: "$(book) 设置INI Dictionary文件...", description: dictPathDesc },
			{ label: "$(bug) 管理INI Validator...", description: validatorDesc },
			{ label: "$(refresh) 重新索引工作区", description: "手动强制刷新所有文件的索引" },
			{ label: "$(json) 打开插件设置 (JSON)", description: "查看所有高级配置" },
		];
		
		const selection = await vscode.window.showQuickPick(items, {
			placeHolder: "INI IntelliSense 主菜单"
		});

		if (!selection) {return;}

		if (selection.label.includes("设置向导")) {
			vscode.commands.executeCommand('ra2-ini-intellisense.showWelcomePage');
		} else if (selection.label.includes("Mod根目录")) {
			await configureModPath();
		} else if (selection.label.includes("INI Dictionary")) {
			vscode.commands.executeCommand('ra2-ini-intellisense.configureSchemaPath');
		} else if (selection.label.includes("INI Validator")) {
			iniValidator.showQuickPick();
		} else if (selection.label.includes("重新索引")) {
			await indexWorkspaceFiles();
			vscode.window.showInformationMessage("工作区已重新索引。");
		} else if (selection.label.includes("插件设置")) {
			vscode.commands.executeCommand('workbench.action.openSettings', 'ra2-ini-intellisense');
		}
	}));


	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.jumpToOverride', async (args) => {
		const { uri, position } = args;
		const targetUri = vscode.Uri.parse(uri);
		const targetPosition = new vscode.Position(position.line, position.character);
		
		const document = await vscode.workspace.openTextDocument(targetUri);
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(targetPosition, targetPosition);
		editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);
	}));

	updateMainStatus();
    updateFileTypeStatus(vscode.window.activeTextEditor);

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        updateFileTypeStatus(editor);
        if (editor) {
            diagnosticManager.handleDocumentChange(editor.document);
        }
    }));

    // --- 核心事件绑定：极限性能优化 ---

    // 1. 视口变化：极速检查可见区域
    context.subscriptions.push(vscode.window.onDidChangeTextEditorVisibleRanges(e => {
        diagnosticManager.handleViewportChange(e.textEditor);
        overrideDecorator.triggerUpdateDecorations(e.textEditor, true);
        valuePreviewDecorator.triggerUpdate(e.textEditor, true);
    }));

    // 2. 文档内容变化：热更新当前行 + 增量解析
	vscode.workspace.onDidChangeTextDocument(async event => {
		if (event.document.languageId === LANGUAGE_ID) {
			await iniManager.updateFile(event.document.uri, event.document.getText());
            // 传入变更范围，触发局部热检查
			diagnosticManager.handleDocumentChange(event.document, event.contentChanges.map(c => c.range));
            // 触发装饰器（防抖）
            overrideDecorator.triggerUpdateDecorations(vscode.window.activeTextEditor, true);
            valuePreviewDecorator.triggerUpdate(vscode.window.activeTextEditor, true);
		}
	});

	loadSchemaFromConfiguration().then(() => {
		overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();
        // 初始加载时触发所有编辑器的预览更新
        if (vscode.window.activeTextEditor) {
            valuePreviewDecorator.triggerUpdate(vscode.window.activeTextEditor);
        }
	});

	let codeLensProvider: vscode.Disposable | undefined;
	function updateCodeLensProvider() {
		const isEnabled = vscode.workspace.getConfiguration('ra2-ini-intellisense').get('codeLens.enabled');
		if (isEnabled) {
			if (!codeLensProvider) {
				codeLensProvider = vscode.languages.registerCodeLensProvider(selector, {
					provideCodeLenses(document, token) {
						if (isIndexing) { return []; }
						const codeLenses: vscode.CodeLens[] = [];
                        // 使用新 API：直接遍历 Sections
                        const doc = iniManager.getDocument(document.uri.fsPath);
                        if (!doc) { return []; }

						for (const sec of doc.sections) {
                            const valueRefs = iniManager.valueReferences.get(sec.name) || [];
                            const inheritanceRefs = iniManager.inheritanceReferences.get(sec.name) || [];
                            
                            const range = new vscode.Range(sec.startLine, 0, sec.startLine, 100);
                            const parts: string[] = [];

                            if (valueRefs.length > 0) {
                                parts.push(localize('codelens.references', '{0} references', valueRefs.length));
                            }
                            if (inheritanceRefs.length > 0) {
                                parts.push(localize('codelens.inheritors', '{0} inheritors', inheritanceRefs.length));
                            }
    
                            let title: string;
                            if (parts.length > 0) {
                                title = parts.join(', ');
                            } else {
                                title = localize('codelens.noReferences', '0 references (potentially unused)');
                            }
    
                            codeLenses.push(new vscode.CodeLens(range, {
                                title: title,
                                command: 'editor.action.findReferences',
                                arguments: [document.uri, new vscode.Position(sec.startLine, 1)]
                            }));
						}
						return codeLenses;
					}
				});
				context.subscriptions.push(codeLensProvider);
			}
		} else {
			codeLensProvider?.dispose();
			codeLensProvider = undefined;
		}
	}

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('ra2-ini-intellisense')) {
            if (e.affectsConfiguration('ra2-ini-intellisense.indexing')) {
                fileTypeManager.reloadConfig();
            }

			loadSchemaFromConfiguration().then(() => {
				updateMainStatus();
                updateFileTypeStatus(vscode.window.activeTextEditor);
				if (e.affectsConfiguration('ra2-ini-intellisense.codeLens.enabled')) {
					updateCodeLensProvider();
				}
				if (e.affectsConfiguration('ra2-ini-intellisense.decorations')) {
					overrideDecorator.reload();
				}
                // 配置变更触发全量重查
				vscode.window.visibleTextEditors.forEach(e => diagnosticManager.handleDocumentChange(e.document));
				overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();
                if (vscode.window.activeTextEditor) {
                    valuePreviewDecorator.triggerUpdate(vscode.window.activeTextEditor);
                }
			});
		}
	}));
	updateCodeLensProvider();

	const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
	context.subscriptions.push(watcher);
	
	const onFileChange = async (uri: vscode.Uri) => {
		console.log(`INI 文件变更: ${uri.fsPath}, 正在增量更新索引...`);
		await iniManager.updateFile(uri);
        // 外部文件变更（非编辑器输入），触发全量刷新
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (doc) { diagnosticManager.handleDocumentChange(doc); }
        
        overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();
		outlineProvider.refresh();
	};

	const onFileDelete = (uri: vscode.Uri) => {
		console.log(`INI 文件删除: ${uri.fsPath}, 正在移除索引...`);
		iniManager.removeFile(uri);
		outlineProvider.refresh();
	};

	watcher.onDidCreate(onFileChange);
	watcher.onDidChange(onFileChange);
	watcher.onDidDelete(onFileDelete);

	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.showDebugInfo', () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage(localize('debug.openFileFirst', 'Please open an INI file before running this command.'));
			return;
		}

		const position = editor.selection.active;
		const document = editor.document;
		
		outputChannel.clear();
		outputChannel.appendLine(localize('debug.title', '--- INI IntelliSense Debug Info ---\n'));

		const idListRegistryNames = schemaManager.getIdListRegistryNames();
		if (idListRegistryNames.size > 0) {
			outputChannel.appendLine(localize('debug.schema.loaded', '✅ Schema loaded: Found {0} registries in total.', schemaManager.getRegistryNames().size));
			outputChannel.appendLine(localize('debug.schema.idRegistriesFound', '✅ Identified {0} ID list registries for indexing:', idListRegistryNames.size));
			outputChannel.appendLine(`   ${Array.from(idListRegistryNames).join(', ')}`);
		} else {
			outputChannel.appendLine(localize('debug.schema.noIdRegistries', '❌ Warning: No ID list registries identified from the schema. Type inference will fail.'));
		}
		outputChannel.appendLine(localize('debug.index.summary', '✅ Indexing complete: Found {0} unique registered section IDs across all files.\n', iniManager.getRegistryMapSize()));

		outputChannel.appendLine(localize('debug.context.title', '--- Context Info ---'));
		outputChannel.appendLine(localize('debug.context.file', 'File: {0}', document.uri.fsPath));
        outputChannel.appendLine(`File Type: ${fileTypeManager.getFileType(document.uri)}`);
		outputChannel.appendLine(localize('debug.context.position', 'Cursor Position: Line {0}, Character {1}\n', position.line + 1, position.character + 1));

		const currentSectionName = iniManager.getSectionNameAtLine(document.uri.fsPath, position.line);

		if (!currentSectionName) {
			outputChannel.appendLine(localize('debug.context.noSection', 'Error: Cursor is not within a valid section.'));
			outputChannel.show();
			return;
		}
		
		outputChannel.appendLine(localize('debug.context.currentSection', '✅ Current Section: [{0}]', currentSectionName));

		const typeName = iniManager.getTypeForSection(currentSectionName);
		if (typeName) {
			outputChannel.appendLine(localize('debug.inference.success', "✅ Inferred Type: '{0}'", typeName));

			const debugLines = schemaManager.getDebugInfoForType(typeName);
			outputChannel.appendLine(localize('debug.analysis.title', '\n--- Type Inheritance & Key Analysis ---'));
			debugLines.forEach(line => outputChannel.appendLine(line));

			const allKeys = schemaManager.getAllKeysForType(typeName);
			if (allKeys.size > 0) {
				outputChannel.appendLine(localize('debug.analysis.totalKeys', '\n✅ Total available keys (including inherited): {0}', allKeys.size));
			} else {
				outputChannel.appendLine(localize('debug.analysis.noKeys', `\n❌ Warning: No keys found for type '{0}' after analyzing inheritance chain.`, typeName));
			}
		} else {
			outputChannel.appendLine(localize('debug.inference.failure', '\n❌ Error: Could not determine the type to analyze.'));
		}
		
		outputChannel.show();
	}));

	context.subscriptions.push(
		vscode.languages.registerRenameProvider(selector, new IniRenameProvider(iniManager)),
		vscode.languages.registerCodeActionsProvider(selector, new IniCodeActionProvider(iniManager, schemaManager), {
			providedCodeActionKinds: IniCodeActionProvider.providedCodeActionKinds
		})
	);

	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider(selector, {
			async provideDefinition(document, position, token) {
				if (isIndexing) { return []; }
				const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
				if (!wordRange) { return []; }
				const word = document.getText(wordRange);

                // 优先查找节定义
				const lineInCurrentFile = iniManager.findSectionInContent(document.getText(), word);
				if (lineInCurrentFile !== null) {
					return new vscode.Location(document.uri, new vscode.Position(lineInCurrentFile, 0));
				}
				
				const sectionLocations = iniManager.findSectionLocations(word);
				if (sectionLocations.length > 0) {
					return sectionLocations;
				}
				return [];
			}
		}),
		vscode.languages.registerHoverProvider(selector, {
			provideHover(document, position, token) {
				if (isIndexing) { return null; }
				const line = document.lineAt(position.line);
				const lineText = line.text;
				const equalsIndex = lineText.indexOf('=');

                // Hover on Section Name
				if (equalsIndex === -1) { 
					const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
					if (!wordRange) {return null;}

					const word = document.getText(wordRange);
                    const secDoc = iniManager.getDocument(document.uri.fsPath); // 假设同文件
                    if (secDoc) {
                        const commentText = iniManager.getSectionComment(secDoc.content, word);
                        if (commentText) {
                            return new vscode.Hover(new vscode.MarkdownString(commentText), wordRange);
                        }
                    }
					return null;
				}

                // Hover on Key
				const keyPart = lineText.substring(0, equalsIndex).trim();
                const valueRaw = lineText.substring(equalsIndex + 1).split(';')[0].trim();
				const keyRange = new vscode.Range(position.line, line.firstNonWhitespaceCharacterIndex, position.line, equalsIndex);

				if (!keyRange.contains(position)) {return null;}

				const currentSectionName = iniManager.getSectionNameAtLine(document.uri.fsPath, position.line);
				if (!currentSectionName) {return null;}
		
				const markdown = new vscode.MarkdownString("", true);
				markdown.isTrusted = true;
				markdown.supportThemeIcons = true;
				let hasContent = false;

				const typeName = iniManager.getTypeForSection(currentSectionName);
				if (typeName) {
					const allKeys = schemaManager.getAllKeysForType(typeName);
					let propDef: import('./schema-manager').PropertyDefinition | undefined;
					for (const [k, v] of allKeys.entries()) {
						if (k.toLowerCase() === keyPart.toLowerCase()) {
							propDef = v;
							break;
						}
					}
			
					if (propDef) {
						markdown.appendCodeblock(`${keyPart}: ${propDef.type}`, 'ini');
                        if (propDef.defaultValue) {
                            markdown.appendMarkdown(`\n- Default: \`${propDef.defaultValue}\``);
                        }
                        if (propDef.fileType) {
                            markdown.appendMarkdown(`\n- File Type: \`${propDef.fileType}\``);
                        }
                        if (propDef.source && propDef.source !== 'INIDictionary') {
                             markdown.appendMarkdown(`\n- Source: **${propDef.source}**`);
                        }
                         const csfEntry = csfManager.getLabel(valueRaw);
                        if (csfEntry) {
                            markdown.appendMarkdown(`\n\n**CSF**: ${csfEntry.value}`);
                        }

                        // 添加描述
                        // 首先尝试使用节名查找（描述文件中的节名）
                        let description = descriptionManager.getDescription(currentSectionName, keyPart);
                        // 如果没找到，尝试使用类型名
                        if (!description && typeName && typeName !== currentSectionName) {
                            description = descriptionManager.getDescription(typeName, keyPart);
                        }
                        if (description) {
                            markdown.appendMarkdown('\n\n---\n\n');
                            markdown.appendMarkdown(description);
                        }

                        markdown.appendMarkdown('\n\n---\n\n');
						markdown.appendMarkdown(localize('hover.type.belongsTo', `\n\nBelongs to type **{0}**.`, typeName));
						hasContent = true;
					}
				}

                const currentFileType = fileTypeManager.getFileType(document.uri);
				const parentName = iniManager.getInheritance(currentSectionName, currentFileType);
				if (parentName) {
                    const currentFileType = fileTypeManager.getFileType(document.uri);
					const parentKeyInfo = iniManager.findKeyLocationRecursive(parentName, keyPart, currentFileType); 
				
					if (parentKeyInfo && parentKeyInfo.location && parentKeyInfo.lineText && parentKeyInfo.definer) {
						if(hasContent) {markdown.appendMarkdown('\n\n---\n\n');}

						const lineNum = parentKeyInfo.location.range.start.line + 1;
						const fileName = path.basename(parentKeyInfo.location.uri.fsPath);

						markdown.appendMarkdown(localize('hover.override.info', `This key overrides a value from base class in **{0}**:L{1}`, fileName, lineNum));
						
						const parentValueMatch = parentKeyInfo.lineText.match(/=\s*(.*)/);
						const parentValueRaw = parentValueMatch ? parentValueMatch[1].trim() : '';
						const parentValue = parentValueRaw.split(';')[0].trim();

						markdown.appendCodeblock(`[${parentKeyInfo.definer}]\n${keyPart}=${parentValue || ''}`, 'ini');

						const args = {
							uri: parentKeyInfo.location.uri.toString(),
							position: parentKeyInfo.location.range.start
						};
						const commandUri = vscode.Uri.parse(`command:ra2-ini-intellisense.jumpToOverride?${encodeURIComponent(JSON.stringify(args))}`);
						markdown.appendMarkdown(localize('hover.override.jumpLink', `[$(go-to-file) Go to Parent Definition]({0})`, commandUri.toString()));
						hasContent = true;
					}
				}

				return hasContent ? new vscode.Hover(markdown, keyRange) : null;
			}
		}),
		vscode.languages.registerCompletionItemProvider(selector, {
			async provideCompletionItems(document, position, token, context) {
				if (isIndexing) { return new vscode.CompletionList([], true); }
				const line = document.lineAt(position.line);
				const equalsIndex = line.text.indexOf('=');
				const isKeyCompletion = equalsIndex === -1 || position.character <= equalsIndex;

				const currentSectionName = iniManager.getSectionNameAtLine(document.uri.fsPath, position.line);
				if (!currentSectionName) {return new vscode.CompletionList([], false);}
		
				const typeName = iniManager.getTypeForSection(currentSectionName);
				if (!typeName) {return new vscode.CompletionList([], false);}

				if (isKeyCompletion) {
					const keys = schemaManager.getAllKeysForType(typeName);
					if (keys.size === 0) {return new vscode.CompletionList([], false);}
                    
                    const currentFileType = fileTypeManager.getFileType(document.uri);
			
					const items = Array.from(keys.entries())
                        .filter(([key, propDef]) => {
                             if (propDef.fileType && currentFileType !== 'INI' && propDef.fileType !== currentFileType) {
                                 return false;
                             }
                             return true;
                        })
                        .map(([key, propDef]) => {
                            const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
                            item.detail = `(${propDef.type})`;
                            if (propDef.defaultValue) {
                                item.documentation = `Default: ${propDef.defaultValue}`;
                            }
                            return item;
					    });
					return new vscode.CompletionList(items, false);
				} else {
					const suggestions: vscode.CompletionItem[] = [];
					const currentKey = line.text.substring(0, equalsIndex).trim();
					const allKeys = schemaManager.getAllKeysForType(typeName);
						
					let valueType: string | undefined;
					for (const [key, propDef] of allKeys.entries()) {
						if (key.toLowerCase() === currentKey.toLowerCase()) {
							valueType = propDef.type;
							break;
						}
					}

					if (valueType) {
						if (valueType.toLowerCase() === 'bool') {
							suggestions.push(new vscode.CompletionItem('yes', vscode.CompletionItemKind.Keyword));
							suggestions.push(new vscode.CompletionItem('no', vscode.CompletionItemKind.Keyword));
							return new vscode.CompletionList(suggestions, true);
						}
						if (valueType === 'ColorStruct') {
							const item = new vscode.CompletionItem('R,G,B', vscode.CompletionItemKind.Color);
							item.insertText = '255,255,255';
							item.documentation = localize('completion.color.documentation', 'Enter an RGB color value, e.g., 255,0,0');
							suggestions.push(item);
						}
						const targetRegistry = schemaManager.getRegistryForType(valueType);
						if (targetRegistry) {
							const ids = iniManager.getValuesForRegistry(targetRegistry);
							ids.forEach(id => suggestions.push(new vscode.CompletionItem(id, vscode.CompletionItemKind.EnumMember)));
							if (suggestions.length > 0) {return new vscode.CompletionList(suggestions, true);}
						}
					}
					
					const fallbackSuggestions = new Map<string, vscode.CompletionItem>();
					iniManager.getAllSectionNames().forEach(name => {
						if (!fallbackSuggestions.has(name)) {
							fallbackSuggestions.set(name, new vscode.CompletionItem(name, vscode.CompletionItemKind.Module));
						}
					});
					if (currentKey) {
						iniManager.getValuesForKey(currentKey).forEach(value => {
							if (!fallbackSuggestions.has(value)) {
								const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
								if (/^-?\d+(\.\d+)?$/.test(value)) {
									item.kind = vscode.CompletionItemKind.Constant;
								} else if (['true', 'false', 'yes', 'no'].includes(value.toLowerCase())) {
									item.kind = vscode.CompletionItemKind.Keyword;
								}
								fallbackSuggestions.set(value, item);
							}
						});
					}
					suggestions.push(...Array.from(fallbackSuggestions.values()));
					
					return new vscode.CompletionList(suggestions, false);
				}
			}
		}),
		vscode.languages.registerColorProvider(selector, {
			provideDocumentColors(document, token) {
				if (isIndexing) { return []; }
				const colors: vscode.ColorInformation[] = [];
				for (let i = 0; i < document.lineCount; i++) {
					const line = document.lineAt(i);
					const equalsIndex = line.text.indexOf('=');
					if (equalsIndex === -1) {continue;}

					const currentSectionName = iniManager.getSectionNameAtLine(document.uri.fsPath, i);
					if (!currentSectionName) {continue;}
					
					const currentKey = line.text.substring(0, equalsIndex).trim();
					const typeName = iniManager.getTypeForSection(currentSectionName);

					if (typeName) {
						const allKeys = schemaManager.getAllKeysForType(typeName);
						let valueType: string | undefined;
						for (const [key, propDef] of allKeys.entries()) {
							if (key.toLowerCase() === currentKey.toLowerCase()) {
								valueType = propDef.type;
								break;
							}
						}

						if (valueType === 'ColorStruct') {
							const valuePart = line.text.substring(equalsIndex + 1).split(';')[0].trim();
							const rgb = valuePart.match(/^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/);
							if (rgb) {
								const r = parseInt(rgb[1], 10);
								const g = parseInt(rgb[2], 10);
								const b = parseInt(rgb[3], 10);
								if (r <= 255 && g <= 255 && b <= 255) {
									const range = new vscode.Range(i, equalsIndex + 1, i, line.text.length);
									colors.push(new vscode.ColorInformation(range, new vscode.Color(r / 255, g / 255, b / 255, 1)));
								}
							}
						}
					}
				}
				return colors;
			},
			provideColorPresentations(color, context, token) {
				const r = Math.round(color.red * 255);
				const g = Math.round(color.green * 255);
				const b = Math.round(color.blue * 255);
				return [new vscode.ColorPresentation(`${r},${g},${b}`)];
			}
		}),
		vscode.languages.registerReferenceProvider(selector, {
			provideReferences(document, position, context, token) {
				if (isIndexing) { return []; }
				const line = document.lineAt(position.line);
				const sectionMatch = line.text.match(/^\s*\[([^\]:]+)\]/);
				if (sectionMatch) {
					const sectionName = sectionMatch[1];
					const valueRefs = iniManager.valueReferences.get(sectionName) || [];
					const inheritanceRefs = iniManager.inheritanceReferences.get(sectionName) || [];
					return [...valueRefs, ...inheritanceRefs];
				}
				return [];
			}
		}),
		vscode.languages.registerFoldingRangeProvider(selector, {
			provideFoldingRanges(document, context, token) {
                // 使用新模型极速生成折叠范围
                const doc = iniManager.getDocument(document.uri.fsPath);
                if (!doc) { return []; }
                
                return doc.sections.map(sec => {
                    // 仅当范围跨越多行时才折叠
                    if (sec.endLine > sec.startLine) {
                        return new vscode.FoldingRange(sec.startLine, sec.endLine, vscode.FoldingRangeKind.Region);
                    }
                    return null;
                }).filter(r => r !== null) as vscode.FoldingRange[];
			}
		}),
	);
	promptForInitialSetup();

    // 确保在激活时初始化
    async function promptForInitialSetup() {
		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
		const projectRoot = getProjectRoot();
        const dictPath = config.get<string>('schemaFilePath');
		const dontAsk = config.get<boolean>('dontAskToConfigureProject');

		if ((!projectRoot || !dictPath) && !dontAsk) {
            const openWizardAction = localize('prompt.configureII.action.welcome', 'Open Setup Guide');
			const dontAskAction = localize('prompt.configureII.action.dontAsk', "Don't Ask Again");
            
            let message: string;
            let quickAction: string | undefined;

            if (!projectRoot) {
                message = localize('prompt.configureII.message.root', 'Welcome to INI IntelliSense! Please set your Mod project root directory to enable all features.');
            } else {
                message = localize('prompt.configureII.message.dict', 'INI Dictionary is missing. Would you like to download and configure it automatically?');
                quickAction = localize('prompt.configureII.action.autoConfig', 'Auto Configure');
            }

            const items = quickAction ? [quickAction, openWizardAction, dontAskAction] : [openWizardAction, dontAskAction];
			const selection = await vscode.window.showInformationMessage(message, ...items);

            if (selection === quickAction && quickAction) {
                await dictionaryService.downloadAndConfigure();
                await loadSchemaFromConfiguration(); 
                updateMainStatus();
            } else if (selection === openWizardAction) {
				vscode.commands.executeCommand('ra2-ini-intellisense.showWelcomePage');
			} else if (selection === dontAskAction) {
				await config.update('dontAskToConfigureProject', true, vscode.ConfigurationTarget.Workspace);
			}
		}
	}
}

export function deactivate() {
    // 这里的清理工作由 subscriptions 自动处理
}