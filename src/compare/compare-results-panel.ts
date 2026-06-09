import * as vscode from 'vscode';
import { localize } from '../i18n';
import { ResourcePreviewProvider } from '../preview/resource-preview-provider';
import { CompareItem, CompareResult } from './types';

interface ComparePanelItem {
    key: string;
    relativePath: string;
    entryType: string;
    status: string;
    reason: string;
    leftUri?: string;
    rightUri?: string;
    leftSize?: number;
    rightSize?: number;
    canTextDiff: boolean;
}

interface ComparePanelModel {
    title: string;
    leftLabel: string;
    leftDescription: string;
    leftOpenUri: string;
    rightLabel: string;
    rightDescription: string;
    rightOpenUri: string;
    generatedAt: string;
    summary: CompareResult['summary'];
    items: ComparePanelItem[];
    strings: Record<string, string>;
}

export class CompareResultsPanel {
    private static currentPanel: CompareResultsPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private result: CompareResult;

    private constructor(panel: vscode.WebviewPanel, result: CompareResult) {
        this.panel = panel;
        this.result = result;

        this.panel.webview.options = {
            enableScripts: true,
        };

        this.panel.onDidDispose(() => {
            if (CompareResultsPanel.currentPanel === this) {
                CompareResultsPanel.currentPanel = undefined;
            }
        });

        this.panel.webview.onDidReceiveMessage(async message => {
            await this.handleMessage(message);
        });

        this.render();
    }

    public static show(extensionUri: vscode.Uri, result: CompareResult): void {
        if (CompareResultsPanel.currentPanel) {
            CompareResultsPanel.currentPanel.result = result;
            CompareResultsPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active, true);
            CompareResultsPanel.currentPanel.render();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ra2-compare-results',
            localize('compare.panel.title', 'Resource Compare'),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        CompareResultsPanel.currentPanel = new CompareResultsPanel(panel, result);
    }

    private render(): void {
        this.panel.title = `${localize('compare.panel.title', 'Resource Compare')}: ${this.result.left.label} vs ${this.result.right.label}`;
        this.panel.webview.html = this.renderHtml(this.toModel(this.result));
    }

    private toModel(result: CompareResult): ComparePanelModel {
        return {
            title: `${result.left.label} vs ${result.right.label}`,
            leftLabel: result.left.label,
            leftDescription: result.left.description,
            leftOpenUri: result.left.openUri.toString(),
            rightLabel: result.right.label,
            rightDescription: result.right.description,
            rightOpenUri: result.right.openUri.toString(),
            generatedAt: result.generatedAt,
            summary: result.summary,
            items: result.items.map(item => this.toPanelItem(item)),
            strings: {
                searchPlaceholder: localize('compare.panel.search.placeholder', 'Search paths...'),
                filterAll: localize('compare.panel.filter.all', 'All'),
                filterChanges: localize('compare.panel.filter.changes', 'Changed'),
                filterLeftOnly: localize('compare.panel.filter.leftOnly', 'Left Only'),
                filterRightOnly: localize('compare.panel.filter.rightOnly', 'Right Only'),
                filterIdentical: localize('compare.panel.filter.identical', 'Identical'),
                filterTypeMismatch: localize('compare.panel.filter.typeMismatch', 'Type Mismatch'),
                empty: localize('compare.panel.empty', 'No comparison entries match the current filter.'),
                openLeft: localize('compare.panel.action.openLeft', 'Open Left'),
                openRight: localize('compare.panel.action.openRight', 'Open Right'),
                textDiff: localize('compare.panel.action.textDiff', 'Text Diff'),
                openSource: localize('compare.panel.action.openSource', 'Open Source'),
                summaryLeftOnly: localize('compare.panel.summary.leftOnly', 'Only in left'),
                summaryRightOnly: localize('compare.panel.summary.rightOnly', 'Only in right'),
                summaryDifferent: localize('compare.panel.summary.different', 'Different'),
                summaryIdentical: localize('compare.panel.summary.identical', 'Identical'),
                summaryTypeMismatch: localize('compare.panel.summary.typeMismatch', 'Type mismatch'),
                statusLeftOnly: localize('compare.panel.status.leftOnly', 'Only in left'),
                statusRightOnly: localize('compare.panel.status.rightOnly', 'Only in right'),
                statusDifferent: localize('compare.panel.status.different', 'Different'),
                statusIdentical: localize('compare.panel.status.identical', 'Identical'),
                statusTypeMismatch: localize('compare.panel.status.typeMismatch', 'Type mismatch'),
                entryFile: localize('compare.panel.entry.file', 'File'),
                entryDirectory: localize('compare.panel.entry.directory', 'Directory'),
                countLabel: localize('compare.panel.countLabel', '{0} entries'),
                leftSize: localize('compare.panel.size.left', 'Left size'),
                rightSize: localize('compare.panel.size.right', 'Right size'),
                generatedAt: localize('compare.panel.generatedAt', 'Generated'),
            },
        };
    }

