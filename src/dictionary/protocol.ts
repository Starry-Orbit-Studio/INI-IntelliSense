export type DictionaryKind = 'object' | 'number' | 'limit' | 'list' | 'registry';
export interface DictionaryType { name: string; base?: string; kind: DictionaryKind; count: number }
export interface DictionaryProperty {
    key: string; type: string; defaultValue?: string; fileType?: string;
    owner: string; path: string; line: number; inherited: boolean; local: boolean;
}
export interface DictionaryDetail {
    name: string; kind: DictionaryKind; base?: string; fields: Record<string, string>;
    properties: DictionaryProperty[];
}
export interface DictionaryState {
    revision: string; path: string; dirty: boolean; protected: boolean; types: DictionaryType[];
    valueTypes: string[]; issues: { path: string; line: number; message: string }[];
    search: { section: string; key: string; text: string }[];
    detail?: DictionaryDetail; error?: string; labels: Record<string, string>;
}
export interface DictionaryDraft {
    section: string; kind: DictionaryKind; key?: string; valueType?: string; defaultValue?: string;
    fileType?: string; fields?: Record<string, string>; base?: string;
    descriptions?: Record<string, string>; remove?: boolean;
}
