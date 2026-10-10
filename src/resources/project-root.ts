import * as vscode from 'vscode';
import * as path from 'path';
import { MixUriCodec } from '../mix/fs/mix-uri-codec';

/** URI-aware containment; Windows drive paths are case insensitive. */
export function isWithinRoot(root: vscode.Uri, uri: vscode.Uri): boolean {
    if (root.scheme !== uri.scheme || root.authority.toLowerCase() !== uri.authority.toLowerCase()) {
        return false;
    }
    const normalize = (value: string) =>
        uri.scheme === 'file' && /^\/[a-z]:/i.test(uri.path) ? value.toLowerCase() : value;
    const relative = path.posix.relative(normalize(root.path), normalize(uri.path));
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

/** Resolve split Rules/Resources layouts even when only a child folder is open. */
export function resolveProjectRoot(uri: vscode.Uri, folder?: vscode.Uri, configured?: vscode.Uri): vscode.Uri {
    const physical = uri.scheme === MixUriCodec.scheme ? MixUriCodec.decode(uri).containerUri : uri;
    if (configured && isWithinRoot(configured, physical)) {
        return configured;
    }
    const directory = folder?.toString() === physical.toString() ? physical.path : path.posix.dirname(physical.path);
    const components = directory.split('/');
    for (let index = components.length - 1; index > 0; index--) {
        if (/^(Rules|Resources)$/i.test(components[index])) {
            return physical.with({ path: components.slice(0, index).join('/') || '/', query: '', fragment: '' });
        }
    }
    return folder ?? physical.with({ path: directory, query: '', fragment: '' });
}
