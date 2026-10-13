import { projectView } from './project-view';
import { analysisView } from './analysis-view';
import { displayType } from '../../src/type-display';
import './main.css';
import type { HostState, Inspection, MediaPayload, WorkbenchLabels } from '../../src/context/workbench-protocol';
import { Renderer, ViewSettings, imageRenderer, spriteRenderer, voxelRenderer, fromBase64 } from './renderer';
import { sceneRenderer } from './scene-renderer';
import { DEFAULT_VOXEL_LIGHT } from '../../src/media/voxel-light';
import { DEFAULT_HOUSE_COLOR } from '../../src/media/render-defaults';
import { spriteClip } from '../../src/media/sprite-playback';
import { mediaCapabilities, mediaUsesRemap } from '../../src/media/media-capabilities';
import { renderProperties } from './property-editor';
import { objectBrowser, CatalogPreferences } from './object-browser';
import { PreviewEnvironment, BackgroundMode } from './environment';
import { mapView } from './map-view';
import { stringTableView } from './string-table-view';

declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};
const api = acquireVsCodeApi();
const script = document.currentScript as HTMLScriptElement;
const workerSource = script.dataset.worker!;
let workerUrl = '';
const app = document.getElementById('app')!;
let labels: WorkbenchLabels = {};
let current: Inspection | undefined;
let renderer: Renderer | undefined, comparisonRenderer: Renderer | undefined;
let comparison: MediaPayload | undefined;
let audio: HTMLAudioElement | undefined;
let url: string | undefined;
let playingBeforeHidden = false;
let pinned = false;
let lastSignature = '';
let lastMediaKey = '';
let lastMediaIdentity = '';
let syncPointEditor: (() => void) | undefined;
let syncTimeline: (() => void) | undefined;
let disposeCatalog: (() => void) | undefined;
let catalogPreferences: CatalogPreferences = {};
const environment = new PreviewEnvironment();
const disposeEnvironments = new Map<HTMLElement, () => void>();
const transientWorkers = new Set<Worker>();
const libraryThumbnails = new Map<string, string | undefined>();
let thumbnailQueue: string[] = [],
    thumbnailPending: string | undefined;
function requestThumbnail(): void {
    if (thumbnailPending || !thumbnailQueue.length) {
        return;
    }
    thumbnailPending = thumbnailQueue.shift();
    post('thumbnail', { id: thumbnailPending });
}
const settings: ViewSettings = {
    frame: 0,
    direction: 0,
    fps: 15,
    zoom: 1,
    color: [...DEFAULT_HOUSE_COLOR],
    action: -1,
    playing: false,
    shadow: false,
    mode: 'game',
    yaw: -45,
    pitch: 30,
    turret: 0,
    light: [...DEFAULT_VOXEL_LIGHT],
    fixed: false,
    slice: 0,
    hidden: new Set(),
    grid: true,
    fire: false,
    flhScale: 8,
    fit: false,
    lightGizmo: true,
    sceneState: 'normal',
    layers: new Set(),
    showPoints: true,
    selectedPoint: '',
    pan: [0, 0, 0],
    damaged: false,
    sceneFit: true,
};
const mediaSettings = new Map<string, ViewSettings>();
let settingsKind = '';
const saved = api.getState() as
    (Partial<ViewSettings> & { version?: number; kind?: string; catalog?: CatalogPreferences }) | undefined;
if (saved) {
    if (saved.catalog && typeof saved.catalog === 'object') {
        catalogPreferences = saved.catalog;
    }
    if (saved.version === 2 && ['sprite', 'voxel', 'image', 'audio', 'palette'].includes(saved.kind ?? '')) {
        settingsKind = saved.kind!;
    }
    for (const key of [
        'direction',
        'fps',
        'zoom',
        'yaw',
        'pitch',
        'turret',
        'mode',
        'flhScale',
        'showPoints',
    ] as const) {
        if (saved.version !== 3 && ['zoom', 'yaw', 'pitch', 'mode'].includes(key)) {
            continue;
        }
        if (typeof saved[key] === typeof settings[key]) {
            (settings as unknown as Record<string, unknown>)[key] = saved[key];
        }
    }
}
// Persisted UI state is untrusted and may come from an older extension version.
const limits: Partial<Record<keyof ViewSettings, [number, number]>> = {
    direction: [0, 7],
    fps: [1, 60],
    zoom: [0.25, 12],
    yaw: [-360, 360],
    pitch: [-89, 89],
    turret: [-360, 360],
    flhScale: [0.1, 256],
};
for (const [key, [min, max]] of Object.entries(limits)) {
    const value = settings[key as keyof ViewSettings];
    (settings as unknown as Record<string, unknown>)[key] =
        typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}
if (!['game', 'perspective', 'normal', 'slice'].includes(settings.mode)) {
    settings.mode = 'game';
}
const persist = () =>
    api.setState({
        version: 3,
        kind: settingsKind,
        showPoints: settings.showPoints,
        direction: settings.direction,
        fps: settings.fps,
        zoom: settings.zoom,
        yaw: settings.yaw,
        pitch: settings.pitch,
        turret: settings.turret,
        mode: settings.mode,
        flhScale: settings.flhScale,
        catalog: catalogPreferences,
    });
const post = (type: string, data: object = {}) => api.postMessage({ type, inspection: current?.id, ...data });
const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text?: string
): HTMLElementTagNameMap[K] => {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) {
        value.textContent = text;
    }
    return value;
};
function button(text: string, handler: () => void, className = ''): HTMLButtonElement {
    const value = element('button', className, text);
    value.type = 'button';
    value.onclick = handler;
    return value;
}
function field(name: string, input: HTMLElement): HTMLLabelElement {
    const label = element('label', 'field');
    label.append(element('span', '', name), input);
    return label;
}
function number(value: number, min: number, max: number, handler: (value: number) => void, step = 1): HTMLInputElement {
    const input = element('input');
    input.type = 'number';
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.oninput = () => {
        if (input.validity.valid && Number.isFinite(input.valueAsNumber)) {
            handler(input.valueAsNumber);
        }
    };
    return input;
}
function select(
    values: { value: string; label: string }[],
    selected: string,
    handler: (value: string) => void
): HTMLSelectElement {
    const input = element('select');
    for (const item of values) {
        const option = element('option', '', item.label);
        option.value = item.value;
        input.append(option);
    }
    input.value = selected;
    input.onchange = () => handler(input.value);
    return input;
}
function palettePicker(
    values: { value: string; label: string }[],
    selected: string,
    handler: (value: string) => void
): HTMLElement {
    const picker = element('details', 'palette-picker');
    const chosen = values.find((option) => option.value === selected) ?? values[0];
    const summary = element('summary', '', chosen?.label ?? labels.automatic);
    summary.title = chosen?.label ?? '';
    const search = element('input');
    search.type = 'search';
    search.placeholder = labels.searchPalette;
    search.setAttribute('aria-label', labels.searchPalette);
    const list = select(values, selected, (value) => {
        picker.open = false;
        handler(value);
    });
    list.size = 6;
    list.setAttribute('aria-label', labels.palette);
    search.oninput = () => {
        const query = search.value.trim().toLowerCase();
        list.replaceChildren(
            ...values
                .filter((option) => !query || option.label.toLowerCase().includes(query))
                .map((item) => {
                    const option = element('option', '', item.label);
                    option.value = item.value;
                    option.title = item.label;
                    return option;
                })
        );
        list.value = selected;
    };
    search.onkeydown = (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            list.focus();
        }
        if (event.key === 'Escape') {
            picker.open = false;
            summary.focus();
        }
    };
    picker.append(summary, search, list);
    return picker;
}