    private toPanelItem(item: CompareItem): ComparePanelItem {
        return {
            key: item.key,
            relativePath: item.relativePath,
            entryType: item.entryType,
            status: item.status,
            reason: item.reason,
            leftUri: item.left?.uri.toString(),
            rightUri: item.right?.uri.toString(),
            leftSize: item.left?.size,
            rightSize: item.right?.size,
            canTextDiff: item.entryType === 'file'
                && !!item.left?.uri
                && !!item.right?.uri
                && !!item.left?.likelyText
                && !!item.right?.likelyText,
        };
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') {
            return;
        }

        const payload = message as Record<string, unknown>;
        const type = typeof payload.type === 'string' ? payload.type : '';

        switch (type) {
            case 'openLeft':
                await this.openUri(payload.uri);
                return;
            case 'openRight':
                await this.openUri(payload.uri);
                return;
            case 'openLeftSource':
                await this.openUri(this.result.left.openUri.toString());
                return;
            case 'openRightSource':
                await this.openUri(this.result.right.openUri.toString());
                return;
            case 'diffText':
                await this.openTextDiff(payload.leftUri, payload.rightUri, payload.relativePath);
                return;
            default:
                return;
        }
    }

    private async openUri(value: unknown): Promise<void> {
        if (typeof value !== 'string' || value.length === 0) {
            return;
        }

        const uri = vscode.Uri.parse(value);
        if (isPreviewablePath(uri.path)) {
            await vscode.commands.executeCommand('vscode.openWith', uri, ResourcePreviewProvider.viewType);
            return;
        }

        await vscode.commands.executeCommand('vscode.open', uri);
    }

    private async openTextDiff(leftValue: unknown, rightValue: unknown, pathValue: unknown): Promise<void> {
        if (typeof leftValue !== 'string' || typeof rightValue !== 'string') {
            return;
        }

        const leftUri = vscode.Uri.parse(leftValue);
        const rightUri = vscode.Uri.parse(rightValue);
        const relativePath = typeof pathValue === 'string' ? pathValue : '';
        const title = localize('compare.diff.title', '{0}: Left vs Right', relativePath || localize('compare.panel.title', 'Resource Compare'));
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }

    private renderHtml(model: ComparePanelModel): string {
        const state = JSON.stringify(model);
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        :root {
            color-scheme: light dark;
            --bg: var(--vscode-editor-background);
            --panel: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
            --panel-strong: color-mix(in srgb, var(--vscode-editorWidget-background) 98%, var(--vscode-editor-background));
            --border: var(--vscode-panel-border);
            --text: var(--vscode-editor-foreground);
            --muted: var(--vscode-descriptionForeground);
            --accent: var(--vscode-button-background);
            --accent-text: var(--vscode-button-foreground);
            --badge: var(--vscode-badge-background);
            --badge-text: var(--vscode-badge-foreground);
            --ok: #3fb950;
            --warn: #d29922;
            --danger: #f85149;
            --shadow: 0 20px 50px rgba(0, 0, 0, 0.18);
        }

        * { box-sizing: border-box; }

        body {
            margin: 0;
            font-family: var(--vscode-font-family);
            color: var(--text);
            background:
                radial-gradient(circle at top left, rgba(74, 144, 226, 0.12), transparent 28%),
                radial-gradient(circle at top right, rgba(255, 196, 0, 0.10), transparent 24%),
                linear-gradient(180deg, color-mix(in srgb, var(--bg) 88%, #000 12%), var(--bg));
            min-height: 100vh;
        }

        .shell {
            max-width: 1360px;
            margin: 0 auto;
            padding: 24px;
            display: grid;
            gap: 18px;
        }

        .hero {
            display: grid;
            gap: 16px;
            padding: 22px;
            border: 1px solid var(--border);
            border-radius: 22px;
            background: linear-gradient(140deg, color-mix(in srgb, var(--panel) 94%, transparent), color-mix(in srgb, var(--panel-strong) 88%, transparent));
            box-shadow: var(--shadow);
            backdrop-filter: blur(10px);
        }

        .hero-top {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: flex-start;
            flex-wrap: wrap;
        }

        .eyebrow {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            color: var(--muted);
            margin-bottom: 6px;
        }

        h1 {
            margin: 0;
            font-size: 28px;
            line-height: 1.15;
        }

        .hero-meta {
            color: var(--muted);
            font-size: 12px;
        }

        .sources {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 14px;
        }

        .source-card,
        .summary-card,
        .controls,
        .list {
            border: 1px solid var(--border);
            border-radius: 18px;
            background: color-mix(in srgb, var(--panel-strong) 92%, transparent);
        }

        .source-card {
            padding: 18px;
            display: grid;
            gap: 10px;
        }

        .source-card strong {
            font-size: 18px;
        }

        .source-card .desc {
            color: var(--muted);
            font-size: 12px;
            word-break: break-word;
        }

        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 12px;
        }

        .summary-card {
            padding: 16px;
            display: grid;
            gap: 8px;
        }

        .summary-label {
            color: var(--muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .summary-value {
            font-size: 30px;
            font-weight: 700;
            line-height: 1;
        }

        .summary-card[data-tone="left-only"] .summary-value { color: var(--warn); }
        .summary-card[data-tone="right-only"] .summary-value { color: #7cc3ff; }
        .summary-card[data-tone="different"] .summary-value { color: var(--danger); }
        .summary-card[data-tone="identical"] .summary-value { color: var(--ok); }
        .summary-card[data-tone="type-mismatch"] .summary-value { color: #c586c0; }

        .controls {
            padding: 16px;
            display: grid;
            gap: 12px;
        }

        .controls-row {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            align-items: center;
        }

        input[type="search"] {
            flex: 1 1 260px;
            min-width: 220px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--border));
            border-radius: 10px;
            padding: 10px 12px;
            font: inherit;
        }

        .chip,
        button {
            border: 1px solid var(--vscode-button-border, var(--border));
            border-radius: 999px;
            background: color-mix(in srgb, var(--panel-strong) 90%, transparent);
            color: var(--text);
            padding: 8px 12px;
            cursor: pointer;
            font: inherit;
            transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
        }

        button.primary {
            background: var(--accent);
            color: var(--accent-text);
            border-color: transparent;
        }

        .chip:hover,
        button:hover {
            transform: translateY(-1px);
        }

        .chip.active {
            background: color-mix(in srgb, var(--accent) 24%, var(--panel-strong));
            border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
        }

        .list {
            overflow: hidden;
        }

        .list-header,
        .row {
            display: grid;
            grid-template-columns: minmax(280px, 2.2fr) minmax(140px, 0.8fr) minmax(200px, 1.2fr) auto;
            gap: 14px;
            align-items: center;
        }

        .list-header {
            padding: 14px 18px;
            color: var(--muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            border-bottom: 1px solid var(--border);
        }

        .rows {
            display: grid;
        }

        .row {
            padding: 16px 18px;
            border-top: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
        }

        .row:first-child {
            border-top: 0;
        }

        .row:hover {
            background: color-mix(in srgb, var(--panel) 88%, transparent);
        }

        .path-cell {
            display: grid;
            gap: 6px;
            min-width: 0;
        }

        .path-value {
            font-weight: 600;
            word-break: break-word;
        }

        .path-reason {
            font-size: 12px;
            color: var(--muted);
        }

        .badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 4px 10px;
            border-radius: 999px;
            background: var(--badge);
            color: var(--badge-text);
            font-size: 12px;
            white-space: nowrap;
        }

        .badge.status-left-only { background: rgba(210, 153, 34, 0.18); color: #ffcd71; }
        .badge.status-right-only { background: rgba(124, 195, 255, 0.18); color: #9ed6ff; }
        .badge.status-different { background: rgba(248, 81, 73, 0.18); color: #ff9b95; }
        .badge.status-identical { background: rgba(63, 185, 80, 0.18); color: #8de39b; }
        .badge.status-type-mismatch { background: rgba(197, 134, 192, 0.18); color: #d9a3e4; }

        .size-cell {
            display: grid;
            gap: 6px;
            color: var(--muted);
            font-size: 12px;
        }

        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            justify-content: flex-end;
        }

        .empty {
            padding: 30px 18px;
            text-align: center;
            color: var(--muted);
            font-size: 14px;
        }

        @media (max-width: 980px) {
            .list-header {
                display: none;
            }

            .row {
                grid-template-columns: 1fr;
            }

            .actions {
                justify-content: flex-start;
            }
        }
    </style>
</head>
<body>
    <div class="shell">
        <section class="hero">
            <div class="hero-top">
                <div>
                    <div class="eyebrow">${escapeHtml(localize('compare.panel.title', 'Resource Compare'))}</div>
                    <h1>${escapeHtml(model.title)}</h1>
                </div>
                <div class="hero-meta">${escapeHtml(model.strings.generatedAt)}: ${escapeHtml(formatGeneratedAt(model.generatedAt))}</div>
            </div>
            <div class="sources">
                <article class="source-card">
                    <div class="eyebrow">Left</div>
                    <strong>${escapeHtml(model.leftLabel)}</strong>
                    <div class="desc">${escapeHtml(model.leftDescription)}</div>
                    <div><button class="primary" data-action="openLeftSource">${escapeHtml(model.strings.openSource)}</button></div>
                </article>
                <article class="source-card">
                    <div class="eyebrow">Right</div>
                    <strong>${escapeHtml(model.rightLabel)}</strong>
                    <div class="desc">${escapeHtml(model.rightDescription)}</div>
                    <div><button class="primary" data-action="openRightSource">${escapeHtml(model.strings.openSource)}</button></div>
                </article>
            </div>
        </section>

        <section class="summary">
            <article class="summary-card" data-tone="left-only">
                <div class="summary-label">${escapeHtml(model.strings.summaryLeftOnly)}</div>
                <div class="summary-value">${model.summary.leftOnly}</div>
            </article>
            <article class="summary-card" data-tone="right-only">
                <div class="summary-label">${escapeHtml(model.strings.summaryRightOnly)}</div>
                <div class="summary-value">${model.summary.rightOnly}</div>
            </article>
            <article class="summary-card" data-tone="different">
                <div class="summary-label">${escapeHtml(model.strings.summaryDifferent)}</div>
                <div class="summary-value">${model.summary.different}</div>
            </article>
            <article class="summary-card" data-tone="identical">
                <div class="summary-label">${escapeHtml(model.strings.summaryIdentical)}</div>
                <div class="summary-value">${model.summary.identical}</div>
            </article>
            <article class="summary-card" data-tone="type-mismatch">
                <div class="summary-label">${escapeHtml(model.strings.summaryTypeMismatch)}</div>
                <div class="summary-value">${model.summary.typeMismatch}</div>
            </article>
        </section>

        <section class="controls">
            <div class="controls-row">
                <input id="search" type="search" placeholder="${escapeHtml(model.strings.searchPlaceholder)}" />
                <span id="count" class="badge"></span>
            </div>
            <div class="controls-row" id="filters"></div>
        </section>

        <section class="list">
            <div class="list-header">
                <div>Path</div>
                <div>Status</div>
                <div>Details</div>
                <div>Actions</div>
            </div>
            <div id="rows" class="rows"></div>
            <div id="empty" class="empty" hidden>${escapeHtml(model.strings.empty)}</div>
        </section>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const model = ${state};
        const filters = [
            { id: 'all', label: model.strings.filterAll },
            { id: 'changes', label: model.strings.filterChanges },
            { id: 'left-only', label: model.strings.filterLeftOnly },
            { id: 'right-only', label: model.strings.filterRightOnly },
            { id: 'different', label: model.strings.filterChanges },
            { id: 'type-mismatch', label: model.strings.filterTypeMismatch },
            { id: 'identical', label: model.strings.filterIdentical },
        ];

        const searchInput = document.getElementById('search');
        const filtersHost = document.getElementById('filters');
        const rowsHost = document.getElementById('rows');
        const emptyHost = document.getElementById('empty');
        const countHost = document.getElementById('count');

        let activeFilter = 'changes';
        let query = '';

        for (const filter of filters) {
            const button = document.createElement('button');
            button.className = 'chip';
            button.textContent = filter.label;
            button.dataset.filter = filter.id;
            button.addEventListener('click', () => {
                activeFilter = filter.id;
                render();
            });
            filtersHost.appendChild(button);
        }

        searchInput.addEventListener('input', () => {
            query = searchInput.value.trim().toLowerCase();
            render();
        });

        function matchesFilter(item) {
            if (activeFilter === 'all') {
                return true;
            }
            if (activeFilter === 'changes') {
                return item.status === 'different' || item.status === 'left-only' || item.status === 'right-only' || item.status === 'type-mismatch';
            }
            return item.status === activeFilter;
        }

        function getStatusLabel(status) {
            switch (status) {
                case 'left-only': return model.strings.statusLeftOnly;
                case 'right-only': return model.strings.statusRightOnly;
                case 'different': return model.strings.statusDifferent;
                case 'identical': return model.strings.statusIdentical;
                case 'type-mismatch': return model.strings.statusTypeMismatch;
                default: return status;
            }
        }

        function render() {
            rowsHost.innerHTML = '';
            const visible = model.items.filter(item => matchesFilter(item) && (!query || item.relativePath.toLowerCase().includes(query)));

            for (const button of filtersHost.querySelectorAll('[data-filter]')) {
                button.classList.toggle('active', button.dataset.filter === activeFilter);
            }

            countHost.textContent = model.strings.countLabel.replace('{0}', String(visible.length));
            emptyHost.hidden = visible.length !== 0;

            for (const item of visible) {
                const row = document.createElement('div');
                row.className = 'row';
                row.innerHTML = createRowHtml(item);
                wireActions(row, item);
                rowsHost.appendChild(row);
            }
        }

        function createRowHtml(item) {
            const typeLabel = item.entryType === 'directory' ? model.strings.entryDirectory : model.strings.entryFile;
            const leftSize = typeof item.leftSize === 'number' ? formatSize(item.leftSize) : '-';
            const rightSize = typeof item.rightSize === 'number' ? formatSize(item.rightSize) : '-';

            return \`
                <div class="path-cell">
                    <div class="path-value">\${escapeHtml(item.relativePath)}</div>
                    <div class="path-reason">\${escapeHtml(typeLabel)} · \${escapeHtml(item.reason)}</div>
                </div>
                <div><span class="badge status-\${item.status}">\${escapeHtml(getStatusLabel(item.status))}</span></div>
                <div class="size-cell">
                    <span>\${escapeHtml(model.strings.leftSize)}: \${escapeHtml(leftSize)}</span>
                    <span>\${escapeHtml(model.strings.rightSize)}: \${escapeHtml(rightSize)}</span>
                </div>
                <div class="actions">
                    \${item.leftUri ? \`<button data-action="openLeft">\${escapeHtml(model.strings.openLeft)}</button>\` : ''}
                    \${item.rightUri ? \`<button data-action="openRight">\${escapeHtml(model.strings.openRight)}</button>\` : ''}
                    \${item.canTextDiff ? \`<button class="primary" data-action="diffText">\${escapeHtml(model.strings.textDiff)}</button>\` : ''}
                </div>
            \`;
        }

        function wireActions(row, item) {
            for (const button of row.querySelectorAll('[data-action]')) {
                button.addEventListener('click', () => {
                    const action = button.dataset.action;
                    if (action === 'openLeft') {
                        vscode.postMessage({ type: 'openLeft', uri: item.leftUri });
                    } else if (action === 'openRight') {
                        vscode.postMessage({ type: 'openRight', uri: item.rightUri });
                    } else if (action === 'diffText') {
                        vscode.postMessage({
                            type: 'diffText',
                            leftUri: item.leftUri,
                            rightUri: item.rightUri,
                            relativePath: item.relativePath,
                        });
                    }
                });
            }
        }

        document.querySelector('[data-action="openLeftSource"]').addEventListener('click', () => {
            vscode.postMessage({ type: 'openLeftSource' });
        });
        document.querySelector('[data-action="openRightSource"]').addEventListener('click', () => {
            vscode.postMessage({ type: 'openRightSource' });
        });

        render();

        function formatSize(size) {
            if (size < 1024) {
                return \`\${size} B\`;
            }
            if (size < 1024 * 1024) {
                return \`\${(size / 1024).toFixed(1)} KB\`;
            }
            return \`\${(size / (1024 * 1024)).toFixed(1)} MB\`;
        }

        function escapeHtml(value) {
            return String(value)
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;');
        }
    </script>
</body>
</html>`;
    }
}

function formatGeneratedAt(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleString();
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function isPreviewablePath(pathValue: string): boolean {
    const lower = pathValue.toLowerCase();
    return lower.endsWith('.pcx')
        || lower.endsWith('.shp')
        || lower.endsWith('.pal')
        || lower.endsWith('.map')
        || lower.endsWith('.mpr')
        || lower.endsWith('.yrm')
        || lower.endsWith('.vxl')
        || lower.endsWith('.hva');
}
