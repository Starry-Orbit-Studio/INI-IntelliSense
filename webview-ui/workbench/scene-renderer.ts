import type { MediaPayload } from '../../src/context/workbench-protocol';
import { Renderer, ViewSettings, fromBase64 } from './renderer';
import { layerBounds, layerFrame, layerVisible, unionBounds } from '../../src/media/scene-layout';
import { foundationPoints, buildingPoint, moveBuildingPoint } from '../../src/media/building-coordinates';

/** Composites decoded sprite planes in one canvas, with independent state and layer visibility. */
export function sceneRenderer(
    media: Extract<MediaPayload, { kind: 'sprite' }>,
    canvas: HTMLCanvasElement,
    settings: ViewSettings,
    workerUrl: string,
    failed: (message: string) => void,
    comparison = false,
    edit: (id: string, values: number[]) => void = () => undefined,
    changed: () => void = () => undefined
): Renderer {
    const scene = media.scene!;
    const ctx = canvas.getContext('2d')!;
    const planes = new Map<string, HTMLCanvasElement>();
    const planeOrigins = new Map<string, number[]>();
    const workers: Worker[] = [];
    const ordered = [...scene.layers].sort((a, b) => b.z - a.z);
    const available = ordered.filter((layer) => layer.media || layer.voxel);
    const foundation = foundationPoints(scene.foundation);
    const structural = available.filter((layer) => !layer.pointName);
    const bounds = unionBounds([
        ...structural.map(layerBounds).filter((rect): rect is NonNullable<typeof rect> => !!rect),
        ...(settings.grid ? foundation.map(([x, y]) => ({ x: x - 30, y: y - 15, width: 60, height: 30 })) : []),
    ]);
    canvas.width = Math.min(
        2048,
        Math.max(300, Math.ceil(Math.max(Math.abs(bounds.x), Math.abs(bounds.x + bounds.width)) * 2))
    );
    canvas.height = Math.min(
        2048,
        Math.max(240, Math.ceil(Math.max(Math.abs(bounds.y), Math.abs(bounds.y + bounds.height)) * 2))
    );
    const origin = [canvas.width / 2, canvas.height / 2];
    let disposed = false,
        animation = 0,
        last = 0,
        revision = 0;
    const visible = (layer: (typeof ordered)[number]) =>
        layerVisible(layer, scene, settings.sceneState, !!settings.damaged);
    const draw = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (settings.grid && scene.foundation.length) {
            ctx.strokeStyle = '#7ac3ad88';
            for (const [x, y] of foundation) {
                const px = origin[0] + x,
                    py = origin[1] + y;
                ctx.beginPath();
                ctx.moveTo(px, py - 15);
                ctx.lineTo(px + 30, py);
                ctx.lineTo(px, py + 15);
                ctx.lineTo(px - 30, py);
                ctx.closePath();
                ctx.stroke();
            }
        }
        for (const layer of ordered) {
            if (!visible(layer) || settings.layers.has(layer.id)) {
                continue;
            }
            const plane = planes.get(layer.id);
            const point = scene.points?.find((item) => item.name === layer.pointName);
            const offset = point ? buildingPoint(point.value, point.space) : [0, 0];
            if (plane) {
                ctx.drawImage(
                    plane,
                    Math.round(origin[0] + (planeOrigins.get(layer.id)?.[0] ?? 0) + layer.offset[0] + offset[0]),
                    Math.round(origin[1] + (planeOrigins.get(layer.id)?.[1] ?? 0) + layer.offset[1] + offset[1])
                );
            }
        }
        if (settings.damaged && settings.sceneState !== 'construction' && settings.showPoints && !comparison) {
            for (const point of scene.points ?? []) {
                if (point.absent) {
                    continue;
                }
                const screen = buildingPoint(point.value, point.space);
                ctx.fillStyle = point.name === settings.selectedPoint ? '#ffd166' : '#c2ccd8';
                ctx.beginPath();
                ctx.arc(origin[0] + screen[0], origin[1] + screen[1], 4, 0, Math.PI * 2);
                ctx.fill();
                ctx.font = '11px sans-serif';
                ctx.fillText(point.name, origin[0] + screen[0] + 8, origin[1] + screen[1] - 6);
            }
        }
        const viewport = canvas.parentElement!;
        const fitScale =
            settings.sceneFit !== false
                ? Math.min(1, viewport.clientWidth / canvas.width, viewport.clientHeight / canvas.height)
                : 1;
        canvas.style.width = canvas.width * settings.zoom * fitScale + 'px';
        canvas.style.height = canvas.height * settings.zoom * fitScale + 'px';
    };
    const renderers = available.map((layer) => {
        const worker = new Worker(workerUrl);
        workers.push(worker);
        if (layer.media) {
            worker.postMessage({
                type: 'load',
                bytes: fromBase64(layer.media.bytes),
                file: layer.media.file,
                palette: layer.media.palette,
                cacheBudget: Math.floor((32 * 1024 * 1024) / available.length),
            });
        }
        if (layer.voxel) {
            worker.postMessage({ type: 'load-voxel', media: layer.voxel });
        }
        let busy = false,
            expected = 0,
            signature = '';
        let queued:
            | {
                  type: string;
                  id: number;
                  frame?: number;
                  shadow?: boolean;
                  color: number[];
                  remap?: boolean;
                  trim?: boolean;
                  heading?: number;
              }
            | undefined;
        const send = () => {
            if (!busy && queued && !disposed) {
                busy = true;
                worker.postMessage(queued);
                queued = undefined;
            }
        };
        worker.onmessage = (event) => {
            busy = false;
            send();
            if (disposed || event.data.id !== expected) {
                return;
            }
            if (event.data.type === 'error') {
                failed(layer.name + ': ' + event.data.error);
                return;
            }
            const plane = document.createElement('canvas');
            plane.width = event.data.width;
            plane.height = event.data.height;
            plane.getContext('2d')!.putImageData(new ImageData(event.data.rgba, plane.width, plane.height), 0, 0);
            planeOrigins.set(
                layer.id,
                layer.voxel
                    ? [event.data.x, event.data.y]
                    : [event.data.x - layer.media!.file.width / 2, event.data.y - layer.media!.file.height / 2]
            );
            planes.set(layer.id, plane);
            draw();
        };
        return {
            layer,
            request: (message: NonNullable<typeof queued>) => {
                const next = JSON.stringify([
                    message.type,
                    message.frame,
                    message.shadow,
                    message.remap,
                    message.color,
                    message.heading,
                ]);
                if (next === signature) {
                    return;
                }
                signature = next;
                expected = message.id;
                queued = message;
                send();
            },
        };
    });
    const update = () => {
        revision++;
        for (const { layer, request } of renderers) {
            if (!visible(layer) || settings.layers.has(layer.id)) {
                continue;
            }
            if (layer.voxel) {
                request({
                    type: 'voxel',
                    id: revision,
                    color: settings.color,
                    heading: (settings.turret * Math.PI) / 180,
                });
            } else {
                request({
                    type: 'frame',
                    id: revision,
                    frame: layerFrame(layer, scene.kind, settings.frame, !!settings.damaged),
                    shadow: settings.shadow && layer.media!.shadow,
                    color: settings.color,
                    remap: layer.remap ?? layer.media?.remap ?? false,
                    trim: true,
                });
            }
        }
        draw();
    };
    let drag: { id: string; start: number[]; x: number; y: number } | undefined;
    const coordinates = (event: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        return [
            ((event.clientX - rect.left) * canvas.width) / rect.width - origin[0],
            ((event.clientY - rect.top) * canvas.height) / rect.height - origin[1],
        ];
    };
    const down = (event: PointerEvent) => {
        if (event.button !== 0 || comparison || !settings.damaged || !settings.showPoints) {
            return;
        }
        const [x, y] = coordinates(event);
        const point = (scene.points ?? [])
            .filter((item) => !item.absent)
            .map((item) => ({ item, screen: buildingPoint(item.value, item.space) }))
            .sort((a, b) => Math.hypot(a.screen[0] - x, a.screen[1] - y) - Math.hypot(b.screen[0] - x, b.screen[1] - y))
            .find((entry) => Math.hypot(entry.screen[0] - x, entry.screen[1] - y) < 10);
        if (!point) {
            return;
        }
        event.stopPropagation();
        drag = { id: point.item.id, start: [...point.item.value], x, y };
        settings.selectedPoint = point.item.name;
        canvas.setPointerCapture(event.pointerId);
        changed();
        draw();
    };
    const move = (event: PointerEvent) => {
        if (!drag) {
            return;
        }
        const point = scene.points!.find((item) => item.id === drag!.id)!;
        const [x, y] = coordinates(event);
        point.value = moveBuildingPoint(drag.start, point.space, x - drag.x, y - drag.y);
        draw();
        changed();
    };
    const up = () => {
        if (drag) {
            const point = scene.points!.find((item) => item.id === drag!.id)!;
            if (point.value.some((value, axis) => value !== drag!.start[axis])) {
                edit(point.id, point.value);
            }
            drag = undefined;
        }
    };
    const cancel = () => {
        if (drag) {
            scene.points!.find((item) => item.id === drag!.id)!.value = drag.start;
            drag = undefined;
            draw();
            changed();
        }
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    const observer = new ResizeObserver(draw);
    observer.observe(canvas.parentElement!);
    const tick = (time: number) => {
        if (disposed) {
            return;
        }
        if (!comparison && settings.playing && !document.hidden && time - last >= 1000 / settings.fps) {
            last = time;
            settings.frame = (settings.frame + 1) % 100000;
            update();
        }
        animation = requestAnimationFrame(tick);
    };
    update();
    animation = requestAnimationFrame(tick);
    return {
        update,
        dispose: () => {
            disposed = true;
            cancelAnimationFrame(animation);
            workers.forEach((worker) => worker.terminate());
            observer.disconnect();
            canvas.removeEventListener('pointerdown', down);
            canvas.removeEventListener('pointermove', move);
            canvas.removeEventListener('pointerup', up);
            canvas.removeEventListener('pointercancel', cancel);
        },
        capture: () => ({
            width: canvas.width,
            height: canvas.height,
            pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        }),
    };
}
