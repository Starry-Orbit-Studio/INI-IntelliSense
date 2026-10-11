/** The sprite origin is the first cell's upper vertex; cell centers sit half a tile lower. */
export function foundationPoints(cells: number[][]): number[][] {
    return cells.map(([x, y]) => [(x - y) * 30, (x + y + 1) * 15]);
}
export function buildingPoint(value: number[], space?: string): number[] {
    return space === 'lepton'
        ? [((value[0] - value[1]) * 30) / 256, ((value[0] + value[1]) * 15) / 256 - (value[2] * 60) / 256]
        : value.slice(0, 2);
}
export function moveBuildingPoint(value: number[], space: string | undefined, dx: number, dy: number): number[] {
    return space === 'lepton'
        ? [
              Math.round(value[0] + (dx * 256) / 60 + (dy * 256) / 30),
              Math.round(value[1] - (dx * 256) / 60 + (dy * 256) / 30),
              value[2],
          ]
        : [Math.round(value[0] + dx), Math.round(value[1] + dy)];
}