/** Viewport-owned gestures are disposed with the renderer, including pointer capture. */
function viewportControls(base: Renderer, viewport: HTMLElement, canvas: HTMLCanvasElement, voxel = false): Renderer {
    const hud = element('div', 'viewport-tools');
    const zoom = number(
        settings.zoom,
        0.2,
        12,
        (value) => {
            settings.zoom = value;
            update();
        },
        0.1
    );
    zoom.className = 'viewport-zoom';
    zoom.setAttribute('aria-label', labels.zoom);
    hud.title = voxel ? labels.voxelGestures : labels.spriteGestures;
    const reset = button(labels.reset, () => {
        settings.zoom = 1;
        settings.pan = [0, 0, 0];
        update();
    });
    hud.append(field(labels.zoom, zoom), reset);
    viewport.append(hud);
    let drag: { x: number; y: number; pan: number[]; pointer: number } | undefined;
    const sync = () => {
        if (document.activeElement !== zoom) {
            zoom.value = String(Math.round(settings.zoom * 100) / 100);
        }
        if (!voxel) {
            canvas.style.transform = 'translate(' + (settings.pan?.[0] ?? 0) + 'px,' + (settings.pan?.[1] ?? 0) + 'px)';
        }
    };
    const wheel = (event: WheelEvent) => {
        if ((event.target as HTMLElement).closest('input, button, select, details')) {
            return;
        }
        if (!voxel) {
            event.preventDefault();
            const before = settings.zoom;
            settings.zoom = Math.max(
                0.2,
                Math.min(12, before * Math.exp(Math.max(-0.6, Math.min(0.6, -event.deltaY * 0.002))))
            );
            const rect = viewport.getBoundingClientRect(),
                scale = settings.zoom / before;
            const x = event.clientX - rect.left - rect.width / 2,
                y = event.clientY - rect.top - rect.height / 2;
            settings.pan = [x - (x - (settings.pan?.[0] ?? 0)) * scale, y - (y - (settings.pan?.[1] ?? 0)) * scale, 0];
            base.update();
            persist();
        }
        sync();
    };
    const down = (event: PointerEvent) => {
        if (
            voxel ||
            (event.button !== 0 && event.button !== 1) ||
            (event.target as HTMLElement).closest('input, button, select, details, .viewport-tools')
        ) {
            return;
        }
        event.preventDefault();
        drag = { x: event.clientX, y: event.clientY, pan: [...(settings.pan ?? [0, 0, 0])], pointer: event.pointerId };
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add('panning');
    };
    const move = (event: PointerEvent) => {
        if (drag) {
            settings.pan = [drag.pan[0] + event.clientX - drag.x, drag.pan[1] + event.clientY - drag.y, 0];
            sync();
        }
    };
    const up = () => {
        if (drag && viewport.hasPointerCapture(drag.pointer)) {
            viewport.releasePointerCapture(drag.pointer);
        }
        drag = undefined;
        viewport.classList.remove('panning');
    };
    const cancel = () => {
        if (drag) {
            settings.pan = drag.pan;
            sync();
        }
        up();
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('pointerdown', down);
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', up);
    viewport.addEventListener('pointercancel', cancel);
    sync();
    return {
        update: () => {
            base.update();
            sync();
        },
        capture: base.capture,
        dispose: () => {
            cancel();
            base.dispose();
            disposeEnvironments.get(viewport)?.();
            disposeEnvironments.delete(viewport);
            viewport.removeEventListener('wheel', wheel);
            viewport.removeEventListener('pointerdown', down);
            viewport.removeEventListener('pointermove', move);
            viewport.removeEventListener('pointerup', up);
            viewport.removeEventListener('pointercancel', cancel);
        },
    };
}

function checkbox(text: string, checked: boolean, handler: (value: boolean) => void): HTMLLabelElement {
    const input = element('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.onchange = () => handler(input.checked);
    const label = element('label', 'check');
    label.append(input, document.createTextNode(text));
    return label;
}
function update(): void {
    if (settings.mode !== 'perspective' && environment.mode === 'sky') {
        environment.mode = 'image';
    }
    const background = document.querySelector<HTMLSelectElement>('[data-background]');
    if (background) {
        background.value = environment.mode;
    }
    const mode = document.querySelector<HTMLSelectElement>('.camera-mode');
    if (mode) {
        mode.value = settings.mode;
    }
    document.querySelectorAll<HTMLInputElement>('.light-value').forEach((input, index) => {
        if (document.activeElement !== input) {
            input.value = String(settings.light[index]);
        }
    });
    const fixed = document.querySelector<HTMLInputElement>('.light-fixed');
    if (fixed) {
        fixed.checked = settings.fixed;
    }
    renderer?.update();
    comparisonRenderer?.update();
    persist();
}
function message(text: string): void {
    const target = document.getElementById('status');
    if (target) {
        target.textContent = text;
    }
}
function stop(): void {
    settings.playing = false;
    audio?.pause();
    if (audio) {
        audio.currentTime = 0;
    }
}
function dispose(): void {
    disposeEnvironments.forEach((dispose) => dispose());
    disposeEnvironments.clear();
    disposeCatalog?.();
    disposeCatalog = undefined;
    syncPointEditor = undefined;
    syncTimeline = undefined;
    renderer?.dispose();
    comparisonRenderer?.dispose();
    renderer = undefined;
    comparisonRenderer = undefined;
    audio?.pause();
    audio = undefined;
    if (url) {
        URL.revokeObjectURL(url);
        url = undefined;
    }
    transientWorkers.forEach((worker) => worker.terminate());
    transientWorkers.clear();
}

function createRenderer(media: MediaPayload, host: HTMLElement, compare = false): Renderer | undefined {
    const viewport = element('div', 'viewport');
    if (compare) {
        viewport.style.pointerEvents = 'none';
    }
    const canvas = element('canvas', media.kind === 'voxel' ? 'voxel-canvas' : 'sprite-canvas');
    viewport.append(canvas);
    host.append(viewport);
    if (['image', 'sprite', 'voxel'].includes(media.kind)) {
        disposeEnvironments.set(viewport, environment.attach(viewport, settings, media.kind === 'voxel'));
    }
    if (media.kind === 'image') {
        return viewportControls(
            imageRenderer(canvas, media.width, media.height, fromBase64(media.pixels), settings),
            viewport,
            canvas
        );
    }
    if (media.kind === 'sprite') {
        if (media.scene) {
            viewport.classList.add('scene-viewport');
            return viewportControls(
                sceneRenderer(
                    media,
                    canvas,
                    settings,
                    workerUrl,
                    message,
                    compare,
                    (id, values) => post('edit', { id, values }),
                    () => syncPointEditor?.()
                ),
                viewport,
                canvas
            );
        }
        return viewportControls(
            spriteRenderer(
                media,
                canvas,
                settings,
                workerUrl,
                (frame) => {
                    if (compare) {
                        return;
                    }
                    syncTimeline?.();
                    comparisonRenderer?.update();
                },
                message,
                compare
            ),
            viewport,
            canvas
        );
    }
    if (media.kind === 'voxel') {
        const overlay = element('canvas', 'voxel-overlay');
        viewport.append(overlay);
        const result = voxelRenderer(
            media,
            canvas,
            overlay,
            settings,
            (id, values) => {
                if (!compare) {
                    post('edit', { id, values });
                }
            },
            () => {
                syncPointEditor?.();
                comparisonRenderer?.update();
                document.querySelectorAll<HTMLInputElement>('.light-value').forEach((input, index) => {
                    input.value = String(Math.round(settings.light[index] * 100000) / 100000);
                });
            },
            compare
        );
        host.append(element('p', 'hint', labels.uncalibrated));
        return viewportControls(result, viewport, canvas, true);
    }
    if (media.kind === 'palette') {
        canvas.width = 320;
        canvas.height = 320;
        const context = canvas.getContext('2d')!;
        for (let i = 0; i < 256; i++) {
            context.fillStyle = 'rgb(' + media.colors.slice(i * 3, i * 3 + 3).join(',') + ')';
            context.fillRect((i % 16) * 20, Math.floor(i / 16) * 20, 20, 20);
        }
        return {
            update: () => undefined,
            dispose: () => undefined,
            capture: () => ({ pixels: context.getImageData(0, 0, 320, 320).data, width: 320, height: 320 }),
        };
    }
    if (media.kind === 'audio') {
        viewport.remove();
        const player = element('div', 'audio-player');
        const bytes = fromBase64(media.bytes);
        const extension = media.name.split('.').pop()?.toLowerCase();
        const mime =
            extension === 'mp3'
                ? 'audio/mpeg'
                : extension === 'ogg'
                  ? 'audio/ogg'
                  : extension === 'flac'
                    ? 'audio/flac'
                    : 'audio/wav';
        url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: mime }));
        audio = element('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = url;
        audio.volume = Math.max(0, Math.min(1, media.volume));
        audio.loop = media.loop;
        audio.onerror = () => message(labels.missing);
        player.append(
            element('p', 'audio-title', media.name),
            audio,
            element(
                'p',
                'hint',
                [
                    media.duration ? media.duration.toFixed(2) + ' s' : '',
                    media.rate ? media.rate + ' Hz' : '',
                    media.channels ? media.channels + ' ch' : '',
                ]
                    .filter(Boolean)
                    .join(' · ')
            )
        );
        const controls = element('div', 'controls');
        const volume = element('input');
        volume.type = 'range';
        volume.min = '0';
        volume.max = '1';
        volume.step = '0.01';
        volume.value = String(audio.volume);
        volume.oninput = () => {
            if (audio) {
                audio.volume = Number(volume.value);
            }
        };
        controls.append(
            field(labels.volume, volume),
            button(labels.stop, stop),
            button(labels.random, () => {
                const assets = current?.assets ?? [];
                if (assets.length) {
                    post('select', { id: assets[Math.floor(Math.random() * assets.length)].id });
                }
            })
        );
        player.append(controls);
        host.append(player);
    }
    return undefined;
}

