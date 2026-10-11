import type { ShpFile, SequenceAction } from '../media/shp';
import type { VoxelFile } from '../media/voxel';

export interface SourceLink {
    id: string;
    label: string;
}
export interface PropertyRow {
    key: string;
    value: string;
    inherited: boolean;
    source: SourceLink;
    declarations?: { value: string; source: SourceLink; via: string[]; effective: boolean }[];
    editId?: string;
    editSource?: SourceLink;
    local?: boolean;
    valueType?: string;
    minimum?: number;
    maximum?: number;
    allowedValues?: string[];
}
export interface AssetOption {
    id: string;
    name: string;
    source: string;
    priority: number;
    role?: string;
}
export interface ObjectRow {
    group?: string;
    id: string;
    name: string;
    label: string;
    category: string;
    type: string;
    source: string;
    definitions: number;
    values: Record<string, string>;
}
export interface ActionEdit {
    id: string;
    action: SequenceAction;
    valid: boolean;
    users: number;
}
export interface PointEdit {
    id: string;
    name: string;
    value: number[];
    space?: 'pixel' | 'lepton';
    absent?: boolean;
    deletable?: boolean;
}
export interface SpriteLayer {
    id: string;
    name: string;
    tag: string;
    source: string;
    state:
        | 'normal'
        | 'damaged'
        | 'construction'
        | 'production'
        | 'idle'
        | 'next'
        | 'special'
        | 'super'
        | 'deploying'
        | 'powerup';
    offset: number[];
    z: number;
    start: number;
    end: number;
    damaged?: boolean;
    rate?: number;
    paletteName?: string;
    paletteInherited?: boolean;
    selectedPalette?: string;
    pointName?: string;
    remap?: boolean;
    voxel?: Extract<MediaPayload, { kind: 'voxel' }>;
    media?: Omit<Extract<MediaPayload, { kind: 'sprite' }>, 'scene'>;
}
export interface SpriteScene {
    kind: 'building' | 'animation';
    layers: SpriteLayer[];
    foundation: number[][];
    trace: string[];
    points?: PointEdit[];
}
export type MediaPayload =
    | {
          kind: 'sprite';
          bytes: string;
          file: ShpFile;
          palette: number[];
          paletteName?: string;
          actions: ActionEdit[];
          shadow: boolean;
          remap?: boolean;
          name: string;
          scene?: SpriteScene;
      }
    | { kind: 'image'; width: number; height: number; pixels: string; name: string }
    | {
          kind: 'voxel';
          model: VoxelFile;
          palette: number[];
          paletteName?: string;
          vpl: number[];
          normals: number[];
          light: number[];
          fixed: boolean;
          fireAngle?: number;
          points: PointEdit[];
          name: string;
      }
    | {
          kind: 'audio';
          bytes: string;
          duration: number;
          rate: number;
          channels: number;
          name: string;
          volume: number;
          loop: boolean;
      }
    | { kind: 'palette'; colors: number[]; name: string };

export interface Inspection {
    id: string;
    owner: string;
    type: string;
    focus: string;
    focusType?: string;
    properties: PropertyRow[];
    sources: SourceLink[];
    assets: AssetOption[];
    paletteOptions: AssetOption[];
    references: SourceLink[];
    warnings: string[];
    selectedAsset?: string;
    selectedPalette?: string;
    mediaRevision?: number;
    theater?: string;
    library?: AssetOption[];
    media?: MediaPayload;
    cameo?: MediaPayload;
    cameos?: { tag: string; media: MediaPayload }[];
    lightEdit?: string;
    canReplace?: boolean;
    resolution?: { configured: boolean; complete: boolean; documents: number; entries: string[]; issues: string[] };
    objects?: ObjectRow[];
    objectColumns?: string[];
    catalogScope?: string;
    favoriteObjects?: string[];
    project?: {
        root: string;
        files: number;
        archives: { source: string; entries: number }[];
        counts: Record<string, number>;
        settings: { key: string; value: string }[];
        documents: SourceLink[];
        errors: string[];
    };
    map?: {
        version: number;
        sections: { id: string; name: string; count: number }[];
        details: { key: string; value: string }[];
        preview?: string;
        note: string;
        rendered?: boolean;
    };
}

export interface WorkbenchLabels {
    [key: string]: string;
}
export interface HostState {
    type: 'state';
    labels: WorkbenchLabels;
    inspection?: Inspection;
    loading: boolean;
    pinned: boolean;
    error?: string;
}
