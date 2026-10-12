import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';
import { SchemaManager } from './schema-manager';
import { IniSemanticTokensProvider, legend } from './semantic-tokens-provider';
import { DiagnosticManager } from './diagnostics/engine';
import { OverrideDecorator } from './override-decorator';
import { ValuePreviewDecorator } from './value-preview-decorator';
import { WelcomePanel } from './welcome-panel';
import { localize, initializeNls } from './i18n';
import { displayType } from './type-display';
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
import { registryValues } from './context/property-resolution';
import { parsePropertyLine } from './context/ini-position';
import { indexLogic } from './context/logic-graph';
import { AnalysisController } from './context/analysis-controller';
import { MixFileSystemProvider } from './mix/fs/mix-file-system-provider';
import { MixWorkspaceManager } from './mix/fs/mix-workspace-manager';
import { MixUriCodec } from './mix/fs/mix-uri-codec';
import { GlobalMixDb } from './mix/core/global-mix-db';
import { ResourceService } from './resources/resource-service';
import { IniFilesProvider } from './views/ini-files-provider';
import { MixFilesProvider } from './views/mix-files-provider';
import { WorkspaceIndexer } from './workspace/workspace-indexer';
import { TextContentService } from './services/text-content-service';
import { ResourceNode } from './resources/resource-node';
import { ImportExportService } from './services/import-export-service';
import { MixTreeDragAndDropController } from './views/mix-tree-drag-and-drop';
import { MixDetectorService } from './services/mix-detector-service';
import { ResourcePreviewProvider } from './preview/resource-preview-provider';
import { CompareService } from './compare/compare-service';
import { CompareResultsPanel } from './compare/compare-results-panel';
import { CompareSource } from './compare/types';
import { ProjectResources } from './resources/project-resources';
import { ResourceAudit } from './context/resource-audit';
import { DecoderService } from './media/decoder-service';
import { MediaService } from './media/media-service';
import { InspectionService } from './context/inspection-service';
import { ProjectWorkbench } from './views/project-workbench';
import { WorkbenchController } from './context/workbench-controller';
import { MediaHoverProvider } from './context/media-hover';
import { MediaDecorations } from './context/media-decorations';

const LANGUAGE_ID = 'ra2-ini';