function commonControls(host: HTMLElement, remap = true): void {
    const controls = element('div', 'controls');
    const color = element('input');
    color.type = 'color';
    color.value = '#' + settings.color.map((value) => value.toString(16).padStart(2, '0')).join('');
    color.oninput = () => {
        settings.color = [1, 3, 5].map((index) => parseInt(color.value.slice(index, index + 2), 16));
        update();
    };
    controls.append(...(remap ? [field(labels.remap, color)] : []));
    controls.append(
        field(
            labels.background,
            select(
                [
                    { value: 'checker', label: '◩' },
                    { value: 'dark', label: '●' },
                    { value: 'light', label: '○' },
                    { value: 'image', label: labels.backgroundImage },
                    ...(current?.media?.kind === 'voxel' ? [{ value: 'sky', label: labels.backgroundSky }] : []),
                ],
                environment.mode,
                (value) => {
                    environment.mode = value as BackgroundMode;
                    if (value === 'sky') {
                        settings.mode = 'perspective';
                        update();
                    }
                    if (['image', 'sky'].includes(value) && !environment.name) {
                        post('background-file');
                    }
                }
            )
        )
    );
    const choose = button(labels.chooseBackground, () => post('background-file'));
    controls.querySelector('select')?.setAttribute('data-background', '');
    choose.title = labels.backgroundHelp;
    controls.append(choose);
    host.append(controls);
}

