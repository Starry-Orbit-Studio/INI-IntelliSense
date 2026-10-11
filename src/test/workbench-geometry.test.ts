import * as assert from 'assert';
import { voxelCamera, orbitVoxelCamera } from '../media/voxel-camera';
import {
    nativeLight,
    authoredLight,
    DEFAULT_VOXEL_LIGHT,
    GAME_LIGHT_FRAME,
    cameraLockedLight,
} from '../media/voxel-light';
import { foundationPoints, buildingPoint, moveBuildingPoint } from '../media/building-coordinates';
import { paletteName, artPaletteName } from '../media/palette-policy';
import { spriteClip } from '../media/sprite-playback';
import { projectLighting } from '../media/project-lighting';
import { mediaCapabilities } from '../media/media-capabilities';
import { spriteRemap } from '../media/sprite-remap';

suite('Workbench projection and policy', () => {
    test('camera-locked light preserves screen direction and magnitude through arbitrary orbits', () => {
        const dot = (a: readonly number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
        for (const light of [DEFAULT_VOXEL_LIGHT, [2, -3, 1]]) {
            for (const yaw of [-180, -45, 0, 60, 270]) {
                for (const pitch of [-80, 0, 30, 85]) {
                    const world = cameraLockedLight(light, yaw, pitch);
                    const camera = voxelCamera(
                        { mode: 'game', yaw, pitch, zoom: 1, fit: false },
                        [0, 0, 0],
                        [10, 10, 10],
                        600,
                        300
                    );
                    for (const axis of ['right', 'up', 'eye'] as const) {
                        assert.ok(Math.abs(dot(camera[axis], world) - dot(GAME_LIGHT_FRAME[axis], light)) < 1e-10);
                    }
                    assert.ok(Math.abs(Math.hypot(...world) - Math.hypot(...light)) < 1e-10);
                }
            }
        }
    });
    test('SHP house colors follow the drawer rather than the format or palette filename', () => {
        assert.strictEqual(spriteRemap('techno'), true);
        assert.strictEqual(spriteRemap('animation'), false);
        assert.strictEqual(spriteRemap('animation', true), true);
        assert.strictEqual(spriteRemap('animation', false, true), true);
        for (const role of ['cameo', 'particle', 'raw'] as const) {
            assert.strictEqual(spriteRemap(role, true, true), false);
        }
    });
    test('project lighting rejects invalid vectors and shares media capability rules', () => {
        assert.deepStrictEqual(projectLighting('0.2,-0.9,-0.3', 'yes'), { light: [0.2, -0.9, -0.3], fixed: true });
        for (const value of ['0,0,0', '1,,2', 'NaN,1,2', '1,2']) {
            assert.strictEqual(projectLighting(value, 'no').light, undefined);
        }
        assert.strictEqual(mediaCapabilities('audio').palette, false);
        assert.strictEqual(mediaCapabilities('audio').export, 'audio');
        assert.strictEqual(mediaCapabilities('voxel').export, 'png');
        assert.strictEqual(mediaCapabilities('image').palette, false);
    });
    test('INI light stays in native VXL space without sign flips or axis permutations', () => {
        assert.deepStrictEqual(nativeLight(DEFAULT_VOXEL_LIGHT), DEFAULT_VOXEL_LIGHT);
        assert.deepStrictEqual(authoredLight(nativeLight([1, 2, 3])), [1, 2, 3]);
    });
    for (const mode of ['game', 'perspective']) {
        test(mode + ' orbit makes a camera-facing surface follow the horizontal and vertical pointer', () => {
            for (const yaw of [-135, -45, 0, 90]) {
                const options = { mode, yaw, pitch: 30, zoom: 1, fit: false };
                const before = voxelCamera(options, [0, 0, 0], [20, 20, 20], 600, 300);
                const surface = before.eye.map((value) => value * 10);
                for (const [dx, dy] of [
                    [-10, 0],
                    [10, 0],
                    [0, -10],
                    [0, 10],
                ]) {
                    const after = voxelCamera(
                        { ...options, ...orbitVoxelCamera(yaw, 30, dx, dy) },
                        [0, 0, 0],
                        [20, 20, 20],
                        600,
                        300
                    );
                    const start = before.project(surface),
                        end = after.project(surface);
                    assert.ok(dx ? (end[0] - start[0]) * dx > 0 : (end[1] - start[1]) * dy > 0);
                }
            }
        });
        test(mode + ' point dragging preserves screen movement and GPU projection', () => {
            const camera = voxelCamera(
                { mode, yaw: -45, pitch: 35.264, zoom: 1, fit: false },
                [3, 4, 5],
                [20, 10, 8],
                600,
                300
            );
            const point = [8, -2, 9],
                before = camera.project(point);
            const delta = camera.screenDelta(point, 32, -14),
                moved = camera.project(point.map((value, axis) => value + delta[axis]));
            assert.ok(Math.abs(moved[0] - before[0] - 32) < 0.00001);
            assert.ok(Math.abs(moved[1] - before[1] + 14) < 0.00001);
            const matrix = camera.matrix;
            const component = (row: number) =>
                matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 8] * point[2] + matrix[row + 12];
            assert.ok(Math.abs((component(0) / component(3) + 1) * 300 - before[0]) < 0.001);
            assert.ok(Math.abs((1 - component(1) / component(3)) * 150 - before[1]) < 0.001);
        });
    }
    test('light control keeps the native game frame while inspection camera orbits', () => {
        const game = voxelCamera(
            { mode: 'game', yaw: -45, pitch: 30, zoom: 1, fit: false },
            [0, 0, 0],
            [20, 20, 20],
            600,
            300
        );
        for (const axis of ['right', 'up', 'eye'] as const) {
            GAME_LIGHT_FRAME[axis].forEach((value, index) => assert.ok(Math.abs(value - game[axis][index]) < 1e-10));
        }
    });
    test('perspective foreshortens distant geometry; game view keeps native pixel scale', () => {
        const camera = voxelCamera(
            { mode: 'perspective', yaw: 0, pitch: 0, zoom: 1, fit: false },
            [0, 0, 0],
            [20, 10, 8],
            600,
            300
        );
        const near = [5, 0, 0].map((value, axis) => value + camera.eye[axis] * 8);
        const far = [5, 0, 0].map((value, axis) => value - camera.eye[axis] * 8);
        assert.ok(camera.project(near)[0] - 300 > camera.project(far)[0] - 300);
        const game = voxelCamera(
            { mode: 'game', yaw: 0, pitch: 0, zoom: 1, fit: false },
            [0, 0, 0],
            [20, 10, 8],
            600,
            300
        );
        assert.strictEqual(game.project([5, 8, 0])[0] - game.project([0, 8, 0])[0], 5);
    });
    test('game camera follows the RA2 pixel projection shared with building turrets', () => {
        const game = voxelCamera(
            { mode: 'game', yaw: -45, pitch: 30, zoom: 1, fit: false },
            [0, 0, 0],
            [100, 100, 100],
            600,
            300
        );
        const point = [20, -10, 8],
            screen = game.project(point);
        assert.ok(Math.abs(screen[0] - 300 - (point[0] + point[1]) / Math.sqrt(2)) < 0.00001);
        assert.ok(
            Math.abs(screen[1] - 150 - (point[0] - point[1]) / Math.sqrt(8) + (point[2] * Math.sqrt(3)) / 2) < 0.00001
        );
    });
    test('foundation cell centers preserve the shared game origin and half-cell offset', () => {
        const points = foundationPoints([
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
        ]);
        assert.deepStrictEqual(points, [
            [0, 15],
            [30, 30],
            [-30, 30],
            [0, 45],
        ]);
        assert.deepStrictEqual(foundationPoints([[4, 2]]), [[60, 105]]);
        const value = [100, -40, 275],
            moved = moveBuildingPoint(value, 'lepton', 30, -15);
        const start = buildingPoint(value, 'lepton'),
            end = buildingPoint(moved, 'lepton');
        assert.deepStrictEqual(
            end.map((v, axis) => v - start[axis]),
            [30, -15]
        );
        assert.strictEqual(moved[2], value[2]);
    });
    test('explicit palette wins, building children inherit, roles and theater resolve independently', () => {
        assert.strictEqual(paletteName('custom~~~', 'sno', 'animation', 'unittem.pal'), 'customsno.pal');
        assert.strictEqual(paletteName(undefined, 'tem', 'animation', 'parent.pal'), 'parent.pal');
        assert.strictEqual(paletteName(undefined, 'tem', 'animation'), 'anim.pal');
        assert.strictEqual(paletteName(undefined, 'tem', 'cameo'), 'cameo.pal');
        assert.strictEqual(paletteName(undefined, 'sno'), 'unitsno.pal');
        assert.strictEqual(artPaletteName(undefined, 'GACSPH', 'tem', 'unit'), 'GACSPHtem.pal');
        assert.strictEqual(artPaletteName('my~~~.pal', 'GACSPH', 'sno', 'unit'), 'mysno.pal');
    });
    test('action and direction define the same bounded clip for playback and timeline', () => {
        const action = { name: 'Walk', start: 10, count: 6, stride: 6, extra: [], raw: '' };
        const clip = spriteClip(120, true, action, 7);
        assert.strictEqual(clip.start, 52);
        assert.strictEqual(clip.count, 6);
        assert.strictEqual(clip.frame(7), 53);
        assert.strictEqual(spriteClip(120, true).count, 60);
    });
});
