import type { EffectiveProperty, SectionSource } from './project-ini';

export interface PropertyDeclaration extends EffectiveProperty {
    via: string[];
}

export interface PropertyResolution {
    effective: PropertyDeclaration;
    declarations: PropertyDeclaration[];
}

/** Resolve values and their provenance together, using the same source order. */
export function resolveProperties(
    name: string,
    sources: (name: string) => SectionSource[],
    parse: (line: string) => { key: string; value: string } | undefined,
    ancestors: string[] = []
): Map<string, PropertyResolution> {
    const result = new Map<string, PropertyResolution>();
    const expanded = new Set(ancestors.map((parent) => parent.toLowerCase()));
    const pending = [{ name, ancestors }];
    const add = (declaration: PropertyDeclaration) => {
        const key = declaration.key.toLowerCase();
        const previous = result.get(key);
        if (previous) {
            previous.declarations.push(declaration);
        } else {
            result.set(key, { effective: declaration, declarations: [declaration] });
        }
    };
    while (pending.length) {
        const current = pending.pop()!;
        const identity = current.name.toLowerCase();
        if (expanded.has(identity)) {
            continue;
        }
        // A shared ancestor contributes once through its highest-priority path.
        // Iterative traversal handles long chains and cycles without recursion.
        expanded.add(identity);
        const chain = [...current.ancestors, current.name];
        const definitions = sources(current.name);
        const files = new Map<string, SectionSource[]>();
        for (const source of definitions) {
            const id = source.document.uri.toString();
            files.set(id, [...(files.get(id) ?? []), source]);
        }
        // Last declaration within a file wins; earlier files in the source list win.
        for (const file of files.values()) {
            for (const source of [...file].reverse()) {
                for (let line = source.section.endLine; line > source.section.startLine; line--) {
                    const property = parse(source.document.lines[line]);
                    if (property) {
                        add({
                            ...property,
                            uri: source.document.uri,
                            line,
                            section: source.section.name,
                            inherited: current.ancestors.length > 0,
                            via: chain,
                        });
                    }
                }
            }
        }
        for (const parent of definitions.flatMap((source) => source.section.parentNames).reverse()) {
            pending.push({ name: parent, ancestors: chain });
        }
    }
    return result;
}