function spriteControls(media: Extract<MediaPayload, { kind: 'sprite' }>, host: HTMLElement): void {
    if (media.scene) {
        const controls = element('div', 'controls');
        if (media.scene.kind === 'building') {
            controls.append(
                field(
                    labels.theater,
                    select(
                        ['tem', 'sno', 'urb', 'ubn', 'lun', 'des'].map((value) => ({
                            value,
                            label: labels['theater_' + value],
                        })),
                        current?.theater ?? 'tem',
                        (theater) => post('theater', { theater })
                    )
                )
            );
        }
        const states = [
            ...new Set([
                'normal',
                ...media.scene.layers.map((layer) => layer.state).filter((value) => value !== 'damaged'),
            ]),
        ];
        controls.append(
            checkbox(labels.damaged, settings.damaged ?? false, (value) => {
                settings.damaged = value;
                update();
            }),
            checkbox(labels.fit, settings.sceneFit !== false, (value) => {
                settings.sceneFit = value;
                update();
            }),
            field(
                labels.sceneState,
                select(
                    states.map((value) => ({
                        value,
                        label: value === 'normal' ? labels.normalScene : (labels[value] ?? value),
                    })),
                    settings.sceneState,
                    (value) => {
                        settings.sceneState = value;
                        settings.frame = 0;
                        update();
                    }
                )
            )
        );
        if (media.scene.layers.some((layer) => (layer.media?.file.frames.length ?? 0) > 1)) {
            controls.append(
                button(labels.play, () => {
                    settings.playing = !settings.playing;
                }),
                field(
                    labels.speed,
                    number(settings.fps, 1, 60, (value) => {
                        settings.fps = value;
                    })
                )
            );
        }
        controls.append(
            checkbox(labels.shadow, settings.shadow, (value) => {
                settings.shadow = value;
                update();
            }),
            checkbox(labels.foundation, settings.grid, (value) => {
                settings.grid = value;
                update();
            })
        );
        host.append(controls);
        if (media.scene.layers.some((layer) => layer.voxel || layer.tag === 'TurretAnim')) {
            host.append(
                field(
                    labels.turret,
                    number(settings.turret, -360, 360, (value) => {
                        settings.turret = value;
                        update();
                    })
                )
            );
        }
        const layers = element('details', 'scene-layers');
        layers.open = true;
        layers.append(element('summary', '', labels.layers + ' · ' + media.scene.layers.length));
        const list = element('div', 'scene-layer-list');
        for (const layer of media.scene.layers) {
            const row = element('div', 'scene-layer');
            row.title = layer.source + (layer.paletteName ? '\n' + labels.palette + ': ' + layer.paletteName : '');
            row.append(
                checkbox(
                    layer.tag + ' · ' + layer.name,
                    !!(layer.media || layer.voxel) && !settings.layers.has(layer.id),
                    (value) => {
                        value ? settings.layers.delete(layer.id) : settings.layers.add(layer.id);
                        update();
                    }
                )
            );
            if (!layer.media && !layer.voxel) {
                row.querySelector('input')!.disabled = true;
            }
            if (media.scene.kind !== 'building' && layer.media) {
                row.append(
                    palettePicker(
                        [
                            { value: '', label: labels.automatic + ' · ' + (layer.paletteName ?? '') },
                            ...(current?.paletteOptions ?? []).map((option) => ({
                                value: option.id,
                                label: option.name + ' · ' + option.source,
                            })),
                        ],
                        layer.selectedPalette ?? '',
                        (palette) => post('select', { id: current!.selectedAsset, palette, layer: layer.id })
                    )
                );
            }
            list.append(row);
        }
        layers.append(list);
        const trace = element('details');
        trace.append(element('summary', '', labels.trace));
        media.scene.trace.forEach((step) => trace.append(element('p', 'hint', step)));
        host.append(layers, trace);
        if (media.scene.points?.length) {
            const editor = element('details', 'firing-points');
            editor.append(element('summary', '', labels.damagePoints));
            editor.append(
                checkbox(labels.showPoints, settings.showPoints, (value) => {
                    settings.showPoints = value;
                    update();
                })
            );
            const choices = select(
                media.scene.points.map((point) => ({
                    value: point.name,
                    label: point.name + (point.absent ? ' +' : ''),
                })),
                settings.selectedPoint,
                (value) => {
                    settings.selectedPoint = value;
                    renderEditor();
                    update();
                }
            );
            editor.append(choices);
            const fields = element('div');
            editor.append(fields);
            const renderEditor = () => {
                fields.replaceChildren();
                const point = media.scene!.points!.find((item) => item.name === settings.selectedPoint);
                if (!point) {
                    return;
                }
                const row = element('div', 'controls');
                point.value.forEach((value, index) =>
                    row.append(
                        field(
                            ['X', 'Y', 'Z'][index],
                            number(value, -1000000, 1000000, (next) => {
                                point.value[index] = next;
                                update();
                            })
                        )
                    )
                );
                row.append(
                    button(
                        point.absent ? labels.addPoint : labels.apply,
                        () => post('edit', { id: point.id, values: point.value }),
                        'primary'
                    )
                );
                if (!point.absent && point.space === 'pixel' && point.deletable !== false) {
                    row.append(button(labels.deletePoint, () => post('edit', { id: point.id, values: null })));
                }
                fields.append(row);
            };
            syncPointEditor = () => {
                choices.value = settings.selectedPoint;
                editor.open = true;
                renderEditor();
            };
            renderEditor();
            host.querySelector('.viewport')?.append(editor);
        }
        return;
    }
    const controls = element('div', 'controls');
    const frames = element('input');
    frames.type = 'range';
    frames.min = '0';
    const bodyFrames = media.shadow ? media.file.frames.length / 2 : media.file.frames.length;
    const clip = () =>
        spriteClip(media.file.frames.length, media.shadow, media.actions[settings.action]?.action, settings.direction);
    frames.max = String(clip().count - 1);
    frames.value = String(settings.frame);
    frames.oninput = () => {
        settings.playing = false;
        settings.frame = Number(frames.value);
        update();
    };
    controls.append(
        button(
            '▶ / Ⅱ',
            () => {
                settings.playing = !settings.playing;
            },
            'primary'
        ),
        button('‹', () => {
            settings.playing = false;
            settings.frame = Math.max(0, settings.frame - 1);
            update();
        }),
        button('›', () => {
            settings.playing = false;
            settings.frame = Math.min(clip().count - 1, settings.frame + 1);
            update();
        }),
        field(
            labels.speed,
            number(settings.fps, 1, 60, (value) => {
                settings.fps = value;
            })
        ),
        field(
            labels.direction,
            select(
                Array.from({ length: 8 }, (_, i) => ({ value: String(i), label: String(i * 45) + '°' })),
                String(settings.direction),
                (value) => {
                    settings.direction = Number(value);
                    settings.frame = 0;
                    settings.playing = settings.action >= 0;
                    update();
                }
            )
        ),
        checkbox(labels.shadow, settings.shadow, (value) => {
            settings.shadow = value;
            update();
        })
    );
    host.append(controls, frames, element('p', 'hint', labels.frame));
    controls.querySelector('select')?.classList.add('direction-select');
    controls.hidden = bodyFrames <= 1;
    frames.hidden = bodyFrames <= 1;
    const indicator = host.lastElementChild as HTMLElement;
    indicator.id = 'frame-indicator';
    syncTimeline = () => {
        const selected = clip();
        frames.max = String(selected.count - 1);
        frames.value = String(settings.frame % selected.count);
        indicator.textContent =
            labels.frame +
            ' ' +
            ((settings.frame % selected.count) + 1) +
            ' / ' +
            selected.count +
            ' · ' +
            labels.sourceFrame +
            ' ' +
            selected.frame(settings.frame);
        const directionInput = document.querySelector<HTMLSelectElement>('.direction-select');
        if (directionInput) {
            directionInput.value = String(settings.direction);
        }
        document
            .querySelectorAll('.direction-grid button')
            .forEach((item, index) => item.setAttribute('aria-pressed', String(index === settings.direction)));
    };
    const actions = element('div', 'controls');
    actions.append(
        field(
            labels.sequence,
            select(
                [
                    { value: '-1', label: labels.raw },
                    ...media.actions.map((item, index) => ({
                        value: String(index),
                        label: item.action.name + (item.valid ? '' : ' ⚠'),
                    })),
                ],
                String(settings.action),
                (value) => {
                    settings.action = Number(value);
                    settings.frame = 0;
                    settings.playing = settings.action >= 0 && !!media.actions[settings.action]?.valid;
                    update();
                    actionEditor();
                    syncTimeline?.();
                    if (!contacts.hidden) {
                        renderContact();
                    }
                }
            )
        )
    );
    host.append(actions);
    const editor = element('div', 'sequence-editor');
    host.append(editor);
    const actionEditor = () => {
        editor.replaceChildren();
        const selected = media.actions[settings.action];
        if (!selected) {
            return;
        }
        const values = [selected.action.start, selected.action.count, selected.action.stride];
        [labels.start, labels.count, labels.stride].forEach((label, index) =>
            editor.append(
                field(
                    label,
                    number(values[index], index === 1 ? 1 : 0, 65535, (value) => {
                        values[index] = value;
                        selected.action.start = values[0];
                        selected.action.count = values[1];
                        selected.action.stride = values[2];
                        update();
                    })
                )
            )
        );
        editor.append(
            element('p', 'hint', labels.shared + ': ' + selected.users),
            button(labels.apply, () => post('edit', { id: selected.id, values }), 'primary')
        );
        if (!selected.valid) {
            editor.append(element('p', 'warning', labels.invalidSequence));
        }
    };
    actionEditor();
    syncTimeline();
    const directions = element('div', 'direction-grid');
    for (let direction = 0; direction < 8; direction++) {
        const choice = button(String(direction * 45) + '°', () => {
            settings.direction = direction;
            settings.frame = 0;
            settings.playing = settings.action >= 0;
            directions
                .querySelectorAll('button')
                .forEach((item, index) => item.setAttribute('aria-pressed', String(index === direction)));
            update();
        });
        choice.setAttribute('aria-pressed', String(direction === settings.direction));
        directions.append(choice);
    }
    directions.hidden = !media.actions.length;
    host.append(directions);
    const contacts = element('div', 'contacts');
    let page = 0;
    let contactWorker: Worker | undefined;
    let contactGeneration = 0;
    const contactButton = button(labels.contact, () => {
        contacts.hidden = !contacts.hidden;
        if (!contacts.hidden) {
            renderContact();
        }
    });
    contacts.hidden = true;
    host.append(contactButton, contacts);
    const renderContact = () => {
        contactWorker?.terminate();
        if (contactWorker) {
            transientWorkers.delete(contactWorker);
        }
        const generation = ++contactGeneration;
        contacts.replaceChildren();
        const nav = element('div', 'controls');
        nav.append(
            button('‹', () => {
                page = Math.max(0, page - 1);
                renderContact();
            }),
            element('span', '', String(page + 1)),
            button('›', () => {
                if ((page + 1) * 32 < media.file.frames.length) {
                    page++;
                    renderContact();
                }
            })
        );
        contacts.append(nav);
        const tiles = new Map<number, HTMLCanvasElement>();
        const action = media.actions[settings.action]?.action;
        nav.hidden = !!action;
        const first = action ? 0 : page * 32,
            end = action ? 8 : Math.min(first + 32, bodyFrames);
        const sourceFrame = (index: number) =>
            action ? spriteClip(media.file.frames.length, media.shadow, action, index).frame(settings.frame) : index;
        contactWorker = new Worker(workerUrl);
        transientWorkers.add(contactWorker);
        contactWorker.postMessage({
            type: 'load',
            bytes: fromBase64(media.bytes),
            file: media.file,
            palette: media.palette,
        });
        contactWorker.onmessage = (event) => {
            if (generation !== contactGeneration || event.data.type !== 'frame') {
                return;
            }
            const canvas = tiles.get(event.data.id);
            if (!canvas) {
                return;
            }
            const temporary = document.createElement('canvas');
            temporary.width = media.file.width;
            temporary.height = media.file.height;
            temporary
                .getContext('2d')!
                .putImageData(new ImageData(event.data.rgba, temporary.width, temporary.height), 0, 0);
            const ratio = Math.min(1, 80 / Math.max(temporary.width, temporary.height));
            canvas.width = Math.max(1, Math.round(temporary.width * ratio));
            canvas.height = Math.max(1, Math.round(temporary.height * ratio));
            canvas.getContext('2d')!.imageSmoothingEnabled = false;
            canvas.getContext('2d')!.drawImage(temporary, 0, 0, canvas.width, canvas.height);
            const next = event.data.id + 1;
            if (next < end) {
                contactWorker?.postMessage({
                    type: 'frame',
                    id: next,
                    frame: sourceFrame(next),
                    shadow: false,
                    color: settings.color,
                    remap: media.remap === true,
                });
            } else {
                contactWorker?.terminate();
                if (contactWorker) {
                    transientWorkers.delete(contactWorker);
                }
            }
        };
        for (let index = first; index < end; index++) {
            const tile = button('', () => {
                if (action) {
                    settings.direction = index;
                    settings.frame = 0;
                    settings.playing = true;
                } else {
                    settings.frame = index;
                    settings.action = -1;
                    settings.playing = false;
                }
                update();
            });
            const canvas = element('canvas', 'contact-thumbnail');
            tiles.set(index, canvas);
            tile.append(canvas, element('span', '', action ? String(index * 45) + '°' : String(index)));
            tile.title = labels.frame + ' ' + index;
            contacts.append(tile);
        }
        contactWorker.postMessage({
            type: 'frame',
            id: first,
            frame: sourceFrame(first),
            shadow: false,
            color: settings.color,
            remap: media.remap === true,
        });
    };
}

