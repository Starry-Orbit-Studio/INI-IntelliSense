import * as vscode from 'vscode';
import { InspectionService } from './inspection-service';
import { parsePropertyLine, valueAtCharacter, soundValueAtCharacter } from './ini-position';
import { ThumbnailStore } from './thumbnail-store';
import { DecoderService } from '../media/decoder-service';
import { localize } from '../i18n';

export class MediaHoverProvider implements vscode.HoverProvider {
    private readonly thumbnails: ThumbnailStore;
    constructor(
        private readonly service: InspectionService,
        context: vscode.ExtensionContext,
        decoder: DecoderService
    ) {
        this.thumbnails = new ThumbnailStore(context, decoder);
    }
    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const line = document.lineAt(position.line).text;
        const property = parsePropertyLine(line);
        const element =
            property &&
            (this.service.ini.category(document.uri) === 'sound' && property.key.toLowerCase() === 'sounds'
                ? soundValueAtCharacter(line, property, position.character)
                : valueAtCharacter(property, position.character));
        if (property && !element) {
            return undefined;
        }
        if (!property && !/^\s*\[/.test(line)) {
            return undefined;
        }
        if (!vscode.workspace.getConfiguration('ra2-ini-intellisense', document.uri).get('media.enabled', true)) {
            return undefined;
        }
        if (!vscode.workspace.getConfiguration('ra2-ini-intellisense', document.uri).get('media.hoverEnabled', true)) {
            return undefined;
        }
        try {
            const session = await this.service.inspect(document, position, token);
            if (!session || token.isCancellationRequested) {
                return undefined;
            }
            const inspection = session.inspection;
            if (!inspection.media && !inspection.assets.length) {
                return undefined;
            }
            const markdown = new vscode.MarkdownString('', true);
            markdown.isTrusted = { enabledCommands: ['ra2-ini-intellisense.inspect'] };
            markdown.appendText(inspection.focus + ' · ' + inspection.type);
            const thumbnail = await this.thumbnails.create(inspection.media ?? inspection.cameo, token);
            if (thumbnail) {
                markdown.appendMarkdown('\n\n![](' + thumbnail.toString() + ')');
            }
            if (inspection.media?.kind === 'audio') {
                markdown.appendText(
                    '\n\n' + localize('workbench.sampleCount', '{0} available samples', inspection.assets.length)
                );
            }
            if (inspection.assets[0]) {
                markdown.appendText('\n\n' + inspection.assets[0].source);
            }
            const args = encodeURIComponent(
                JSON.stringify([document.uri.toString(), position.line, position.character])
            );
            markdown.appendMarkdown(
                '\n\n[' +
                    localize('workbench.open', 'Open inspector / audition') +
                    '](command:ra2-ini-intellisense.inspect?' +
                    args +
                    ')'
            );
            return new vscode.Hover(
                markdown,
                element
                    ? new vscode.Range(position.line, element.start, position.line, element.end)
                    : document.lineAt(position.line).range
            );
        } catch (error) {
            if (!token.isCancellationRequested) {
                console.debug('[MediaHover] Preview unavailable', error);
            }
            return undefined;
        }
    }
}
