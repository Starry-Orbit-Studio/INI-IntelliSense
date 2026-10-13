import * as vscode from 'vscode';
import { SchemaManager } from '../schema-manager';
import { ProjectIni } from './project-ini';
import { objectCatalog } from './object-catalog';
import { parsePropertyLine } from './ini-position';
import type { LogicGraph } from './workbench-protocol';

export interface IndexedLogicGraph {
    nodes: LogicGraph['nodes'];
    edges: LogicGraph['edges'];
    locations: Map<string, vscode.Location>;
    isCurrent: () => boolean;
}

/** Edges describe effective typed references, never arbitrary matching strings. */
export async function indexLogic(
    ini: ProjectIni,
    schema: SchemaManager,
    origin: vscode.Uri,
    token: vscode.CancellationToken,
    translate: (key: string) => string | undefined = () => undefined
): Promise<IndexedLogicGraph> {
    await ini.load(origin);
    const snapshot = ini.snapshot(origin),
        objects = await objectCatalog(ini, schema, origin, token, translate);
    const nodes: LogicGraph['nodes'] = [],
        edges: LogicGraph['edges'] = [],
        locations = new Map<string, vscode.Location>();
    const names = new Map<string, typeof objects>();
    for (const object of objects) {
        const id = object.category + ':' + object.name.toLowerCase();
        nodes.push({
            id,
            name: object.name,
            type: object.type,
            category: object.category,
            label: object.label,
            source: vscode.workspace.asRelativePath(object.source.document.uri),
            missing: false,
        });
        locations.set(
            id,
            new vscode.Location(object.source.document.uri, new vscode.Position(object.source.section.startLine, 0))
        );
        names.set(object.name.toLowerCase(), [...(names.get(object.name.toLowerCase()) ?? []), object]);
    }
    const nodeIds = new Set(nodes.map((node) => node.id));
    const add = (
        from: string,
        target: string,
        category: string,
        expected: string | undefined,
        key: string,
        uri: vscode.Uri,
        line: number,
        inherited: boolean,
        kind: string
    ) => {
        const candidates = (names.get(target.toLowerCase()) ?? []).filter((object) => object.category === category);
        const resolved = candidates[0];
        if (expected && resolved && resolved.type !== 'Unknown') {
            let type: string | null | undefined = resolved.type;
            const seen = new Set<string>();
            while (type && type !== expected && !seen.has(type)) {
                seen.add(type);
                type = schema.getSchema(type)?.base;
            }
            if (type !== expected) {
                kind = 'typeMismatch';
            }
        }
        const to = (resolved?.category ?? category) + ':' + target.toLowerCase();
        if (!nodeIds.has(to)) {
            nodes.push({ id: to, name: target, type: expected ?? '', category, missing: true });
            nodeIds.add(to);
        }
        const id = 'edge:' + edges.length;
        edges.push({
            id,
            from,
            to,
            key,
            inherited,
            kind,
            source: vscode.workspace.asRelativePath(uri) + ':' + (line + 1),
        });
        locations.set(id, new vscode.Location(uri, new vscode.Position(line, 0)));
    };
    for (let offset = 0; offset < objects.length; offset++) {
        if (offset % 100 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
        }
        const object = objects[offset],
            from = object.category + ':' + object.name.toLowerCase();
        for (const parent of object.source.section.parentNames) {
            add(
                from,
                parent,
                object.category,
                undefined,
                '$Inherits',
                object.source.document.uri,
                object.source.section.startLine,
                false,
                'inheritance'
            );
        }
        const keys = schema.getAllKeysForType(object.type);
        for (const [key, resolution] of object.properties) {
            const property = resolution.effective;
            let expected = schema.getProperty(object.type, key)?.type;
            const visited = new Set<string>();
            while (expected && schema.getListDefinition(expected) && !visited.has(expected)) {
                visited.add(expected);
                expected = schema.getListDefinition(expected)!.type;
            }
            let category = object.category,
                kind = 'reference';
            if (key === 'image' && object.category === 'rules') {
                category = 'art';
                expected = undefined;
                kind = 'image';
            } else if (expected === 'Sound' || /^voice(select|move|attack|feedback|specialattack)$/.test(key)) {
                category = 'sound';
                expected = 'Sound';
                kind = 'sound';
            } else if (expected && schema.isComplexType(expected)) {
                category = expected === 'AnimType' ? 'art' : 'rules';
            } else if (key === 'animation' && !expected && names.has(property.value.toLowerCase())) {
                category = 'art';
                kind = 'inferred';
            } else {
                continue;
            }
            if (/prerequisite|required|disallowed|inhibitor|designator/.test(key)) {
                kind = 'condition';
            }
            const parsed = parsePropertyLine(property.key + '=' + property.value);
            for (const value of parsed?.elements ?? []) {
                if (value.value && !/^(none|<none>)$/i.test(value.value)) {
                    add(
                        from,
                        value.value,
                        category,
                        expected,
                        property.key,
                        property.uri,
                        property.line,
                        property.inherited,
                        kind
                    );
                }
            }
        }
    }
    return { nodes, edges, locations, isCurrent: snapshot.isCurrent };
}

/** Bounded expansion retains cycles as edges and makes omitted branches explicit. */
export function logicSlice(index: IndexedLogicGraph, focus: string, direction: string, depth: number): LogicGraph {
    const selected = new Set([focus]),
        edges = new Map<string, LogicGraph['edges'][number]>();
    let frontier = new Set([focus]),
        truncated = false;
    for (let level = 0; level < depth; level++) {
        const next = new Set<string>();
        for (const edge of index.edges) {
            const outgoing = direction !== 'upstream' && frontier.has(edge.from),
                incoming = direction !== 'downstream' && frontier.has(edge.to);
            if (!outgoing && !incoming) {
                continue;
            }
            const id = outgoing ? edge.to : edge.from;
            if (!selected.has(id) && selected.size >= 150) {
                truncated = true;
                continue;
            }
            edges.set(edge.id, edge);
            if (!selected.has(id)) {
                selected.add(id);
                next.add(id);
            }
        }
        frontier = next;
    }
    if (
        index.edges.some(
            (edge) =>
                (direction !== 'upstream' && frontier.has(edge.from) && !selected.has(edge.to)) ||
                (direction !== 'downstream' && frontier.has(edge.to) && !selected.has(edge.from))
        )
    ) {
        truncated = true;
    }
    return {
        focus,
        direction,
        depth,
        truncated,
        nodes: index.nodes.filter((node) => selected.has(node.id)),
        edges: [...edges.values()],
    };
}
