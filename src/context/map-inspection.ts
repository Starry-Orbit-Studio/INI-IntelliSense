import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { IniDocument } from '../parser';
import { createMapPreview } from '../preview/map-preview';
import { encodePng } from '../media/png';
import { localize } from '../i18n';
import type { InspectionSession } from './inspection-service';

/** Embedded radar imagery is explicitly separate from a fresh engine render. */
export function inspectMap(document: vscode.TextDocument, position: vscode.Position): InspectionSession {
    const parsed = new IniDocument(document.uri, document.getText());
    const preview = createMapPreview(Buffer.from('\uFEFF' + document.getText(), 'utf8'), document.fileName);
    const session: InspectionSession = {
        origin: document.uri,
        position,
        options: {},
        assets: new Map(),
        edits: new Map(),
        links: new Map(),
        inspection: {
            id: randomUUID(),
            owner: document.uri.path.split('/').pop() ?? document.fileName,
            type: 'Map',
            focus: '',
            properties: [],
            assets: [],
            paletteOptions: [],
            references: [],
            sources: [],
            warnings: [],
            map: {
                version: document.version,
                sections: [],
                details: [],
                preview:
                    preview.kind === 'rgba-image'
                        ? Buffer.from(
                              encodePng(
                                  preview.width,
                                  preview.height,
                                  new Uint8Array(
                                      preview.pixels.buffer,
                                      preview.pixels.byteOffset,
                                      preview.pixels.byteLength
                                  )
                              )
                          ).toString('base64')
                        : undefined,
                note:
                    preview.kind === 'text'
                        ? preview.content
                        : localize(
                              'workbench.embeddedMap',
                              'Embedded radar preview; it may not reflect unsaved changes.'
                          ),
            },
        },
    };
    for (const section of parsed.sections) {
        const id = randomUUID();
        session.links.set(id, new vscode.Location(document.uri, new vscode.Position(section.startLine, 0)));
        session.inspection.map!.sections.push({ id, name: section.name, count: section.properties.size });
        if (['map', 'basic', 'lighting'].includes(section.name.toLowerCase())) {
            for (const [key, value] of section.properties) {
                session.inspection.map!.details.push({ key: section.name + '.' + key, value });
            }
        }
    }
    return session;
}
