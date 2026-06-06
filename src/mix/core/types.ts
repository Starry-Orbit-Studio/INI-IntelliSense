export enum MixType {
    Unknown = 'unknown',
    Td = 'td',
    RaTs = 'ra-ts',
    RaTsEncrypted = 'ra-ts-encrypted',
}

export enum MixGame {
    TdRa = 'td-ra',
    Ts = 'ts',
    Ra2 = 'ra2',
}

export interface MixEntry {
    id: number;
    fileName: string;
    size: number;
    offset: number;
    type: string;
    path: string;
}

export interface MixDirectoryEntry {
    name: string;
    path: string;
}

export interface MixTreeEntry {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size: number;
}

export interface MixArchiveOptions {
    sourceLabel?: string;
}

export interface MixArchiveWarning {
    message: string;
}

export interface MixStat {
    type: 'file' | 'directory';
    ctime: number;
    mtime: number;
    size: number;
}

export interface MixAddress {
    containerUri: string;
    nestedChain: string[];
    virtualPath: string;
}
