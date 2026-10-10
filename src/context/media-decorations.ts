import * as vscode from 'vscode';
import { InspectionService } from './inspection-service';
import { ThumbnailStore } from './thumbnail-store';
import { DecoderService } from '../media/decoder-service';

/** Visible-region only: thumbnails never cause a whole-document render pass. */
export class MediaDecorations implements vscode.Disposable {
    private readonly decoration = vscode.window.createTextEditorDecorationType({
        after: { margin: '0 0 0 1em', width: '28px', height: '20px' },
    });
    private readonly thumbnails: ThumbnailStore;
    private timer?: NodeJS.Timeout;
    private cancellation = new vscode.CancellationTokenSource();
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly service: InspectionService,
        context: vscode.ExtensionContext,
        decoder: DecoderService
    ) {
        this.thumbnails = new ThumbnailStore(context, decoder);
        const schedule = () => this.schedule();
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(schedule),
            vscode.window.onDidChangeTextEditorVisibleRanges(schedule),
            vscode.workspace.onDidChangeTextDocument(schedule),
            service.resources.onDidChange(schedule)
        );
        this.schedule();
    }

    private schedule(): void {
        this.cancellation.cancel();
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            void this.update();
        }, 700);
    }

    private async update(): Promise<void> {
        this.cancellation.dispose();
        this.cancellation = new vscode.CancellationTokenSource();
        const token = this.cancellation.token,
            editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'ra2-ini') {
            return;
        }
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense', editor.document.uri);
        if (!config.get('media.enabled', true) || !config.get('media.inlineThumbnails', true)) {
            editor.setDecorations(this.decoration, []);
            return;
        }
        const version = editor.document.version,
            result: vscode.DecorationOptions[] = [];
        const lines = new Set<number>();
        for (const visible of editor.visibleRanges) {
            for (let line = visible.start.line; line <= visible.end.line && lines.size < 6; line++) {
                if (/^\s*\[|^\s*(Image|Cameo|AltCameo)\s*=/i.test(editor.document.lineAt(line).text)) {
                    lines.add(line);
                }
            }
        }
        for (const line of lines) {
            if (token.isCancellationRequested) {
                return;
            }
            try {
                const text = editor.document.lineAt(line);
                const position = new vscode.Position(line, text.text.includes('=') ? text.text.indexOf('=') + 1 : 0);
                const session = await this.service.inspect(editor.document, position, token);
                const thumbnail = await this.thumbnails.create(
                    session?.inspection.cameo ?? session?.inspection.media,
                    token
                );
                if (thumbnail) {
                    result.push({
                        range: new vscode.Range(text.range.end, text.range.end),
                        renderOptions: { after: { contentIconPath: thumbnail } },
                    });
                }
            } catch {
                /* Decoration failures must not affect text editing. */
            }
        }
        if (!token.isCancellationRequested && editor.document.version === version) {
            editor.setDecorations(this.decoration, result);
        }
    }
    public dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.cancellation.cancel();
        this.cancellation.dispose();
        this.decoration.dispose();
        this.disposables.forEach((item) => item.dispose());
    }
}
