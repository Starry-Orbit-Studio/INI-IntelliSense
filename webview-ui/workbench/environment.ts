import { voxelCamera } from '../../src/media/voxel-camera';
import type { ViewSettings } from './renderer';

export type BackgroundMode = 'checker' | 'dark' | 'light' | 'image' | 'sky';

/** Personal preview scenery. It never changes lighting, palette, or exported asset pixels. */
export class PreviewEnvironment {
    public mode: BackgroundMode = 'checker';
    public name = '';
    private texture?: ImageData;
    private image?: HTMLCanvasElement;
    private revision = 0;
    private loading = 0;

    public async load(bytes: Uint8Array, mime: string, name: string): Promise<void> {
        const request = ++this.loading;
        const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer], { type: mime }));
        try {
            if (request !== this.loading) {
                return;
            }
            const scale = Math.min(1, 2048 / bitmap.width, 2048 / bitmap.height);
            const image = document.createElement('canvas');
            image.width = Math.max(1, Math.round(bitmap.width * scale));
            image.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = image.getContext('2d', { willReadFrequently: true })!;
            context.drawImage(bitmap, 0, 0, image.width, image.height);
            this.texture = context.getImageData(0, 0, image.width, image.height);
            this.image = image;
            this.name = name;
            if (this.mode !== 'sky') {
                this.mode = 'image';
            }
            this.revision++;
        } finally {
            bitmap.close();
        }
    }

    public attach(viewport: HTMLElement, settings: ViewSettings, voxel: boolean): () => void {
        const canvas = document.createElement('canvas');
        canvas.className = 'environment-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        viewport.append(canvas);
        const context = canvas.getContext('2d')!;
        let previous = '',
            frame = 0,
            disposed = false;
        const render = () => {
            if (disposed) {
                return;
            }
            frame = requestAnimationFrame(render);
            if (document.hidden) {
                return;
            }
            const rect = viewport.getBoundingClientRect();
            const signature = [
                this.mode,
                this.revision,
                rect.width,
                rect.height,
                this.mode === 'sky' && voxel ? settings.yaw : '',
                this.mode === 'sky' && voxel ? settings.pitch : '',
            ].join(':');
            if (signature === previous) {
                return;
            }
            previous = signature;
            viewport.classList.toggle('dark', this.mode === 'dark');
            viewport.classList.toggle('light', this.mode === 'light');
            canvas.hidden = !['image', 'sky'].includes(this.mode) || !this.image;
            if (canvas.hidden || !this.image || !this.texture || !rect.width || !rect.height) {
                return;
            }
            const sky = this.mode === 'sky' && voxel;
            const scale = Math.min(1, (sky ? 480 : 1600) / rect.width, (sky ? 320 : 1000) / rect.height);
            canvas.width = Math.max(1, Math.round(rect.width * scale));
            canvas.height = Math.max(1, Math.round(rect.height * scale));
            if (!sky) {
                const factor = Math.max(canvas.width / this.image.width, canvas.height / this.image.height);
                context.drawImage(
                    this.image,
                    (canvas.width - this.image.width * factor) / 2,
                    (canvas.height - this.image.height * factor) / 2,
                    this.image.width * factor,
                    this.image.height * factor
                );
                return;
            }
            // Equirectangular environment, sampled by the same 45-degree perspective
            // camera as the model. Sampling resolution is capped during interaction.
            const camera = voxelCamera(settings, [0, 0, 0], [1, 1, 1], canvas.width, canvas.height);
            const pixels = context.createImageData(canvas.width, canvas.height),
                texture = this.texture;
            const f = Math.tan(Math.PI / 8),
                aspect = canvas.width / canvas.height;
            for (let y = 0; y < canvas.height; y++) {
                const sy = (1 - (2 * (y + 0.5)) / canvas.height) * f;
                for (let x = 0; x < canvas.width; x++) {
                    const sx = ((2 * (x + 0.5)) / canvas.width - 1) * f * aspect;
                    const rx = camera.right[0] * sx + camera.up[0] * sy - camera.eye[0];
                    const ry = camera.right[1] * sx + camera.up[1] * sy - camera.eye[1];
                    const rz = camera.up[2] * sy - camera.eye[2];
                    const u = (Math.atan2(ry, rx) / (2 * Math.PI) + 1.5) % 1;
                    const v = Math.acos(Math.max(-1, Math.min(1, rz / Math.hypot(rx, ry, rz)))) / Math.PI;
                    const source =
                        (Math.min(texture.height - 1, Math.floor(v * texture.height)) * texture.width +
                            Math.floor(u * texture.width)) *
                        4;
                    const destination = (y * canvas.width + x) * 4;
                    for (let channel = 0; channel < 4; channel++) {
                        pixels.data[destination + channel] = texture.data[source + channel];
                    }
                }
            }
            context.putImageData(pixels, 0, 0);
        };
        render();
        return () => {
            disposed = true;
            cancelAnimationFrame(frame);
            canvas.remove();
        };
    }
}