function voxelControls(media: Extract<MediaPayload, { kind: 'voxel' }>, host: HTMLElement): void {
    const controls = element('div', 'controls');
    controls.append(
        field(
            labels.visual,
            select(
                ['game', 'perspective', 'normal', 'slice'].map((value) => ({ value, label: labels[value] })),
                settings.mode,
                (value) => {
                    settings.mode = value;
                    if (value === 'game') {
                        settings.yaw = -45;
                        settings.pitch = 30;
                        settings.zoom = 1;
                        settings.fit = false;
                        settings.pan = [0, 0, 0];
                    }
                    update();
                }
            )
        ),
        button(labels.reset, () => {
            settings.yaw = -45;
            settings.pitch = 30;
            settings.zoom = 1;
            settings.fit = false;
            settings.pan = [0, 0, 0];
            update();
        }),
        button(labels.fit, () => {
            settings.fit = true;
            update();
        }),
        ...(media.model.parts.some((part) => part.role === 'turret' || part.role === 'barrel')
            ? [
                  field(
                      labels.turret,
                      number(settings.turret, -360, 360, (value) => {
                          settings.turret = value;
                          update();
                      })
                  ),
              ]
            : []),
        ...(media.model.parts.some((part) => part.role === 'barrel')
            ? [
                  field(
                      labels.fireAngle,
                      number(settings.fireAngle ?? media.fireAngle ?? 0, 0, 64, (value) => {
                          settings.fireAngle = value;
                          update();
                      })
                  ),
              ]
            : []),
        field(
            labels.slice,
            number(settings.slice, 0, 255, (value) => {
                settings.slice = value;
                update();
            })
        ),
        checkbox(labels.grid, settings.grid, (value) => {
            settings.grid = value;
            update();
        }),
        checkbox(labels.fire, settings.fire, (value) => {
            settings.fire = value;
            update();
        })
    );
    controls.querySelector('select')?.classList.add('camera-mode');
    host.append(controls);
    const hvaFrames = Math.max(1, ...media.model.parts.map((part) => part.animation?.length ?? 1));
    const timeline = element('div', 'controls');
    timeline.append(
        field(
            labels.frame,
            number(settings.frame % hvaFrames, 0, hvaFrames - 1, (value) => {
                settings.frame = value;
                settings.playing = false;
                update();
            })
        ),
        field(
            labels.speed,
            number(settings.fps, 1, 60, (value) => {
                settings.fps = value;
            })
        )
    );
    if (hvaFrames > 1) {
        timeline.prepend(
            button(labels.play, () => {
                settings.playing = !settings.playing;
            })
        );
        host.append(timeline);
    }
    const light = element('div', 'controls');
    light.append(element('span', '', labels.light));
    light.append(
        button(labels.resetLight, () => {
            settings.light = [...media.light];
            settings.fixed = media.fixed;
            update();
        }),
        checkbox(labels.lightGizmo, settings.lightGizmo, (value) => {
            settings.lightGizmo = value;
            update();
        })
    );
    ['X', 'Y', 'Z'].forEach((axis, index) =>
        light.append(
            field(
                axis,
                number(
                    settings.light[index],
                    -100,
                    100,
                    (value) => {
                        settings.light[index] = value;
                        update();
                    },
                    0.01
                )
            )
        )
    );
    light
        .querySelectorAll<HTMLInputElement>('input[type="number"]')
        .forEach((input) => input.classList.add('light-value'));
    if (current?.lightEdit) {
        light.append(
            button(
                labels.apply,
                () => post('edit', { id: current!.lightEdit, values: [...settings.light, settings.fixed ? 1 : 0] }),
                'primary'
            )
        );
    }
    light.append(
        checkbox(labels.fixed, settings.fixed, (value) => {
            settings.fixed = value;
            update();
        })
    );
    Array.from(light.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).at(-1)?.classList.add('light-fixed');
    host.append(light);
    const parts = element('details');
    parts.append(element('summary', '', labels.parts));
    media.model.parts.forEach((part, index) =>
        parts.append(
            checkbox(labels[part.role] + ' · ' + part.name, !settings.hidden.has(index + ':' + part.name), (value) => {
                if (value) {
                    settings.hidden.delete(index + ':' + part.name);
                } else {
                    settings.hidden.add(index + ':' + part.name);
                }
                update();
            })
        )
    );
    host.append(parts);
    const points = element('details', 'firing-points');
    points.open = false;
    points.hidden = !media.points.length;
    const summary = element('summary', '', labels.points + ' · ' + media.points.length);
    summary.title = labels.dragPoint;
    points.append(summary);
    points.append(
        checkbox(labels.showPoints, settings.showPoints, (value) => {
            settings.showPoints = value;
            update();
        })
    );
    const pointSelection = select(
        [
            { value: '', label: labels.selectPoint },
            ...media.points.map((point) => ({ value: point.name, label: point.name })),
        ],
        settings.selectedPoint,
        (value) => {
            settings.selectedPoint = value;
            if (value) {
                settings.showPoints = true;
                const toggle = points.querySelector<HTMLInputElement>('input[type="checkbox"]');
                if (toggle) {
                    toggle.checked = true;
                }
            }
            update();
            renderPointEditor();
        }
    );
    points.append(field(labels.points, pointSelection));
    points.append(
        field(
            labels.flhScale,
            number(
                settings.flhScale,
                0.1,
                256,
                (value) => {
                    settings.flhScale = value;
                    update();
                },
                0.1
            )
        )
    );
    const pointEditor = element('div');
    points.append(pointEditor);
    const renderPointEditor = () => {
        pointEditor.replaceChildren();
        const point = media.points.find((item) => item.name === settings.selectedPoint);
        if (!point) {
            return;
        }
        const row = element('div', 'controls');
        row.append(element('span', '', point.name));
        ['F', 'L', 'H'].forEach((axis, index) =>
            row.append(
                field(
                    axis,
                    number(point.value[index], -1000000, 1000000, (value) => {
                        point.value[index] = value;
                        update();
                    })
                )
            )
        );
        row.append(button(labels.apply, () => post('edit', { id: point.id, values: point.value }), 'primary'));
        pointEditor.append(row);
    };
    syncPointEditor = () => {
        pointSelection.value = settings.selectedPoint;
        renderPointEditor();
    };
    renderPointEditor();
    host.querySelector('.viewport')?.append(points);
}

