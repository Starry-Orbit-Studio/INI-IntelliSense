import * as path from 'path';
import * as vscode from 'vscode';
import { MixArchive } from './archive';
import { MixGame } from './types';

interface IdInfo {
    name: string;
    description: string;
}

type IdList = Map<number, IdInfo>;

export class GlobalMixDb {
    private tdRaList: IdList = new Map();
    private tsList: IdList = new Map();
    private ra2List: IdList = new Map();
    private loaded = false;

    constructor(private context: vscode.ExtensionContext) {}

    public async ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return;
        }

        const dbPath = path.join(this.context.extensionPath, 'assets', 'global-mix-database.dat');
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(dbPath));
        let offset = 0;

        offset = this.readList(bytes, offset, MixGame.TdRa);
        offset = this.readList(bytes, offset, MixGame.TdRa);
        offset = this.readList(bytes, offset, MixGame.Ts);
        this.readList(bytes, offset, MixGame.Ra2);
        this.loaded = true;
    }

    public async getFileName(game: MixGame, id: number): Promise<string | undefined> {
        await this.ensureLoaded();
        const list = this.getList(game);
        const match = list.get(id);
        if (match) {
            return match.name;
        }

        if (game === MixGame.Ts) {
            return this.ra2List.get(id)?.name;
        }

        return undefined;
    }

    private readList(bytes: Uint8Array, offset: number, game: MixGame): number {
        const list = this.getList(game);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const count = view.getInt32(offset, true);
        offset += 4;

        const decoder = new TextDecoder('latin1');
        for (let i = 0; i < count; i++) {
            const nameEnd = bytes.indexOf(0, offset);
            const name = decoder.decode(bytes.slice(offset, nameEnd));
            offset = nameEnd + 1;

            const descEnd = bytes.indexOf(0, offset);
            const description = decoder.decode(bytes.slice(offset, descEnd));
            offset = descEnd + 1;

            const id = MixArchive.calculateId(name, game);
            if (!list.has(id)) {
                list.set(id, { name, description });
            }
        }

        return offset;
    }

    private getList(game: MixGame): IdList {
        switch (game) {
            case MixGame.TdRa:
                return this.tdRaList;
            case MixGame.Ts:
                return this.tsList;
            case MixGame.Ra2:
                return this.ra2List;
        }
    }
}
