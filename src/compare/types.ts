import * as vscode from 'vscode';

export type CompareSourceKind = 'directory' | 'mix';

export interface CompareSource {
    kind: CompareSourceKind;
    rootUri: vscode.Uri;
    openUri: vscode.Uri;
    label: string;
    description: string;
}

export type CompareEntryType = 'file' | 'directory';

export type CompareItemStatus =
    | 'left-only'
    | 'right-only'
    | 'different'
    | 'identical'
    | 'type-mismatch';

export interface CompareEntryDetails {
    uri: vscode.Uri;
    size: number;
    entryType: CompareEntryType;
    likelyText?: boolean;
}

export interface CompareItem {
    key: string;
    relativePath: string;
    entryType: CompareEntryType;
    status: CompareItemStatus;
    reason: string;
    left?: CompareEntryDetails;
    right?: CompareEntryDetails;
}

export interface CompareSummary {
    leftFiles: number;
    leftDirectories: number;
    rightFiles: number;
    rightDirectories: number;
    leftOnly: number;
    rightOnly: number;
    different: number;
    identical: number;
    typeMismatch: number;
    totalItems: number;
}

export interface CompareResult {
    left: CompareSource;
    right: CompareSource;
    summary: CompareSummary;
    items: CompareItem[];
    generatedAt: string;
}
