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

export interface VoxelSceneState {
    limbIndex: number;
    sliceIndex: number;
    viewType: 'front' | 'side' | 'top';
    renderMode: 'slice' | 'game' | 'perspective';
    cameraYaw: number;
    cameraPitch: number;
    cameraZoom: number;
    cameraPanX: number;
    cameraPanY: number;
}

export interface VoxelSceneLimb {
    name: string;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    voxels: number[];
}

export interface VoxelSceneData {
    signature: string;
    remapStart: number;
    remapEnd: number;
    palette: number[];
    vplPalette: number[];
    vplLookup: number[];
    gameNormals: number[];
    limbs: VoxelSceneLimb[];
}

export interface VoxelScenePreview {
    kind: 'voxel-scene';
    title: string;
    description?: string;
    details?: string[];
    scene: VoxelSceneData;
    state: VoxelSceneState;
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
    | VoxelScenePreview
    | PalettePreview
    | HtmlPreview
    | TextPreview;
