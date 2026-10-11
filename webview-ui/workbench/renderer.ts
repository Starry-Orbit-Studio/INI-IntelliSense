import { voxelTransform, normalTransform, transformPoint } from '../../src/media/voxel-math';
import type { MediaPayload } from '../../src/context/workbench-protocol';
import { nativeLight, authoredLight, GAME_LIGHT_FRAME } from '../../src/media/voxel-light';
import { voxelCamera, orbitVoxelCamera } from '../../src/media/voxel-camera';
import { spriteBounds } from '../../src/media/sprite-raster';
import { spriteClip } from '../../src/media/sprite-playback';

export interface ViewSettings {
    frame: number;
    direction: number;
    fps: number;
    zoom: number;
    color: number[];
    action: number;
    playing: boolean;
    shadow: boolean;
    mode: string;
    yaw: number;
    pitch: number;
    turret: number;
    fireAngle?: number;
    light: number[];
    fixed: boolean;
    slice: number;
    hidden: Set<string>;
    grid: boolean;
    fire: boolean;
    flhScale: number;
    fit: boolean;
    lightGizmo: boolean;
    sceneState: string;
    layers: Set<string>;
    showPoints: boolean;
    selectedPoint: string;
    pan?: number[];
    damaged?: boolean;
    sceneFit?: boolean;
}
export interface Renderer {
    update(): void;
    dispose(): void;
    capture(): { pixels: Uint8ClampedArray; width: number; height: number };
}

export function fromBase64(value: string): Uint8Array {
    const decoded = atob(value),
        bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
        bytes[i] = decoded.charCodeAt(i);
    }
    return bytes;
}

export function imageRenderer(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    bytes: Uint8Array,
    settings?: ViewSettings
): Renderer {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    const pixels = new Uint8ClampedArray(bytes);
    context.putImageData(new ImageData(pixels, width, height), 0, 0);
    const update = () => {
        canvas.style.width = width * (settings?.zoom ?? 1) + 'px';
    };
    update();
    return { update, dispose: () => undefined, capture: () => ({ pixels, width, height }) };
}

export function spriteRenderer(
    media: Extract<MediaPayload, { kind: 'sprite' }>,
    canvas: HTMLCanvasElement,
    settings: ViewSettings,
    workerUrl: string,
    changed: (frame: number) => void,
    failed: (error: string) => void,
    comparison = false
): Renderer {
    const bounds = spriteBounds(media.file);
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    const context = canvas.getContext('2d')!;
    const worker = new Worker(workerUrl);
    let id = 0,
        animation = 0,
        last = 0,
        disposed = false;
    let pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
    worker.postMessage({ type: 'load', bytes: fromBase64(media.bytes), file: media.file, palette: media.palette });
    worker.onmessage = (event) => {
        if (disposed || event.data.id !== id) {
            return;
        }
        if (event.data.type === 'error') {
            failed(event.data.error);
            return;
        }
        pixels = event.data.rgba;
        context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
        changed(event.data.frame);
    };
    worker.onerror = (event) => failed(event.message);
    const update = () => {
        const action = media.actions[settings.action]?.action;
        const index = spriteClip(media.file.frames.length, media.shadow, action, settings.direction).frame(
            settings.frame
        );
        if (index < 0 || index >= media.file.frames.length) {
            failed('Sequence exceeds available frames: ' + index);
            return;
        }
        const frame = index;
        worker.postMessage({
            type: 'frame',
            id: ++id,
            frame,
            shadow: settings.shadow,
            color: settings.color,
            remap: media.remap === true,
            trim: true,
        });
        canvas.style.width = canvas.width * settings.zoom + 'px';
    };
    const tick = (time: number) => {
        if (disposed) {
            return;
        }
        if (!comparison && settings.playing && !document.hidden && time - last >= 1000 / settings.fps) {
            const action = media.actions[settings.action]?.action;
            const count = spriteClip(media.file.frames.length, media.shadow, action, settings.direction).count;
            settings.frame = (settings.frame + 1) % count;
            last = time;
            update();
        }
        animation = requestAnimationFrame(tick);
    };
    update();
    animation = requestAnimationFrame(tick);
    return {
        update,
        capture: () => ({ pixels, width: canvas.width, height: canvas.height }),
        dispose: () => {
            disposed = true;
            cancelAnimationFrame(animation);
            worker.terminate();
        },
    };
}