function render(inspection: Inspection): void {
    const pageKind = inspection.stringTable ? 'strings' : inspection.fileText !== undefined ? 'file' : inspection.checks || inspection.logic ? 'analysis' : inspection.project
        ? 'project'
        : inspection.objects
          ? 'catalog'
          : inspection.map
            ? 'map'
            : 'object';
    if (app.dataset.surface !== pageKind) {
        window.scrollTo(0, 0);
    }
    app.dataset.surface = pageKind;
    app.classList.toggle('catalog-page', !!inspection.objects || !!inspection.project || !!inspection.checks || !!inspection.logic);
    app.classList.toggle('map-page', !!inspection.map);
    const kind = inspection.media?.kind ?? '';
    if (settingsKind !== kind) {
        if (settingsKind) {
            mediaSettings.set(settingsKind, {
                ...settings,
                hidden: new Set(settings.hidden),
                layers: new Set(settings.layers),
                light: [...settings.light],
            });
        }
        const stored = mediaSettings.get(kind);
        Object.assign(
            settings,
            stored ?? {
                frame: 0,
                action: -1,
                playing: false,
                zoom: 1,
                direction: 0,
                hidden: new Set(),
                layers: new Set(),
                sceneState: 'normal',
            }
        );
        settingsKind = kind;
    }
    dispose();
    current = inspection;
    app.dataset.inspection = inspection.id;
    const media = inspection.media;
    const capabilities = media && mediaCapabilities(media.kind);
    const mediaKey =
        media?.kind === 'voxel'
            ? media.name + ':' + JSON.stringify([media.light, media.fixed, media.fireAngle])
            : (media?.name ?? '');
    if (media?.kind === 'voxel' && lastMediaKey !== mediaKey) {
        settings.light = [...media.light];
        settings.fixed = media.fixed;
        settings.fireAngle = media.fireAngle ?? 0;
    }
    lastMediaKey = mediaKey;
    if (media?.kind === 'sprite' && lastMediaIdentity !== inspection.owner + ':' + media.name) {
        settings.shadow = media.shadow;
        settings.frame = Math.min(settings.frame, media.file.frames.length - 1);
        settings.action = -1;
    }
    if (lastMediaIdentity !== inspection.owner + ':' + media?.name) {
        settings.layers.clear();
        settings.hidden.clear();
        settings.sceneState = 'normal';
        settings.damaged = false;
        settings.pan = [0, 0, 0];
        settings.selectedPoint = '';
        settings.frame = 0;
        if (media?.kind === 'voxel') {
            settings.fireAngle = media.fireAngle ?? 0;
        }
    }
    lastMediaIdentity = inspection.owner + ':' + media?.name;
    if (media?.kind === 'voxel') {
        if (media.points.some((point) => point.name === inspection.focus)) {
            settings.selectedPoint = inspection.focus;
        } else if (!media.points.some((point) => point.name === settings.selectedPoint)) {
            settings.selectedPoint = '';
        }
    }
    app.replaceChildren();
    const toolbar = element('nav', 'toolbar');
    if (inspection.checks || inspection.logic) {
        // Analysis views own their scoped controls.
    } else if (inspection.objects || inspection.project) {
        toolbar.append(
            button(labels.projectSettings, () => post('catalog-scope', { value: 'overview' })),
            button(labels.group_game, () => post('catalog-scope', { value: 'game' })),
            button(labels.refresh, () => post('refresh'))
        );
    } else {
        toolbar.append(
            button('‹', () => post('back')),
            button(pinned ? labels.follow : labels.pin, () => post('pin')),
            button('↻', () => post('refresh'))
        );
    }
    const heading = element('header', 'identity');
    heading.append(
        element('span', 'eyebrow', displayType(inspection.type)),
        element('h1', '', inspection.owner),
        element('p', 'focus', inspection.focus !== inspection.owner ? inspection.focus : '')
    );
    const status = element('p', 'status');
    status.id = 'status';
    app.append(toolbar, heading, status);
    if (inspection.resolution) {
        const resolution = inspection.resolution;
        const summary = element('details', 'resolution-context');
        summary.append(
            element(
                'summary',
                '',
                (resolution.mode === 'standalone' ? labels.standaloneContext : resolution.configured ? labels.configuredContext : resolution.mode === 'project' ? labels.automaticContext : labels.editorContext) +
                    ' · ' +
                    resolution.documents +
                    ' ' +
                    labels.documents +
                    (resolution.complete ? '' : ' · ' + labels.indexIncomplete)
            )
        );
        summary.append(
            element('p', '', labels.contextHelp),
            button(labels.projectEntries, () => post('configure-project'))
        );
        resolution.entries.forEach((entry) => summary.append(element('div', '', entry)));
        resolution.issues.forEach((issue) => summary.append(element('p', 'warning', issue)));
        app.append(summary);
    }
    if (inspection.checks || inspection.logic) {
        analysisView(app, inspection, labels, post);
        return;
    }
    if (inspection.project) {
        projectView(app, inspection, labels, post);
        return;
    }
    if (inspection.stringTable) {
        disposeCatalog = stringTableView(app, inspection, labels, post);
        return;
    }
    if (inspection.fileText !== undefined) {
        app.append(element('p', 'hint', labels.fileExcerpt), element('pre', 'file-excerpt', inspection.fileText));
        return;
    }
    if (inspection.map) {
        mapView(app, inspection, labels, post);
        return;
    }
    if (inspection.objects) {
        disposeCatalog = objectBrowser(app, inspection, labels, post, catalogPreferences, (next) => {
            catalogPreferences = next;
            persist();
        });
        return;
    }
    if (inspection.library) {
        renderLibrary(inspection, app);
    }
    const tabs = element('nav', 'tabs'),
        visual = element('section', 'visual'),
        attributes = element('section', 'attributes'),
        links = element('section', 'links');
    attributes.hidden = true;
    links.hidden = true;
    for (const [label, panel] of [
        [labels.visual, visual],
        [labels.attributes, attributes],
        [labels.links, links],
    ] as const) {
        tabs.append(
            button(label, () => {
                visual.hidden = panel !== visual;
                attributes.hidden = panel !== attributes;
                links.hidden = panel !== links;
            })
        );
    }
    app.append(tabs, visual, attributes, links);
    if (inspection.assets.length) {
        const sources = element('div', 'asset-sources');
        for (const asset of inspection.assets) {
            const choice = button(
                asset.name,
                () => post('select', { id: asset.id, palette: inspection.selectedPalette }),
                'asset-choice'
            );
            choice.setAttribute(
                'aria-pressed',
                String(asset.id === (inspection.selectedAsset ?? inspection.assets[0].id))
            );
            const name = element('span', 'asset-name', asset.name);
            choice.replaceChildren(name);
            choice.title = asset.name + '\n' + asset.source;
            choice.append(
                element('span', 'hint', asset.source),
                element(
                    'span',
                    'source-role',
                    asset.role === 'backup' ? labels.backup : asset.role === 'archive' ? labels.archive : labels.project
                )
            );
            sources.append(choice);
        }
        visual.append(element('h2', '', labels.source), sources);
    }
    if (inspection.paletteOptions.length && media && capabilities?.palette) {
        visual.append(
            field(
                labels.palette,
                palettePicker(
                    [
                        {
                            value: '',
                            label: labels.automatic + ' · ' + ('paletteName' in media ? (media.paletteName ?? '') : ''),
                        },
                        ...inspection.paletteOptions.map((asset) => ({
                            value: asset.id,
                            label: asset.name + ' · ' + asset.source,
                        })),
                    ],
                    inspection.selectedPalette ?? '',
                    (palette) => {
                        const selected = inspection.selectedAsset ?? inspection.assets[0]?.id;
                        if (selected) {
                            post('select', { id: selected, palette });
                        }
                    }
                )
            )
        );
    }
    if (media) {
        try {
            renderer = createRenderer(media, visual);
            if (capabilities?.zoom) {
                commonControls(visual, mediaUsesRemap(media));
            }
            if (media.kind === 'sprite') {
                spriteControls(media, visual);
            }
            if (media.kind === 'voxel') {
                voxelControls(media, visual);
            }
        } catch (error) {
            message(error instanceof Error ? error.message : String(error));
        }
        const actions = element('div', 'controls asset-actions');
        actions.append(
            button(capabilities?.export === 'audio' ? labels.exportAudio : labels.exportPng, () => {
                if (media.kind === 'audio') {
                    post('export');
                    return;
                }
                const image = renderer?.capture();
                if (!image) {
                    return;
                }
                let binary = '';
                for (const byte of image.pixels) {
                    binary += String.fromCharCode(byte);
                }
                post('export', { width: image.width, height: image.height, pixels: btoa(binary) });
            })
        );
        if (capabilities?.compare) {
            actions.append(
                button(labels.compare, () => {
                    comparison = structuredClone(media);
                    renderComparison(visual);
                })
            );
        }
        if (inspection.canReplace) {
            actions.append(button(labels.replacement, () => post('replace')));
        }
        visual.append(actions);
        if (comparison && capabilities?.compare) {
            renderComparison(visual);
        }
    } else {
        visual.append(element('p', 'empty', labels.missing));
    }
    for (const entry of inspection.cameos ?? (inspection.cameo ? [{ tag: 'Cameo', media: inspection.cameo }] : [])) {
        const cameo = element('div', 'cameo-card');
        cameo.append(element('p', 'hint', entry.tag === 'AltCameo' ? labels.altCameo : labels.cameo));
        const image = entry.media;
        if (image.kind === 'sprite') {
            const canvas = element('canvas', 'cameo');
            cameo.append(canvas);
            const worker = new Worker(workerUrl);
            transientWorkers.add(worker);
            worker.postMessage({
                type: 'load',
                bytes: fromBase64(image.bytes),
                file: image.file,
                palette: image.palette,
            });
            worker.postMessage({ type: 'frame', id: 0, frame: 0, shadow: false, remap: false, color: settings.color });
            worker.onmessage = (event) => {
                if (event.data.type === 'frame') {
                    canvas.width = image.file.width;
                    canvas.height = image.file.height;
                    canvas
                        .getContext('2d')!
                        .putImageData(new ImageData(event.data.rgba, canvas.width, canvas.height), 0, 0);
                }
                worker.terminate();
                transientWorkers.delete(worker);
            };
        } else if (image.kind === 'image') {
            const canvas = element('canvas', 'cameo');
            cameo.append(canvas);
            imageRenderer(canvas, image.width, image.height, fromBase64(image.pixels));
        }
        visual.append(cameo);
    }
    for (const warning of inspection.warnings) {
        visual.append(element('p', 'warning', warning));
    }
    renderProperties(attributes, inspection, labels, post);
    links.append(element('p', 'eyebrow', labels.source));
    inspection.sources.forEach((source) =>
        links.append(button(source.label, () => post('source', { id: source.id }), 'link-row'))
    );
    links.append(element('p', 'eyebrow', labels.references));
    inspection.references.forEach((source) =>
        links.append(button(source.label, () => post('source', { id: source.id }), 'link-row'))
    );
    const surface = visual.querySelector('.viewport');
    if (surface) {
        const stage = element('div', 'preview-stage');
        const controls = element('div', 'preview-controls');
        for (const child of Array.from(visual.children)) {
            (child === surface ? stage : controls).append(child);
        }
        const sources = controls.querySelector('.asset-sources');
        if (sources) {
            const heading = sources.previousElementSibling;
            if (heading?.tagName === 'H2') {
                controls.append(heading);
            }
            controls.append(sources);
        }
        const icons = element('div', 'cameo-strip');
        controls.querySelectorAll('.cameo-card').forEach((card) => icons.append(card));
        if (icons.children.length) {
            controls.prepend(icons);
        }
        visual.append(stage, controls);
    }
}

