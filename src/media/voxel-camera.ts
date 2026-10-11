export interface CameraOptions {
    yaw: number;
    pitch: number;
    zoom: number;
    mode: string;
    fit: boolean;
    pan?: number[];
}
const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);

/** Z-up camera shared by rendering, picking and screen-plane point manipulation. */
export function voxelCamera(options: CameraOptions, center: number[], size: number[], width: number, height: number) {
    const yaw = (options.yaw * Math.PI) / 180,
        pitch = (options.pitch * Math.PI) / 180;
    const c = Math.cos(yaw),
        s = Math.sin(yaw),
        p = Math.sin(pitch),
        q = Math.cos(pitch);
    const right = [c, -s, 0],
        up = [-s * p, -c * p, q],
        eye = [s * q, c * q, p];
    const target = center.map((value, axis) => value + (options.pan?.[axis] ?? 0));
    const aspect = width / Math.max(1, height);
    const extent = Math.max(1, Math.hypot(...size));
    const perspective = options.mode === 'perspective';
    const f = 1 / Math.tan(Math.PI / 8);
    const distance = (extent * 1.6) / options.zoom;
    const near = Math.max(0.01, distance / 1000),
        far = distance + extent * 10;
    const horizontal = dot(right.map(Math.abs), size),
        vertical = dot(up.map(Math.abs), size);
    const scale = options.fit
        ? (1.6 * options.zoom) / Math.max(horizontal / aspect, vertical, 1)
        : (2 * options.zoom) / height;
    const sx = perspective ? f / aspect : scale / aspect,
        sy = perspective ? f : scale;
    const depth = perspective ? (far + near) / (far - near) : 1 / (extent * 4);
    const row0 = right.map((value) => value * sx),
        row1 = up.map((value) => value * sy);
    const row2 = eye.map((value) => -value * depth),
        row3 = perspective ? eye.map((value) => -value) : [0, 0, 0];
    const offsets = [-dot(row0, target), -dot(row1, target), -dot(row2, target), 1];
    if (perspective) {
        offsets[2] += distance * depth - (2 * far * near) / (far - near);
        offsets[3] = distance + dot(eye, target);
    }
    const matrix = new Float32Array([
        row0[0],
        row1[0],
        row2[0],
        row3[0],
        row0[1],
        row1[1],
        row2[1],
        row3[1],
        row0[2],
        row1[2],
        row2[2],
        row3[2],
        ...offsets,
    ]);
    const project = (point: number[]) => {
        const relative = point.map((value, axis) => value - target[axis]);
        const w = perspective ? distance - dot(eye, relative) : 1;
        if (perspective && w <= near) {
            return [Infinity, Infinity];
        }
        return [(((dot(right, relative) * sx) / w + 1) * width) / 2, ((1 - (dot(up, relative) * sy) / w) * height) / 2];
    };
    const screenDelta = (point: number[], dx: number, dy: number) => {
        const depthAtPoint = perspective
            ? distance -
              dot(
                  eye,
                  point.map((value, axis) => value - target[axis])
              )
            : 1;
        return right.map(
            (value, axis) =>
                (value * dx * 2 * depthAtPoint) / (width * sx) - (up[axis] * dy * 2 * depthAtPoint) / (height * sy)
        );
    };
    const clipW = (point: number[]) =>
        perspective
            ? distance -
              dot(
                  eye,
                  point.map((value, axis) => value - target[axis])
              )
            : 1;
    return { matrix, project, screenDelta, right, up, eye, clipW };
}
