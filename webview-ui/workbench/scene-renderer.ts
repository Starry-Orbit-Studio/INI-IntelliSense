import type { MediaPayload } from '../../src/context/workbench-protocol';
import { Renderer, ViewSettings, fromBase64 } from './renderer';
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
    const workers: Worker[] = [];
    const ordered = [...scene.layers].sort((a, b) => b.z - a.z);
    const available = ordered.filter((layer) => layer.media);
    const foundation = foundationPoints(scene.foundation);
    const structural = available.filter((layer) => !layer.pointName);
    canvas.width = Math.min(
        1600,
        Math.max(
            300,
            ...foundation.map((point) => Math.abs(point[0]) * 2 + 60),
            ...structural.map((layer) => layer.media!.file.width + Math.abs(layer.offset[0]) * 2)
        )
    );
    canvas.height = Math.min(
        1200,
        Math.max(
            240,
            ...foundation.map((point) => Math.abs(point[1]) * 2 + 30),
            ...structural.map((layer) => layer.media!.file.height + Math.abs(layer.offset[1]) * 2)
        )
    );
    let disposed = false,
        animation = 0,
        last = 0,
        revision = 0;
    const visible = (layer: (typeof ordered)[number]) => {
        if (settings.sceneState === 'construction') {
            return layer.state === 'construction' || layer.tag === 'BibShape';
        }
        if (
            settings.damaged &&
            !layer.damaged &&
            ordered.some(
                (other) =>
                    other.damaged &&
                    other.tag.replace(/Damaged(?=\/|$)/i, '').toLowerCase() === layer.tag.toLowerCase() &&
                    other.media
            )
        ) {
            return false;
        }
        if (layer.damaged && !settings.damaged) {
            return false;
        }
        if (layer.pointName && scene.points?.find((point) => point.name === layer.pointName)?.absent) {
            return false;
        }
        return (
            layer.state === settings.sceneState ||
            (['normal', 'damaged'].includes(layer.state) && settings.sceneState !== 'next')
        );
    };
    const draw = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (settings.grid && scene.foundation.length) {
            ctx.strokeStyle = '#7ac3ad88';
            for (const [x, y] of foundation) {
                const px = canvas.width / 2 + x,
                    py = canvas.height / 2 + y;
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
                    Math.round((canvas.width - plane.width) / 2 + layer.offset[0] + offset[0]),
                    Math.round((canvas.height - plane.height) / 2 + layer.offset[1] + offset[1])
                );
            }
        }
        if (settings.damaged && settings.sceneState !== 'construction') {
            const origin = scene.points?.find((point) => point.name === 'DamageSmokeOffset');
            for (const emitter of scene.particles ?? []) {
                for (let index = 0; index < emitter.cap; index++) {
                    const age = (settings.frame + index * 7) % Math.min(emitter.lifetime, 90);
                    const seconds = age / 60;
                    const seed = Math.sin(index * 127.1 + emitter.name.length) * 43758.5453;
                    const direction = (seed - Math.floor(seed)) * Math.PI * 2;
                    const base = origin?.value ?? [0, 0, 0];
                    const point = buildingPoint(
                        [
                            base[0] + Math.cos(direction) * emitter.velocity[0] * seconds * 10,
                            base[1] + Math.sin(direction) * emitter.velocity[1] * seconds * 10,
                            base[2] + emitter.velocity[2] * seconds * 10 - 160 * seconds * seconds,
                        ],
                        'lepton'
                    );
                    const color =
                        emitter.colors[
                            Math.min(
                                emitter.colors.length - 1,
                                Math.floor((age / Math.min(emitter.lifetime, 90)) * emitter.colors.length)
                            )
                        ];
                    ctx.fillStyle = 'rgb(' + color.join(',') + ')';
                    ctx.fillRect(canvas.width / 2 + point[0], canvas.height / 2 + point[1], 2, 2);
                }
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
                ctx.arc(canvas.width / 2 + screen[0], canvas.height / 2 + screen[1], 4, 0, Math.PI * 2);
                ctx.fill();
                ctx.font = '11px sans-serif';
                ctx.fillText(point.name, canvas.width / 2 + screen[0] + 8, canvas.height / 2 + screen[1] - 6);
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
        worker.postMessage({
            type: 'load',
            bytes: fromBase64(layer.media!.bytes),
            file: layer.media!.file,
            palette: layer.media!.palette,
            cacheBudget: Math.floor((32 * 1024 * 1024) / available.length),
        });
        let busy = false;
        let queued: { type: string; id: number; frame: number; shadow: boolean; color: number[] } | undefined;
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
            if (disposed || event.data.id !== revision) {
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
            planes.set(layer.id, plane);
            draw();
        };
        return {
            layer,
            request: (message: NonNullable<typeof queued>) => {
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
            const file = layer.media!.file;
            const limit = layer.media!.shadow ? file.frames.length / 2 : file.frames.length;
            const start = Math.min(Math.max(0, layer.start), limit - 1);
            const end = layer.end > start ? Math.min(limit, layer.end) : limit;
            const frame =
                layer.tag === 'body' && scene.kind === 'building'
                    ? Math.min(settings.damaged ? 1 : 0, limit - 1)
                    : start + (Math.floor((settings.frame * (layer.rate ?? 225)) / 225) % Math.max(1, end - start));
            request({
                type: 'frame',
                id: revision,
                frame,
                shadow: settings.shadow && layer.media!.shadow,
                color: settings.color,
            });
        }
        draw();
    };
    let drag: { id: string; start: number[]; x: number; y: number } | undefined;
    const coordinates = (event: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        return [
            ((event.clientX - rect.left) * canvas.width) / rect.width - canvas.width / 2,
            ((event.clientY - rect.top) * canvas.height) / rect.height - canvas.height / 2,
        ];
    };
    const down = (event: PointerEvent) => {
        if (comparison || !settings.damaged || !settings.showPoints) {
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