function renderLibrary(inspection: Inspection, host: HTMLElement): void {
    const library = element('details', 'library');
    library.open = !inspection.media;
    library.append(element('summary', '', labels.library + ' · ' + inspection.library!.length));
    const filter = element('input');
    filter.type = 'search';
    filter.placeholder = labels.filter;
    library.append(filter);
    const grid = element('div', 'asset-grid'),
        navigation = element('div', 'controls');
    let page = 0;
    const redraw = () => {
        grid.replaceChildren();
        navigation.replaceChildren();
        thumbnailQueue = [];
        const query = filter.value.toLowerCase();
        const found = inspection.library!.filter((asset) =>
            (asset.name + ' ' + asset.source).toLowerCase().includes(query)
        );
        const pages = Math.max(1, Math.ceil(found.length / 24));
        page = Math.min(page, pages - 1);
        navigation.append(
            button('‹', () => {
                page = Math.max(0, page - 1);
                redraw();
            }),
            element('span', '', page + 1 + ' / ' + pages),
            button('›', () => {
                page = Math.min(pages - 1, page + 1);
                redraw();
            })
        );
        for (const asset of found.slice(page * 24, (page + 1) * 24)) {
            const tile = button('', () => post('select', { id: asset.id }), 'asset-tile');
            const image = element('img', 'asset-thumbnail');
            image.dataset.asset = asset.id;
            image.alt = asset.name;
            const thumbnail = libraryThumbnails.get(asset.id);
            if (thumbnail) {
                image.src = 'data:image/png;base64,' + thumbnail;
            } else if (!libraryThumbnails.has(asset.id) && /\.(shp|pcx|vxl|hva)$/i.test(asset.name)) {
                thumbnailQueue.push(asset.id);
            } else {
                image.hidden = true;
            }
            tile.append(image, element('strong', '', asset.name), element('span', 'hint', asset.source));
            tile.title = asset.source;
            tile.setAttribute('aria-pressed', String(asset.id === inspection.selectedAsset));
            grid.append(tile);
        }
        requestThumbnail();
    };
    filter.oninput = () => {
        page = 0;
        redraw();
    };
    library.append(navigation, grid);
    host.append(library);
    redraw();
}

