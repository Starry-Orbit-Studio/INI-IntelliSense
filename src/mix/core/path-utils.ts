import * as path from 'path';

export function normalizeMixPath(input: string): string {
    if (!input || input === '.') {
        return '/';
    }

    const normalized = input.replace(/\\/g, '/');
    const trimmed = normalized.startsWith('/') ? normalized : `/${normalized}`;
    const collapsed = trimmed.replace(/\/+/g, '/');
    if (collapsed === '/') {
        return '/';
    }
    return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

export function getParentMixPath(input: string): string {
    const normalized = normalizeMixPath(input);
    if (normalized === '/') {
        return '/';
    }

    const dirName = path.posix.dirname(normalized);
    return normalizeMixPath(dirName);
}

export function joinMixPath(dir: string, name: string): string {
    const normalizedDir = normalizeMixPath(dir);
    if (normalizedDir === '/') {
        return normalizeMixPath(`/${name}`);
    }
    return normalizeMixPath(path.posix.join(normalizedDir, name));
}

export function splitMixVirtualPath(virtualPath: string): { dir: string; name: string } {
    const normalized = normalizeMixPath(virtualPath);
    if (normalized === '/') {
        return { dir: '/', name: '' };
    }

    return {
        dir: getParentMixPath(normalized),
        name: path.posix.basename(normalized),
    };
}
