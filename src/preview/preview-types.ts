export interface RgbaImagePreview {
    kind: 'rgba-image';
    title: string;
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
    description?: string;
}

export interface PalettePreview {
    kind: 'palette';
    title: string;
    colors: string[];
    description?: string;
}

export interface HtmlPreview {
    kind: 'html';
    title: string;
    bodyHtml: string;
}

export interface TextPreview {
    kind: 'text';
    title: string;
    content: string;
}

export type ResourcePreviewModel =
    | RgbaImagePreview
    | PalettePreview
    | HtmlPreview
    | TextPreview;