function renderComparison(host: HTMLElement): void {
    comparisonRenderer?.dispose();
    document.getElementById('comparison')?.remove();
    if (!comparison || comparison.kind === 'audio') {
        return;
    }
    const panel = element('details');
    panel.id = 'comparison';
    panel.open = true;
    panel.append(element('summary', '', labels.snapshot + ' · ' + comparison.name));
    panel.append(
        button(labels.clearComparison, () => {
            comparison = undefined;
            comparisonRenderer?.dispose();
            comparisonRenderer = undefined;
            panel.remove();
        })
    );
    try {
        comparisonRenderer = createRenderer(comparison, panel, true);
    } catch (error) {
        panel.append(element('p', 'warning', String(error)));
    }
    host.append(panel);
}

window.addEventListener('message', (event) => {
    if (
        event.data.type === 'background-file' &&
        typeof event.data.bytes === 'string' &&
        ['image/png', 'image/jpeg', 'image/webp'].includes(event.data.mime)
    ) {
        void environment
            .load(fromBase64(event.data.bytes), event.data.mime, event.data.name)
            .then(() => {
                const select = app.querySelector<HTMLSelectElement>('[data-background]');
                if (select) {
                    select.value = environment.mode;
                }
            })
            .catch((error) => message(labels.backgroundFailed + ': ' + String(error)));
        return;
    }
    if (event.data.type === 'thumbnail') {
        if (event.data.inspection === current?.id) {
            libraryThumbnails.set(event.data.id, event.data.bytes);
            if (libraryThumbnails.size > 500) {
                libraryThumbnails.delete(libraryThumbnails.keys().next().value!);
            }
            document.querySelectorAll<HTMLImageElement>('[data-asset]').forEach((image) => {
                if (image.dataset.asset !== event.data.id) {
                    return;
                }
                if (event.data.bytes) {
                    image.src = 'data:image/png;base64,' + event.data.bytes;
                } else {
                    image.hidden = true;
                }
            });
        }
        if (thumbnailPending === event.data.id) {
            thumbnailPending = undefined;
            requestThumbnail();
        }
        return;
    }
    if (event.data.type === 'visibility') {
        if (!event.data.visible) {
            playingBeforeHidden = settings.playing;
            settings.playing = false;
            audio?.pause();
        } else {
            settings.playing = playingBeforeHidden;
            update();
        }
        return;
    }
    if (event.data.type !== 'state') {
        return;
    }
    const state = event.data as HostState;
    labels = state.labels;
    pinned = state.pinned;
    if (state.inspection && !state.loading) {
        const signature = state.inspection.id + ':' + state.inspection.mediaRevision;
        if (signature !== lastSignature) {
            lastSignature = signature;
            render(state.inspection);
        } else {
            const buttons = app.querySelectorAll('.toolbar button');
            if (buttons[1]) {
                buttons[1].textContent = pinned ? labels.follow : labels.pin;
            }
        }
    } else if (!state.inspection && !state.loading) {
        dispose();
        current = undefined;
        app.replaceChildren(element('p', 'empty', labels.empty));
    }
    message(state.error ?? (state.loading ? labels.loading : ''));
});
window.addEventListener('pagehide', dispose);
void fetch(workerSource)
    .then((response) => {
        if (!response.ok) {
            throw new Error('Preview worker could not be loaded.');
        }
        return response.text();
    })
    .then((source) => {
        workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        api.postMessage({ type: 'ready' });
    })
    .catch((error) => {
        app.textContent = error instanceof Error ? error.message : String(error);
    });
