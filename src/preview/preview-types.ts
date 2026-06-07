export interface RgbaImagePreview {
    kind: 'rgba-image';
    title: string;
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
    description?: string;
    details?: string[];
    pixelated?: boolean;
}

export interface PalettePreview {
    kind: 'palette';
    title: string;
    colors: string[];
    description?: string;
    details?: string[];
}

export interface HtmlPreview {
    kind: 'html';
    title: string;
    bodyHtml: string;
    details?: string[];
}

export interface TextPreview {
    kind: 'text';
    title: string;
    content: string;
    details?: string[];
}

export type ResourcePreviewModel =
    | RgbaImagePreview
    | PalettePreview
    | HtmlPreview
    | TextPreview;