type Vec = [number, number, number];
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function transform(matrix: number[], vector: number[], translation = true): Vec {
    return [0, 1, 2].map(
        (row) =>
            matrix[row * 4] * vector[0] +
            matrix[row * 4 + 1] * vector[1] +
            matrix[row * 4 + 2] * vector[2] +
            (translation ? matrix[row * 4 + 3] : 0)
    ) as Vec;
}
function rotate(point: number[], angle: number): Vec {
    const c = Math.cos(angle),
        s = Math.sin(angle);
    return [point[0] * c - point[1] * s, point[0] * s + point[1] * c, point[2]];
}

/** Instanced voxel cubes retain authored normals and palette/VPL lookups. */
export function voxelRenderer(
    media: Extract<MediaPayload, { kind: 'voxel' }>,
    canvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    settings: ViewSettings,
    edit: (id: string, values: number[]) => void,
    changed: () => void = () => undefined,
    comparison = false
): Renderer {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) {
        throw new Error('WebGL 2 is unavailable.');
    }
    const shader = (type: number, source: string) => {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(log ?? 'Shader compilation failed.');
        }
        return shader;
    };
    const vertex = shader(
        gl.VERTEX_SHADER,
        '#version 300 es\nprecision highp float;\n' +
            'layout(location=0) in vec3 corner; layout(location=1) in vec3 position; layout(location=2) in float colorIndex; layout(location=3) in vec3 normal;\n' +
            'uniform mat4 projection; uniform mat4 model; uniform mat3 normalMatrix; uniform vec3 light; uniform vec3 eye; uniform vec3 house;\n' +
            'uniform sampler2D palette; uniform sampler2D vpl; uniform float remapStart; uniform float remapEnd; uniform int mode; uniform float cut; uniform bool fixedLight;\n' +
            'out vec3 pixelColor; out float visible;\nvoid main(){\n' +
            'vec4 world=model*vec4(position+corner,1.0); gl_Position=projection*world;\n' +
            'vec3 n=normalize(normalMatrix*normal); float f1=max(0.0,dot(n,light)); vec3 secondary=light+(fixedLight?vec3(0):eye); vec3 halfVector=length(secondary)>0.000001?normalize(secondary):vec3(0); float h=dot(n,halfVector);\n' +
            'int level=int(clamp(floor(16.0*(f1+max(0.0,h/(3.0-2.0*h)))),0.0,31.0)); int index=int(colorIndex);\n' +
            'if(mode!=2){index=int(texelFetch(vpl,ivec2(index,min(level,textureSize(vpl,0).y-1)),0).r*255.0+0.5);}\n' +
            'pixelColor=texelFetch(palette,ivec2(index,0),0).rgb;\n' +
            'if(float(index)>=remapStart && float(index)<=remapEnd){pixelColor=house*(0.28+0.72*(remapEnd-float(index))/max(1.0,remapEnd-remapStart));}\n' +
            'if(mode==2){pixelColor=n*0.5+0.5;}\n' +
            'visible=(mode!=3 || abs(position.z-cut)<0.5)?1.0:0.0;\n}'
    );
    const fragment = shader(
        gl.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;\nin vec3 pixelColor; in float visible; out vec4 outputColor;\n' +
            'void main(){if(visible<0.5){discard;} outputColor=vec4(pixelColor,1.0);}'
    );
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? 'Shader link failed.');
    }
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    const buffers: WebGLBuffer[] = [],
        vaos: WebGLVertexArrayObject[] = [],
        textures: WebGLTexture[] = [];
    const faces = [
        [0, 1, 2, 0, 2, 3],
        [4, 6, 5, 4, 7, 6],
        [0, 4, 5, 0, 5, 1],
        [3, 2, 6, 3, 6, 7],
        [1, 5, 6, 1, 6, 2],
        [0, 3, 7, 0, 7, 4],
    ];
    const corners = [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
    ];
    const cube = new Float32Array(faces.flat().flatMap((index) => corners[index]));
    const attribute = (location: number, data: Float32Array, size: number, divisor: number) => {
        const buffer = gl.createBuffer()!;
        buffers.push(buffer);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(location, divisor);
    };
    const limbs = media.model.parts.map((part, index) => {
        const vao = gl.createVertexArray()!;
        vaos.push(vao);
        gl.bindVertexArray(vao);
        const positions: number[] = [],
            colors: number[] = [],
            normals: number[] = [];
        for (let i = 0; i < part.voxels.length; i += 5) {
            positions.push(...part.voxels.slice(i, i + 3));
            colors.push(part.voxels[i + 3]);
            const normal = part.voxels[i + 4] * 3;
            normals.push(media.normals[normal] ?? 0, media.normals[normal + 1] ?? 0, media.normals[normal + 2] ?? 1);
        }
        attribute(0, cube, 3, 0);
        attribute(1, new Float32Array(positions), 3, 1);
        attribute(2, new Float32Array(colors), 1, 1);
        attribute(3, new Float32Array(normals), 3, 1);
        return { part, vao, count: colors.length, id: index + ':' + part.name };
    });
    const texture = (unit: number, width: number, height: number, channels: number, values: number[]) => {
        const texture = gl.createTexture()!;
        textures.push(texture);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            channels === 3 ? gl.RGB8 : gl.R8,
            width,
            height,
            0,
            channels === 3 ? gl.RGB : gl.RED,
            gl.UNSIGNED_BYTE,
            new Uint8Array(values)
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.uniform1i(gl.getUniformLocation(program, channels === 3 ? 'palette' : 'vpl'), unit);
    };
    texture(0, 256, 1, 3, media.palette);
    texture(1, 256, Math.max(1, media.vpl.length / 256), 1, media.vpl);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
    let center = [0, 0, 0],
        extent = 1;
    const fit = () => {
        min.fill(Infinity);
        max.fill(-Infinity);
        for (const part of media.model.parts) {
            const matrix = voxelTransform(
                part,
                settings.frame,
                (settings.turret * Math.PI) / 180,
                settings.fireAngle === undefined ? undefined : (settings.fireAngle * Math.PI) / 128
            );
            for (let corner = 0; corner < 8; corner++) {
                const point = transformPoint(
                    matrix,
                    part.size.map((size, axis) => (corner & (1 << axis) ? size : 0))
                );
                point.forEach((value, axis) => {
                    min[axis] = Math.min(min[axis], value);
                    max[axis] = Math.max(max[axis], value);
                });
            }
        }
        center = min.map((value, axis) => (value + max[axis]) / 2);
        extent = Math.max(...max.map((value, axis) => value - min[axis]), 1);
    };
    const ctx = overlay.getContext('2d')!;
    let animation = 0,
        last = 0,
        disposed = false;
    let handles: { id: string; axis: number; x: number; y: number; dx: number; dy: number; distance: number }[] = [];
    let drag:
        | { id: string; axis: number; start: number[]; x: number; y: number; dx: number; dy: number; distance: number }
        | undefined;
    let orbit: { x: number; y: number; yaw: number; pitch: number; pan: number[]; panning: boolean } | undefined;
    let lightDrag: { x: number; y: number; start: number[] } | undefined;
    let hoveredPoint = '';
    const camera = () => {
        return voxelCamera(
            settings,
            center,
            max.map((value, axis) => value - min[axis]),
            canvas.width,
            canvas.height
        );
    };
    const project = (point: number[]) => {
        return camera().project(point);
    };
    const pointWorld = (value: number[]) => {
        const offset = media.model.parts.find((part) => part.role === 'turret')?.offset ?? [0, 0, 0];
        return rotate(
            value.map((v) => v / settings.flhScale),
            (settings.turret * Math.PI) / 180
        ).map((v, axis) => v + offset[axis]);
    };
    const update = () => {
        fit();
        const width = Math.max(200, canvas.parentElement?.clientWidth ?? 600);
        const height = Math.max(96, Math.round(canvas.clientHeight || 380));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            overlay.width = width;
            overlay.height = height;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(program);
        gl.uniformMatrix4fv(uniform('projection'), false, camera().matrix);
        const length = Math.hypot(...settings.light) || 1;
        gl.uniform3fv(
            uniform('light'),
            nativeLight(settings.light).map((value) => value / length)
        );
        gl.uniform3fv(uniform('eye'), [0, 0, 1]);
        gl.uniform3fv(
            uniform('house'),
            settings.color.map((value) => value / 255)
        );
        gl.uniform1f(uniform('remapStart'), media.model.remapStart);
        gl.uniform1f(uniform('remapEnd'), media.model.remapEnd);
        gl.uniform1i(uniform('mode'), settings.mode === 'normal' ? 2 : settings.mode === 'slice' ? 3 : 0);
        gl.uniform1f(uniform('cut'), settings.slice);
        gl.uniform1i(uniform('fixedLight'), settings.fixed ? 1 : 0);
        for (const { part, vao, count, id } of limbs) {
            if (settings.hidden.has(id)) {
                continue;
            }
            const native = voxelTransform(
                part,
                settings.frame,
                (settings.turret * Math.PI) / 180,
                settings.fireAngle === undefined ? undefined : (settings.fireAngle * Math.PI) / 128
            );
            const model = new Float32Array([
                native[0],
                native[4],
                native[8],
                0,
                native[1],
                native[5],
                native[9],
                0,
                native[2],
                native[6],
                native[10],
                0,
                native[3],
                native[7],
                native[11],
                1,
            ]);
            gl.uniformMatrix4fv(uniform('model'), false, model);
            gl.uniformMatrix3fv(uniform('normalMatrix'), false, new Float32Array(normalTransform(native)));
            gl.bindVertexArray(vao);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
        }
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        handles = [];
        if (settings.grid) {
            ctx.strokeStyle = 'rgba(128,128,128,0.25)';
            ctx.lineWidth = 1;
            for (let line = -2; line <= 2; line++) {
                const k = (line * extent) / 4;
                for (const ends of [
                    [
                        [k, -extent / 2, 0],
                        [k, extent / 2, 0],
                    ],
                    [
                        [-extent / 2, k, 0],
                        [extent / 2, k, 0],
                    ],
                ]) {
                    const a = project(ends[0]),
                        b = project(ends[1]);
                    ctx.beginPath();
                    ctx.moveTo(...(a as [number, number]));
                    ctx.lineTo(...(b as [number, number]));
                    ctx.stroke();
                }
            }
        }
        for (const point of settings.showPoints
            ? [...media.points].sort(
                  (a, b) => Number(a.name === settings.selectedPoint) - Number(b.name === settings.selectedPoint)
              )
            : []) {
            const world = pointWorld(point.value),
                screen = project(world);
            if (!screen.every(Number.isFinite)) {
                continue;
            }
            const selected = point.name === settings.selectedPoint;
            ctx.fillStyle = selected ? '#ffd166' : '#c2ccd8';
            ctx.beginPath();
            ctx.arc(screen[0], screen[1], selected ? 4 : 2.5, 0, Math.PI * 2);
            ctx.fill();
            if (selected || point.id === hoveredPoint) {
                ctx.font = '11px sans-serif';
                ctx.fillText(point.name, screen[0] + 9, screen[1] - 7);
            }
            if (!selected) {
                continue;
            }
            for (let axis = 0; axis < 3; axis++) {
                const native = [...point.value];
                native[axis] += settings.flhScale;
                const basis = project(pointWorld(native));
                const projectedUnit = Math.hypot(basis[0] - screen[0], basis[1] - screen[1]);
                if (projectedUnit < 0.01) {
                    continue;
                }
                const distance = (44 / projectedUnit) * settings.flhScale;
                native[axis] = point.value[axis] + distance;
                const end = pointWorld(native);
                const projected = project(end),
                    dx = projected[0] - screen[0],
                    dy = projected[1] - screen[1];
                if (!projected.every(Number.isFinite)) {
                    continue;
                }
                ctx.strokeStyle = ['#f87070', '#7ddc91', '#72b9ff'][axis];
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(screen[0], screen[1]);
                ctx.lineTo(projected[0], projected[1]);
                ctx.stroke();
                ctx.fillStyle = ctx.strokeStyle;
                ctx.beginPath();
                ctx.arc(projected[0], projected[1], 3, 0, Math.PI * 2);
                ctx.fill();
                handles.push({ id: point.id, axis, x: projected[0], y: projected[1], dx, dy, distance });
            }
            if (settings.fire) {
                const end = project(
                    pointWorld([point.value[0] + extent * settings.flhScale, point.value[1], point.value[2]])
                );
                ctx.strokeStyle = '#ffd166';
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(screen[0], screen[1]);
                ctx.lineTo(end[0], end[1]);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
        if (settings.lightGizmo && !comparison) {
            const x = overlay.width - 58,
                y = 58,
                light = nativeLight(settings.light);
            const length = Math.hypot(...light) || 1;
            ctx.strokeStyle = '#ffd166';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, 36, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = '#ffd16666';
            for (const rotation of [0, Math.PI / 2]) {
                ctx.beginPath();
                ctx.ellipse(x, y, 36, 12, rotation, 0, Math.PI * 2);
                ctx.stroke();
            }
            const view = GAME_LIGHT_FRAME;
            const lx = light.reduce((sum, value, axis) => sum + value * view.right[axis], 0) / length;
            const ly = light.reduce((sum, value, axis) => sum + value * view.up[axis], 0) / length;
            const front = light.reduce((sum, value, axis) => sum + value * view.eye[axis], 0) >= 0;
            ctx.strokeStyle = front ? '#ffd166' : '#ffd16666';
            ctx.setLineDash(front ? [] : [3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + lx * 30, y - ly * 30);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#ffd166';
            ctx.beginPath();
            ctx.arc(x + lx * 30, y - ly * 30, 5, 0, Math.PI * 2);
            front ? ctx.fill() : ctx.stroke();
        }
    };
    const coordinates = (event: PointerEvent) => {
        const rect = overlay.getBoundingClientRect();
        return [
            ((event.clientX - rect.left) * overlay.width) / rect.width,
            ((event.clientY - rect.top) * overlay.height) / rect.height,
        ];
    };
    const down = (event: PointerEvent) => {
        if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
            return;
        }
        // Prevent Chromium's middle-button autoscroll from competing with viewport pan.
        event.preventDefault();
        const [x, y] = coordinates(event);
        if (
            settings.lightGizmo &&
            event.button === 0 &&
            !event.shiftKey &&
            Math.hypot(x - (overlay.width - 58), y - 58) <= 40
        ) {
            lightDrag = {
                x,
                y,
                start: [...settings.light],
            };
            overlay.setPointerCapture(event.pointerId);
            return;
        }
        // At native game scale the axis handles are close together; select the nearest, not the first hit.
        const canPick = settings.showPoints && event.button === 0 && !event.shiftKey;
        const direct = canPick
            ? media.points
                  .map((point) => ({ point, screen: project(pointWorld(point.value)) }))
                  .sort(
                      (a, b) =>
                          Math.hypot(a.screen[0] - x, a.screen[1] - y) - Math.hypot(b.screen[0] - x, b.screen[1] - y) ||
                          Number(b.point.name === settings.selectedPoint) -
                              Number(a.point.name === settings.selectedPoint)
                  )
                  .find((item) => Math.hypot(item.screen[0] - x, item.screen[1] - y) <= 12)
            : undefined;
        const handle =
            direct || !canPick
                ? undefined
                : [...handles]
                      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))
                      .find((item) => Math.hypot(item.x - x, item.y - y) < 12);
        if (handle) {
            drag = { ...handle, start: [...media.points.find((point) => point.id === handle.id)!.value], x, y };
            settings.playing = false;
        } else {
            const point =
                direct ??
                (canPick
                    ? media.points
                          .map((point) => ({ point, screen: project(pointWorld(point.value)) }))
                          .sort(
                              (a, b) =>
                                  Math.hypot(a.screen[0] - x, a.screen[1] - y) -
                                  Math.hypot(b.screen[0] - x, b.screen[1] - y)
                          )
                          .find((item) => Math.hypot(item.screen[0] - x, item.screen[1] - y) <= 8)
                    : undefined);
            if (point) {
                settings.selectedPoint = point.point.name;
                drag = { id: point.point.id, axis: -1, start: [...point.point.value], x, y, dx: 0, dy: 0, distance: 0 };
                settings.playing = false;
                update();
                changed();
            } else {
                orbit = {
                    x,
                    y,
                    yaw: settings.yaw,
                    pitch: settings.pitch,
                    pan: [...(settings.pan ?? [0, 0, 0])],
                    panning: event.button === 1 || event.button === 2 || event.shiftKey,
                };
            }
        }
        overlay.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
        const [x, y] = coordinates(event);
        if (lightDrag) {
            const turn = (vector: number[], axis: readonly number[], angle: number) => {
                const c = Math.cos(angle),
                    s = Math.sin(angle);
                const dot = vector.reduce((sum, value, index) => sum + value * axis[index], 0);
                const cross = [
                    axis[1] * vector[2] - axis[2] * vector[1],
                    axis[2] * vector[0] - axis[0] * vector[2],
                    axis[0] * vector[1] - axis[1] * vector[0],
                ];
                return vector.map((value, index) => value * c + cross[index] * s + axis[index] * dot * (1 - c));
            };
            const view = GAME_LIGHT_FRAME;
            settings.light = authoredLight(
                turn(
                    turn(nativeLight(lightDrag.start), view.up, (x - lightDrag.x) / 36),
                    view.right,
                    (y - lightDrag.y) / 36
                )
            );
            update();
            changed();
        } else if (drag) {
            const point = media.points.find((point) => point.id === drag!.id)!;
            const length = drag.dx * drag.dx + drag.dy * drag.dy;
            if (drag.axis === -1) {
                const delta = rotate(
                    camera().screenDelta(pointWorld(drag.start), x - drag.x, y - drag.y),
                    (-settings.turret * Math.PI) / 180
                );
                point.value = drag.start.map((value, axis) => Math.round(value + delta[axis] * settings.flhScale));
            } else if (length > 0.01) {
                const fraction = ((x - drag.x) * drag.dx + (y - drag.y) * drag.dy) / length;
                const end = [...drag.start];
                end[drag.axis] += drag.distance;
                const view = camera(),
                    startW = view.clipW(pointWorld(drag.start)),
                    endW = view.clipW(pointWorld(end));
                const denominator = endW - fraction * (endW - startW);
                if (Math.abs(denominator) > 0.001) {
                    point.value[drag.axis] = Math.round(
                        drag.start[drag.axis] + (drag.distance * fraction * startW) / denominator
                    );
                }
            }
            update();
            changed();
        } else if (orbit) {
            if (orbit.panning) {
                const delta = camera().screenDelta(center, x - orbit.x, y - orbit.y);
                settings.pan = orbit.pan.map((value, axis) => value - delta[axis]);
            } else {
                Object.assign(settings, orbitVoxelCamera(orbit.yaw, orbit.pitch, x - orbit.x, y - orbit.y));
            }
            update();
        } else {
            const point = settings.showPoints
                ? media.points.find((point) => {
                      const screen = project(pointWorld(point.value));
                      return Math.hypot(screen[0] - x, screen[1] - y) <= 8;
                  })
                : undefined;
            if ((point?.id ?? '') !== hoveredPoint) {
                hoveredPoint = point?.id ?? '';
                update();
            }
        }
    };
    const up = () => {
        if (drag) {
            const point = media.points.find((point) => point.id === drag!.id)!;
            const changed = point.value.some((value, i) => value !== drag!.start[i]);
            if (changed) {
                edit(point.id, [...point.value]);
            }
        }
        drag = undefined;
        orbit = undefined;
        lightDrag = undefined;
    };
    const wheel = (event: WheelEvent) => {
        event.preventDefault();
        settings.zoom = Math.max(0.2, Math.min(8, settings.zoom * (event.deltaY < 0 ? 1.1 : 0.9)));
        update();
    };
    overlay.addEventListener('pointerdown', down);
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
    overlay.addEventListener('pointercancel', () => {
        if (drag) {
            media.points.find((point) => point.id === drag!.id)!.value = [...drag.start];
        }
        if (lightDrag) {
            settings.light = lightDrag.start;
        }
        drag = undefined;
        orbit = undefined;
        lightDrag = undefined;
        update();
        changed();
    });
    overlay.addEventListener('wheel', wheel, { passive: false });
    overlay.addEventListener('contextmenu', (event) => event.preventDefault());
    const observer = new ResizeObserver(update);
    observer.observe(canvas.parentElement!);
    const tick = (time: number) => {
        if (disposed) {
            return;
        }
        if (!comparison && settings.playing && !document.hidden && time - last > 1000 / settings.fps) {
            settings.frame++;
            last = time;
            update();
            changed();
        }
        animation = requestAnimationFrame(tick);
    };
    update();
    animation = requestAnimationFrame(tick);
    return {
        update,
        capture: () => {
            const buffer = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
            const pixels = new Uint8ClampedArray(buffer.length);
            for (let y = 0; y < canvas.height; y++) {
                pixels.set(
                    buffer.subarray(y * canvas.width * 4, (y + 1) * canvas.width * 4),
                    (canvas.height - 1 - y) * canvas.width * 4
                );
            }
            return { pixels, width: canvas.width, height: canvas.height };
        },
        dispose: () => {
            disposed = true;
            cancelAnimationFrame(animation);
            observer.disconnect();
            buffers.forEach((buffer) => gl.deleteBuffer(buffer));
            vaos.forEach((vao) => gl.deleteVertexArray(vao));
            textures.forEach((texture) => gl.deleteTexture(texture));
            gl.deleteProgram(program);
            gl.deleteShader(vertex);
            gl.deleteShader(fragment);
        },
    };
}
