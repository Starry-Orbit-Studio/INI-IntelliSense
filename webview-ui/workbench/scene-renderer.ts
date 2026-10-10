import type { MediaPayload } from '../../src/context/workbench-protocol';
import { Renderer, ViewSettings, fromBase64 } from './renderer';

/** Composites decoded sprite planes in one canvas, with independent state and layer visibility. */
export function sceneRenderer(
    media: Extract<MediaPayload, { kind: 'sprite' }>,
    canvas: HTMLCanvasElement,
    settings: ViewSettings,
    workerUrl: string,
    failed: (message: string) => void,
    comparison = false
): Renderer {
    const scene = media.scene!;
    const ctx = canvas.getContext('2d')!;
    const planes = new Map<string, HTMLCanvasElement>();
    const workers: Worker[] = [];
    const ordered = [...scene.layers].sort((a, b) => b.z - a.z);
    const available = ordered.filter((layer) => layer.media);
    canvas.width = Math.min(
        1600,
        Math.max(300, ...available.map((layer) => layer.media!.file.width + Math.abs(layer.offset[0]) * 2))
    );
    canvas.height = Math.min(
        1200,
        Math.max(240, ...available.map((layer) => layer.media!.file.height + Math.abs(layer.offset[1]) * 2))
    );
    let disposed = false,
        animation = 0,
        last = 0,
        revision = 0;
    const visible = (layer: (typeof ordered)[number]) => {
        if (settings.sceneState === 'construction') {
            return layer.state === 'construction';
        }
        if (
            settings.sceneState === 'damaged' &&
            layer.state === 'normal' &&
            ordered.some((other) => other.tag.toLowerCase() === (layer.tag + 'Damaged').toLowerCase() && other.media)
        ) {
            return false;
        }
        return layer.state === settings.sceneState || (layer.state === 'normal' && settings.sceneState !== 'next');
    };
    const draw = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (settings.grid && scene.foundation.length) {
            ctx.strokeStyle = '#7ac3ad88';
            for (const [x, y] of scene.foundation) {
                const px = canvas.width / 2 + (x - y) * 30,
                    py = canvas.height / 2 + (x + y) * 15;
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
            if (plane) {
                ctx.drawImage(
                    plane,
                    Math.round((canvas.width - plane.width) / 2 + layer.offset[0]),
                    Math.round((canvas.height - plane.height) / 2 + layer.offset[1])
                );
            }
        }
        canvas.style.width = canvas.width * settings.zoom + 'px';
        canvas.style.height = canvas.height * settings.zoom + 'px';
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
                    ? Math.min(settings.sceneState === 'damaged' ? 1 : 0, limit - 1)
                    : start + (settings.frame % Math.max(1, end - start));
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
        },
        capture: () => ({
            width: canvas.width,
            height: canvas.height,
            pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        }),
    };
}
