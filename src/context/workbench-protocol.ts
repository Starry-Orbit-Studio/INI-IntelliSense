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
}
export interface AssetOption {
    id: string;
    name: string;
    source: string;
    priority: number;
    role?: string;
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
    media?: Omit<Extract<MediaPayload, { kind: 'sprite' }>, 'scene'>;
}
export interface SpriteScene {
    kind: 'building' | 'animation';
    layers: SpriteLayer[];
    foundation: number[][];
    trace: string[];
    points?: PointEdit[];
    particles?: { name: string; colors: number[][]; velocity: number[]; cap: number; lifetime: number }[];
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
    properties: PropertyRow[];
    sources: SourceLink[];
    assets: AssetOption[];
    paletteOptions: AssetOption[];
    references: SourceLink[];
    warnings: string[];
    selectedAsset?: string;
    selectedPalette?: string;
    mediaRevision?: number;
    library?: AssetOption[];
    media?: MediaPayload;
    cameo?: MediaPayload;
    cameos?: { tag: string; media: MediaPayload }[];
    lightEdit?: string;
    canReplace?: boolean;
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