export async function activate(context: vscode.ExtensionContext) {
    initializeNls(context);
	const outputChannel = vscode.window.createOutputChannel(localize('output.channel.name', 'RA2 Mod IntelliSense'));
	
	const iniManager = new INIManager();
	context.subscriptions.push(iniManager);
	const schemaManager = new SchemaManager();
    const fileTypeManager = new FileTypeManager();
    const csfManager = new CsfManager();
    const csfOutlineProvider = new CsfOutlineProvider(csfManager);
    const descriptionManager = new DescriptionManager();
    const textContentService = new TextContentService();
    const globalMixDb = new GlobalMixDb(context);
    const mixWorkspaceManager = new MixWorkspaceManager(globalMixDb, textContentService);
    const mixFileSystemProvider = new MixFileSystemProvider(mixWorkspaceManager);
    const mixDetectorService = new MixDetectorService(mixWorkspaceManager);
    const resourceService = new ResourceService(mixDetectorService);
    const iniFilesProvider = new IniFilesProvider(resourceService);
    const mixFilesProvider = new MixFilesProvider(resourceService);
    const workspaceIndexer = new WorkspaceIndexer();
    const importExportService = new ImportExportService();
    const mixTreeDnD = new MixTreeDragAndDropController(importExportService);
    const compareService = new CompareService(textContentService);
    const resourcePreviewProvider = new ResourcePreviewProvider({
        iniManager,
        extensionUri: context.extensionUri,
    });
    
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

	context.subscriptions.push(vscode.window.createTreeView('csf-outline', { treeDataProvider: csfOutlineProvider }));
	context.subscriptions.push(vscode.window.createTreeView('ini-files', { treeDataProvider: iniFilesProvider, canSelectMany: true }));
	context.subscriptions.push(vscode.window.createTreeView('mix-files', { treeDataProvider: mixFilesProvider, dragAndDropController: mixTreeDnD, canSelectMany: true }));
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider(MixUriCodec.scheme, mixFileSystemProvider, { isCaseSensitive: false }));
    const projectResources = new ProjectResources(mixWorkspaceManager);
    const decoder = new DecoderService(vscode.Uri.joinPath(context.extensionUri, 'dist', 'media-worker.js').fsPath);
    const media = new MediaService(projectResources, decoder, context.extensionUri);
    const inspection = new InspectionService(projectResources, media, iniManager, schemaManager, fileTypeManager, (key) => csfManager.getLabel(key)?.value);
    diagnosticManager.project = inspection.ini;
    overrideDecorator.project = inspection.ini;
    valuePreviewDecorator.project = inspection.ini;
    context.subscriptions.push(new AnalysisController(context, inspection, schemaManager, descriptionManager, diagnosticManager, key => csfManager.getLabel(key)?.value));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.downloadDictionary', async () => { await dictionaryService.downloadAndConfigure(); await loadSchemaFromConfiguration(); }));
    const workbench = new WorkbenchController(context, inspection, media);
    context.subscriptions.push(new ProjectWorkbench(inspection), projectResources, decoder, inspection, workbench, new ResourceAudit(inspection),
        vscode.window.registerWebviewViewProvider(WorkbenchController.viewId, workbench, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.languages.registerHoverProvider(selector, new MediaHoverProvider(inspection, context, decoder)),
        new MediaDecorations(inspection, context, decoder));
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(ResourcePreviewProvider.viewType, workbench, {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
            retainContextWhenHidden: true,
        },
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.previewMapToSide', async (uri?: vscode.Uri) => {
        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            return;
        }
        await resourcePreviewProvider.openMapPreviewToSide(targetUri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.refreshCsfOutline', () => csfOutlineProvider.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.refreshIniFiles', () => {
        resourceService.clearCaches();
        iniFilesProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.refreshMixFiles', () => {
        mixWorkspaceManager.clearCache();
        mixDetectorService.clear();
        resourceService.clearCaches();
        mixFilesProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.mix.openAsWorkspace', async (nodeOrUri?: ResourceNode | vscode.Uri) => {
        const targetUri = nodeOrUri instanceof vscode.Uri ? nodeOrUri : nodeOrUri?.uri;
        if (!targetUri) {
            return;
        }

        if (targetUri.scheme === MixUriCodec.scheme) {
            const decoded = MixUriCodec.decode(targetUri);
            const lowerName = decoded.virtualPath.split('/').pop()?.toLowerCase();
            const nextChain = lowerName?.endsWith('.mix')
                ? [...decoded.nestedChain, lowerName]
                : decoded.nestedChain;
            await mixWorkspaceManager.openAsWorkspace(decoded.containerUri, nextChain, true);
            return;
        }

        await mixWorkspaceManager.openAsWorkspace(targetUri, [], true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.mix.openAsWorkspaceInNewWindow', async (nodeOrUri?: ResourceNode | vscode.Uri) => {
        const targetUri = nodeOrUri instanceof vscode.Uri ? nodeOrUri : nodeOrUri?.uri;
        if (!targetUri) {
            return;
        }

        if (targetUri.scheme === MixUriCodec.scheme) {
            const decoded = MixUriCodec.decode(targetUri);
            const leaf = decoded.virtualPath.split('/').pop()?.toLowerCase();
            const nextChain = leaf?.endsWith('.mix')
                ? [...decoded.nestedChain, leaf]
                : decoded.nestedChain;
            await mixWorkspaceManager.openAsWorkspace(decoded.containerUri, nextChain, true);
            return;
        }

        await mixWorkspaceManager.openAsWorkspace(targetUri, [], true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.mix.importFiles', async (node?: ResourceNode) => {
        const targetUri = resolveMixTargetUri(node);
        if (!targetUri) {
            return;
        }

        const sources = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: true,
            openLabel: localize('mix.import.selectFiles', 'Import into MIX'),
        });
        if (!sources || sources.length === 0) {
            return;
        }

        await importExportService.importIntoMix(targetUri, sources);
        mixFilesProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.mix.export', async (node?: ResourceNode, selection?: ResourceNode[]) => {
        const sources = selection && selection.length > 0
            ? selection.filter(item => item.uri.scheme === MixUriCodec.scheme).map(item => item.uri)
            : node?.uri && node.uri.scheme === MixUriCodec.scheme
                ? [node.uri]
                : [];
        if (sources.length === 0) {
            return;
        }

        await importExportService.exportFromMix(sources);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.mix.newFolder', async (node?: ResourceNode) => {
        const targetUri = resolveMixTargetUri(node);
        if (!targetUri) {
            return;
        }

        const folderName = await vscode.window.showInputBox({
            prompt: localize('mix.newFolder.prompt', 'Enter a new folder name'),
            validateInput: value => value.trim().length === 0 ? localize('mix.newFolder.validation', 'Folder name cannot be empty.') : null,
        });
        if (!folderName) {
            return;
        }

        const newUri = MixUriCodec.toChildUri(targetUri, `${targetUri.path}/${folderName}`);
        await vscode.workspace.fs.createDirectory(newUri);
        mixFilesProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.mix.rename', async (node?: ResourceNode) => {
        if (!node || node.uri.scheme !== MixUriCodec.scheme) {
            return;
        }

        const oldName = node.label;
        const newName = await vscode.window.showInputBox({
            prompt: localize('mix.rename.prompt', 'Enter a new name'),
            value: oldName,
            validateInput: value => value.trim().length === 0 ? localize('mix.rename.validation', 'Name cannot be empty.') : null,
        });
        if (!newName || newName === oldName) {
            return;
        }

        const parentPath = node.uri.path.substring(0, node.uri.path.lastIndexOf('/')) || '/';
        const newUri = MixUriCodec.toChildUri(node.uri, `${parentPath}/${newName}`);
        await vscode.workspace.fs.rename(node.uri, newUri, { overwrite: false });
        mixFilesProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.mix.delete', async (node?: ResourceNode, selection?: ResourceNode[]) => {
        const targets = selection && selection.length > 0
            ? selection.filter(item => item.uri.scheme === MixUriCodec.scheme)
            : node && node.uri.scheme === MixUriCodec.scheme
                ? [node]
                : [];
        if (targets.length === 0) {
            return;
        }

        const confirmed = await vscode.window.showWarningMessage(
            localize('mix.delete.confirm', 'Delete {0} selected MIX item(s)?', targets.length),
            { modal: true },
            localize('mix.delete.action', 'Delete'),
        );
        if (!confirmed) {
            return;
        }

        for (const target of targets) {
            await vscode.workspace.fs.delete(target.uri, { recursive: true });
        }
        mixFilesProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.mix.compareWith', async (node?: ResourceNode) => {
        const leftSource = await createCompareSourceFromNode(node)
            ?? await pickCompareSource(localize('compare.pick.left.title', 'Select the left source'));
        if (!leftSource) {
            return;
        }

        const rightSource = await pickCompareSource(
            localize('compare.pick.right.title', 'Select the source to compare against')
        );
        if (!rightSource) {
            return;
        }

        await runComparison(leftSource, rightSource);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.compareResources', async () => {
        const leftSource = await pickCompareSource(localize('compare.pick.left.title', 'Select the left source'));
        if (!leftSource) {
            return;
        }

        const rightSource = await pickCompareSource(
            localize('compare.pick.right.title', 'Select the right source')
        );
        if (!rightSource) {
            return;
        }

        await runComparison(leftSource, rightSource);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.mix.saveAll', async () => {
        await mixWorkspaceManager.flushAll();
        vscode.window.showInformationMessage(localize('mix.saveAll.success', 'All modified MIX archives have been saved.'));
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        mixWorkspaceManager.clearCache();
        mixDetectorService.clear();
        resourceService.clearCaches();
        iniFilesProvider.refresh();
        mixFilesProvider.refresh();
    }));

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
			const projectRoot = getProjectRoot();

			if (!projectRoot) {
				console.log('RA2 Mod IntelliSense: 未找到有效项目根目录，跳过文件索引。');
				await iniManager.indexFiles([]);
                iniFilesProvider.refresh();
                mixFilesProvider.refresh();
				return;
			}

            let rootUri: vscode.Uri;
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 && vscode.workspace.workspaceFolders[0].uri.scheme !== 'file') {
                rootUri = vscode.workspace.workspaceFolders[0].uri;
            } else {
                rootUri = vscode.Uri.file(projectRoot);
            }

			const iniFiles = await workspaceIndexer.collectFiles(rootUri, {
                includeExtensions: new Set(['.ini', '.map', '.mpr', '.yrm']),
                excludeGlobs: config.get<string[]>('indexing.excludePatterns', []),
            });
			await iniManager.indexFiles(iniFiles);
			const indexedFiles = Array.from(iniManager.documents.values()).map(doc => path.basename(doc.uri.path));
			console.log(`RA2 Mod IntelliSense: 已索引 ${iniManager.documents.size} 个INI文件: [${indexedFiles.join(', ')}]`);
            iniFilesProvider.refresh();
            mixFilesProvider.refresh();
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
			const dictPath = config.get<string | null>('schemaFilePath') ?? '';
			
			let tooltip = localize('statusbar.ready.tooltip.base', 'RA2 Mod IntelliSense is ready') +
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
                inspection.ini.invalidate();
				
				// 加载描述文件
				try {
					// 设置描述管理器语言
					const language = vscode.env.language;
					descriptionManager.setLanguage(language);
					
					// 设置描述文件目录（字典文件所在目录）
					const dictDir = path.dirname(schemaPath);
					descriptionManager.setDescriptionDir(dictDir);
					
					// 从字典文件加载描述
					let loaded = descriptionManager.loadFromDictionary(schemaPath);
                    if (!loaded) {
                        for (const language of ['zh-CN', 'en-US']) {
                            const bundled = context.asAbsolutePath('assets/descriptions/INIDictionary-' + language + '.ini');
                            if (fs.existsSync(bundled)) { loaded = descriptionManager.loadFromFile(bundled, language) || loaded; }
                        }
                    }
					if (loaded) {
						console.log(`[RA2 Mod IntelliSense] Loaded descriptions for language: ${language}`);
					} else {
						console.log(`[RA2 Mod IntelliSense] No descriptions loaded for language: ${language}`);
					}
				} catch (descError) {
					console.error('[RA2 Mod IntelliSense] Failed to load descriptions:', descError);
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
	
	registerExtractSuperclassCommand(iniManager, context);
	registerRegisterIdCommand(iniManager, schemaManager, context);
	registerFormattingCommands(context);

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

		const items: (vscode.QuickPickItem & { id: string })[] = [
			{ id: 'wizard', label: localize('mainMenu.item.wizard.label', '$(rocket) Show Setup Wizard'), description: localize('mainMenu.item.wizard.desc', 'Reopen the first-time setup page') },
			{ id: 'modRoot', label: localize('mainMenu.item.modRoot.label', '$(folder) Set Mod Root Directory...'), description: modPathDesc },
			{ id: 'dict', label: localize('mainMenu.item.dict.label', '$(book) Set INI Dictionary File...'), description: dictPathDesc },
			{ id: 'validator', label: localize('mainMenu.item.validator.label', '$(bug) Manage INI Validator...'), description: validatorDesc },
			{ id: 'compare', label: localize('mainMenu.item.compare.label', '$(git-compare) Compare Resources...'), description: localize('mainMenu.description.compareResources', 'Compare two MIX archives or folders recursively') },
			{ id: 'reindex', label: localize('mainMenu.item.reindex.label', '$(refresh) Re-index Workspace'), description: localize('mainMenu.item.reindex.desc', 'Manually force-refresh all file indexes') },
			{ id: 'settings', label: localize('mainMenu.item.settings.label', '$(json) Open Extension Settings (JSON)'), description: localize('mainMenu.item.settings.desc', 'View all advanced configuration') },
		];
		
		const selection = await vscode.window.showQuickPick(items, {
			placeHolder: localize('mainMenu.placeholder', 'RA2 Mod IntelliSense Main Menu')
		});

		if (!selection) {return;}

		switch (selection.id) {
			case 'wizard':
				vscode.commands.executeCommand('ra2-ini-intellisense.showWelcomePage');
				break;
			case 'modRoot':
				await configureModPath();
				break;
			case 'dict':
				vscode.commands.executeCommand('ra2-ini-intellisense.configureSchemaPath');
				break;
			case 'validator':
				iniValidator.showQuickPick();
				break;
			case 'compare':
				vscode.commands.executeCommand('ra2-ini-intellisense.compareResources');
				break;
			case 'reindex':
				await indexWorkspaceFiles();
				vscode.window.showInformationMessage(localize('mainMenu.info.reindexed', 'Workspace re-indexed.'));
				break;
			case 'settings':
				vscode.commands.executeCommand('workbench.action.openSettings', 'ra2-ini-intellisense');
				break;
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
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async event => {
		if (event.document.languageId === LANGUAGE_ID) {
			await iniManager.updateFile(event.document.uri, event.document.getText());
            // 传入变更范围，触发局部热检查
			for (const document of vscode.workspace.textDocuments) {
                if (document.languageId === 'ra2-ini') { diagnosticManager.handleDocumentChange(document); }
            }
            // 触发装饰器（防抖）—— 仅当变更文档是当前活动编辑器时
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document === event.document) {
                overrideDecorator.triggerUpdateDecorations(activeEditor, true);
                valuePreviewDecorator.triggerUpdate(activeEditor, true);
            }
		}
	}));

	loadSchemaFromConfiguration().then(() => {
		overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();
        // 初始加载时触发所有编辑器的预览更新
        if (vscode.window.activeTextEditor) {
            valuePreviewDecorator.triggerUpdate(vscode.window.activeTextEditor);
        }
	}).catch(error => {
        console.error('[Extension] Failed to load schema from configuration.', error);
    });

	let codeLensProvider: vscode.Disposable | undefined;
	function updateCodeLensProvider() {
		const isEnabled = vscode.workspace.textDocuments.some(document => vscode.workspace.getConfiguration('ra2-ini-intellisense', document.uri).get('codeLens.enabled', false)) || vscode.workspace.getConfiguration('ra2-ini-intellisense').get('codeLens.enabled', false);
		if (isEnabled) {
			if (!codeLensProvider) {
				codeLensProvider = vscode.languages.registerCodeLensProvider(selector, {
					async provideCodeLenses(document, token) {
                        if (!vscode.workspace.getConfiguration('ra2-ini-intellisense', document.uri).get('codeLens.enabled', false)) { return []; }
                        const graph = await indexLogic(inspection.ini, schemaManager, document.uri, token);
						const codeLenses: vscode.CodeLens[] = [];
                        // 使用新 API：直接遍历 Sections
                        const doc = inspection.ini.parse(document);
                        if (!doc) { return []; }

						for (const sec of doc.sections) {
                            const id = inspection.ini.category(document.uri) + ':' + sec.name.toLowerCase();
                            const valueRefs = graph.edges.filter(edge => edge.to === id && edge.kind !== 'inheritance');
                            const inheritanceRefs = graph.edges.filter(edge => edge.to === id && edge.kind === 'inheritance');
                            
                            const range = document.lineAt(sec.startLine).range;
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

			(e.affectsConfiguration('ra2-ini-intellisense.schemaFilePath') ? loadSchemaFromConfiguration() : Promise.resolve()).then(() => {
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
			}).catch(error => {
                console.error('[Extension] Failed to reload schema after configuration change.', error);
            });
		}
	}));
	updateCodeLensProvider();

	const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ini,map,mpr,yrm}');
	context.subscriptions.push(watcher);
	
	const onFileChange = async (uri: vscode.Uri) => {
		// 跳过已由 onDidChangeTextDocument 处理的文件（保存时重复触发）
		// 但仍刷新非活动编辑器的装饰（分屏场景）
		if (iniManager.wasRecentlyUpdated(uri)) {
			overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();
			return;
		}
		console.log(`INI 文件变更: ${uri.fsPath}, 正在增量更新索引...`);
		await iniManager.updateFile(uri);
        // 外部文件变更（非编辑器输入），触发全量刷新
		const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (doc) { diagnosticManager.handleDocumentChange(doc); }
        
        overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();
	};

	const onFileDelete = (uri: vscode.Uri) => {
		console.log(`INI 文件删除: ${uri.fsPath}, 正在移除索引...`);
		iniManager.removeFile(uri);
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
		outputChannel.appendLine(localize('debug.title', '--- RA2 Mod IntelliSense Debug Info ---\n'));

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
		outputChannel.appendLine(localize('debug.context.file', 'File: {0}', document.uri.toString()));
        outputChannel.appendLine(`File Type: ${fileTypeManager.getFileType(document.uri)}`);
		outputChannel.appendLine(localize('debug.context.position', 'Cursor Position: Line {0}, Character {1}\n', position.line + 1, position.character + 1));

		const currentSectionName = inspection.ini.parse(document).getSectionAt(position.line)?.name;

		if (!currentSectionName) {
			outputChannel.appendLine(localize('debug.context.noSection', 'Error: Cursor is not within a valid section.'));
			outputChannel.show();
			return;
		}
		
		outputChannel.appendLine(localize('debug.context.currentSection', '✅ Current Section: [{0}]', currentSectionName));

		const typeName = inspection.ini.type(document.uri, currentSectionName, inspection.ini.category(document.uri));
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
                await inspection.ini.load(document.uri);
                if (token.isCancellationRequested) { return []; }
				const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
				if (!wordRange) { return []; }
				const word = document.getText(wordRange);

                // 优先查找节定义
				const lineInCurrentFile = iniManager.findSectionInContent(document.getText(), word);
				if (lineInCurrentFile !== null) {
					return new vscode.Location(document.uri, new vscode.Position(lineInCurrentFile, 0));
				}
				
				const sectionLocations = inspection.ini.sources(document.uri, word).map(source => new vscode.Location(source.document.uri, new vscode.Position(source.section.startLine, 0)));
				if (sectionLocations.length > 0) {
					return sectionLocations;
				}
				return [];
			}
		}),
		vscode.languages.registerHoverProvider(selector, {
			async provideHover(document, position, token) {
                await inspection.ini.load(document.uri);
                if (token.isCancellationRequested) { return null; }
				const line = document.lineAt(position.line);
				const lineText = line.text;
				const equalsIndex = lineText.indexOf('=');

                // Hover on Section Name
				if (equalsIndex === -1) { 
					const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
					if (!wordRange) {return null;}

					const word = document.getText(wordRange);
                    const secDoc = iniManager.getDocument(document.uri); // 假设同文件
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

				const currentSectionName = inspection.ini.parse(document).getSectionAt(position.line)?.name;
				if (!currentSectionName) {return null;}
		
				const markdown = new vscode.MarkdownString("", true);
				markdown.isTrusted = { enabledCommands: ['ra2-ini-intellisense.jumpToOverride'] };
				markdown.supportThemeIcons = true;
				let hasContent = false;

                const currentFileType = inspection.ini.category(document.uri);
                const typeName = inspection.ini.type(document.uri, currentSectionName, currentFileType);
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

						markdown.appendMarkdown('\n\n---\n\n');
						markdown.appendMarkdown(localize('hover.type.belongsTo', `\n\nBelongs to type **{0}**.`, displayType(typeName)));
						
						let foundDescription: string | undefined; // 改个名避免混淆
						let currentLookupType: string | null = typeName; 
						const visitedTypes = new Set<string>();

						// 逻辑：沿着 Schema 定义的继承链（如 UnitType -> TechnoType）
						// 逐级向 DescriptionManager 查询描述
						while (currentLookupType && !visitedTypes.has(currentLookupType)) {
							visitedTypes.add(currentLookupType);
							foundDescription = descriptionManager.getDescription(currentLookupType, keyPart);
							if (foundDescription) {
								break; // 找到了就退出
							}

							// 没找到，查阅 SchemaManager 获取父类
							const schema = schemaManager.getSchema(currentLookupType);
							currentLookupType = schema?.base ?? null; 
						}

						if (foundDescription) {
							markdown.appendMarkdown('\n\n---\n\n');
							markdown.appendMarkdown(foundDescription);
						}
                        hasContent = true;
					}
				}

				const effective = inspection.ini.explain(document.uri, currentSectionName, currentFileType).get(keyPart.toLowerCase());
                const parent = effective?.declarations.find(item => item.inherited);
                const parentKeyInfo = parent ? { location: new vscode.Location(parent.uri, new vscode.Position(parent.line, 0)), lineText: parent.key + '=' + parent.value, definer: parent.section } : null;
				
				if (parentKeyInfo && parentKeyInfo.location && parentKeyInfo.lineText && parentKeyInfo.definer) {
						if(hasContent) {markdown.appendMarkdown('\n\n---\n\n');}

						const lineNum = parentKeyInfo.location.range.start.line + 1;
						const fileName = path.basename(parentKeyInfo.location.uri.path);

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

				return hasContent ? new vscode.Hover(markdown, keyRange) : null;
			}
		}),
		vscode.languages.registerCompletionItemProvider(selector, {
			async provideCompletionItems(document, position, token, context) {
				await inspection.ini.load(document.uri);
                if (token.isCancellationRequested) { return new vscode.CompletionList([], true); }
				const line = document.lineAt(position.line);
				const equalsIndex = line.text.indexOf('=');
				const isKeyCompletion = equalsIndex === -1 || position.character <= equalsIndex;

				const currentSectionName = inspection.ini.parse(document).getSectionAt(position.line)?.name;
				if (!currentSectionName) {return new vscode.CompletionList([], false);}
		
                const currentFileType = inspection.ini.category(document.uri);
                const typeName = inspection.ini.type(document.uri, currentSectionName, currentFileType);
				if (!typeName) {return new vscode.CompletionList([], false);}

				if (isKeyCompletion) {
					const keys = schemaManager.getAllKeysForType(typeName);
					if (keys.size === 0) {return new vscode.CompletionList([], false);}
			
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
						const targetRegistry = schemaManager.getRegistryForType(inspection.ini.propertyType(typeName, currentKey) ?? valueType);
						if (targetRegistry) {
							const snapshot = inspection.ini.snapshot(document.uri);
                            const ids = registryValues(targetRegistry, name => snapshot.sources(name), parsePropertyLine, snapshot.context.compatibility !== 'vanilla');
							ids.forEach(id => suggestions.push(new vscode.CompletionItem(id, vscode.CompletionItemKind.EnumMember)));
							if (suggestions.length > 0) {return new vscode.CompletionList(suggestions, true);}
						}
					}
					
					const fallbackSuggestions = new Map<string, vscode.CompletionItem>();
					inspection.ini.snapshot(document.uri).names.forEach(name => {
						if (!fallbackSuggestions.has(name)) {
							fallbackSuggestions.set(name, new vscode.CompletionItem(name, vscode.CompletionItemKind.Module));
						}
					});
					if (currentKey) {
						inspection.ini.documents(document.uri).flatMap(model => model.sections.flatMap(section => [...section.properties].filter(([key]) => key.toLowerCase() === currentKey.toLowerCase()).map(([, value]) => value))).forEach(value => {
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
			async provideDocumentColors(document, token) {
                await inspection.ini.load(document.uri);
				const colors: vscode.ColorInformation[] = [];
				for (let i = 0; i < document.lineCount; i++) {
					const line = document.lineAt(i);
					const equalsIndex = line.text.indexOf('=');
					if (equalsIndex === -1) {continue;}

					const currentSectionName = inspection.ini.parse(document).getSectionAt(i)?.name;
					if (!currentSectionName) {continue;}
					
					const currentKey = line.text.substring(0, equalsIndex).trim();
					const typeName = inspection.ini.type(document.uri, currentSectionName, inspection.ini.category(document.uri));

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
							const parsed = parsePropertyLine(line.text);
                            const valuePart = parsed?.value ?? '';
							const rgb = valuePart.match(/^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/);
							if (rgb) {
								const r = parseInt(rgb[1], 10);
								const g = parseInt(rgb[2], 10);
								const b = parseInt(rgb[3], 10);
								if (r <= 255 && g <= 255 && b <= 255) {
									const range = new vscode.Range(i, parsed!.elements[0].start, i, parsed!.elements[0].start + parsed!.value.length);
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
            async provideReferences(document, position, context, token) {
                await inspection.ini.load(document.uri);
                const section = inspection.ini.parse(document).getSectionAt(position.line);
                if (!section) { return []; }
                const graph = await indexLogic(inspection.ini, schemaManager, document.uri, token);
                const id = inspection.ini.category(document.uri) + ':' + section.name.toLowerCase();
                const references = graph.edges.filter(edge => edge.to === id).map(edge => graph.locations.get(edge.id)!).filter(Boolean);
                if (context.includeDeclaration) { const declaration = graph.locations.get(id); if (declaration) { references.unshift(declaration); } }
                return references;
            }
		}),
		vscode.languages.registerFoldingRangeProvider(selector, {
			provideFoldingRanges(document, context, token) {
                // 使用新模型极速生成折叠范围
                const doc = iniManager.getDocument(document.uri);
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
                message = localize('prompt.configureII.message.root', 'Welcome to RA2 Mod IntelliSense! Please set your Mod project root directory to enable all features.');
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

    async function pickCompareSource(title: string): Promise<CompareSource | undefined> {
        const items: Array<vscode.QuickPickItem & { target: 'mix' | 'folder' | 'workspace' }> = [
            {
                label: localize('compare.pick.option.mix', 'MIX Archive or Nested MIX'),
                description: localize('compare.pick.option.mix.description', 'Choose a .mix file from disk'),
                target: 'mix',
            },
            {
                label: localize('compare.pick.option.folder', 'Folder'),
                description: localize('compare.pick.option.folder.description', 'Choose a directory from disk'),
                target: 'folder',
            },
        ];

        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            items.push({
                label: localize('compare.pick.option.workspace', 'Current Workspace Root'),
                description: localize('compare.pick.option.workspace.description', 'Use the active workspace folder'),
                target: 'workspace',
            });
        }

        const selection = await vscode.window.showQuickPick(items, {
            title,
            placeHolder: localize('compare.pick.placeholder', 'Select the kind of source to compare'),
        });

        if (!selection) {
            return undefined;
        }

        if (selection.target === 'mix') {
            const fileUris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: localize('compare.pick.mix.openLabel', 'Select archive file'),
            });
            if (!fileUris?.[0]) {
                return undefined;
            }

            const targetUri = fileUris[0];
            const isMixLike = await mixDetectorService.isMixLike(targetUri);
            if (!isMixLike) {
                vscode.window.showWarningMessage(localize('compare.pick.mix.invalid', 'The selected file is not recognized as a MIX-like archive.'));
                return undefined;
            }

            return createFileMixCompareSource(targetUri);
        }

        if (selection.target === 'folder') {
            const folderUris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: localize('compare.pick.folder.openLabel', 'Select folder'),
            });
            if (!folderUris?.[0]) {
                return undefined;
            }
            return createDirectoryCompareSource(folderUris[0]);
        }

        const rootFolder = vscode.workspace.workspaceFolders?.[0];
        if (!rootFolder) {
            return undefined;
        }
        return createDirectoryCompareSource(rootFolder.uri, rootFolder.name);
    }

    async function createCompareSourceFromNode(node?: ResourceNode): Promise<CompareSource | undefined> {
        if (!node) {
            return undefined;
        }

        if (node.uri.scheme === MixUriCodec.scheme) {
            if (node.kind === 'mixDirectory') {
                return createMixCompareSource(node.uri, node.label, node.uri);
            }

            if (node.kind === 'mixFile') {
                const sourceUri = node.sourceUri ?? node.uri;
                if (sourceUri.scheme === MixUriCodec.scheme) {
                    return createMixCompareSource(node.uri, node.label, node.uri);
                }
                return createFileMixCompareSource(sourceUri);
            }
        }

        if (node.kind === 'directory' || node.kind === 'workspaceRoot') {
            return createDirectoryCompareSource(node.uri, node.label);
        }

        return undefined;
    }

    function createDirectoryCompareSource(uri: vscode.Uri, label?: string): CompareSource {
        return {
            kind: 'directory',
            rootUri: uri,
            openUri: uri,
            label: label ?? (path.basename(uri.fsPath || uri.path) || uri.toString()),
            description: uri.fsPath || uri.path,
        };
    }

    function createFileMixCompareSource(uri: vscode.Uri): CompareSource {
        const rootUri = MixUriCodec.toRootUri(uri);
        return createMixCompareSource(rootUri, path.basename(uri.fsPath || uri.path), uri);
    }

    function createMixCompareSource(rootUri: vscode.Uri, label: string, openUri: vscode.Uri): CompareSource {
        return {
            kind: 'mix',
            rootUri,
            openUri,
            label,
            description: describeCompareUri(openUri),
        };
    }

    function describeCompareUri(uri: vscode.Uri): string {
        if (uri.scheme !== MixUriCodec.scheme) {
            return uri.fsPath || uri.path;
        }

        const decoded = MixUriCodec.decode(uri);
        const chain = decoded.nestedChain.length > 0 ? ` :: ${decoded.nestedChain.join(' / ')}` : '';
        const virtualPath = decoded.virtualPath && decoded.virtualPath !== '/' ? ` :: ${decoded.virtualPath}` : '';
        return `${decoded.containerUri.fsPath || decoded.containerUri.path}${chain}${virtualPath}`;
    }

    async function runComparison(leftSource: CompareSource, rightSource: CompareSource): Promise<void> {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: localize('compare.progress.title', 'Comparing resources...'),
            cancellable: false,
        }, progress => compareService.compare(leftSource, rightSource, progress));

        CompareResultsPanel.show(context.extensionUri, result);
    }
}

	export function deactivate() {
    // 这里的清理工作由 subscriptions 自动处理
}

function resolveMixTargetUri(node?: ResourceNode): vscode.Uri | undefined {
    if (!node) {
        return undefined;
    }

    if (node.sourceUri?.scheme === MixUriCodec.scheme && node.kind === 'mixFile') {
        return node.uri;
    }

    if (node.uri.scheme !== MixUriCodec.scheme) {
        if (node.kind === 'mixFile') {
            return MixUriCodec.toRootUri(node.uri);
        }
        return undefined;
    }

    if (node.kind === 'mixEntryFile') {
        if (node.parentUri) {
            return node.parentUri;
        }
        const parentPath = node.uri.path.substring(0, node.uri.path.lastIndexOf('/')) || '/';
        return MixUriCodec.toChildUri(node.uri, parentPath);
    }

    return node.uri;
}
