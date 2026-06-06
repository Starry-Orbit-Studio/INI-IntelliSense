import * as vscode from 'vscode';

export type ResourceNodeKind =
    | 'workspaceRoot'
    | 'directory'
    | 'iniFile'
    | 'mixFile'
    | 'mixDirectory'
    | 'mixEntryFile'
    | 'unknownFile';

export interface ResourceNode {
    kind: ResourceNodeKind;
    uri: vscode.Uri;
    sourceUri?: vscode.Uri;
    label: string;
    description?: string;
    contextValue: string;
    parentUri?: vscode.Uri;
    mixContainer?: boolean;
}
