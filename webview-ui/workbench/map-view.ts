import type { Inspection, WorkbenchLabels } from '../../src/context/workbench-protocol';

/** Read-only map inspection with bounded zoom and native source navigation. */
export function mapView(
    host: HTMLElement,
    inspection: Inspection,
    labels: WorkbenchLabels,
    post: (type: string, data?: object) => void
): void {
    const map = inspection.map!;
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
        const node = document.createElement(tag);
        node.textContent = text;
        return node;
    };
    const button = (label: string, handler: () => void) => {
        const node = make('button', label);
        node.type = 'button';
        node.onclick = handler;
        return node;
    };
    const bar = make('div');
    bar.className = 'controls';
    bar.append(
        button(labels.renderMap, () => post('render-map')),
        button(labels.refresh, () => post('refresh')),
        button(labels.configureMapRenderer, () => post('configure-map-renderer'))
    );
    host.append(bar, make('p', map.note));
    const preview = make('div');
    preview.className = 'map-viewport';
    preview.tabIndex = 0;
    if (map.preview) {
        const image = make('img');
        image.src = 'data:image/png;base64,' + map.preview;
        image.alt = map.rendered ? labels.renderMap : labels.embeddedMap;
        image.draggable = false;
        let zoom = 1,
            x = 0,
            y = 0,
            drag: { x: number; y: number; pointer: number } | undefined;
        const input = make('input');
        input.type = 'number';
        input.min = '0.1';
        input.max = '16';
        input.step = '0.1';
        input.setAttribute('aria-label', labels.zoom);
        input.value = '1';
        const update = () => {
            image.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
            input.value = String(Math.round(zoom * 100) / 100);
        };
        input.onchange = () => {
            zoom = Math.max(0.1, Math.min(16, Number(input.value) || 1));
            update();
        };
        preview.onwheel = (event) => {
            if ((event.target as HTMLElement).closest('input,button')) {
                return;
            }
            event.preventDefault();
            const rect = preview.getBoundingClientRect(),
                before = zoom;
            zoom = Math.max(0.1, Math.min(16, zoom * Math.exp(-event.deltaY * 0.001)));
            const px = event.clientX - rect.left - rect.width / 2,
                py = event.clientY - rect.top - rect.height / 2;
            x = px - ((px - x) * zoom) / before;
            y = py - ((py - y) * zoom) / before;
            update();
        };
        preview.onpointerdown = (event) => {
            if (![0, 1].includes(event.button) || (event.target as HTMLElement).closest('input,button')) {
                return;
            }
            event.preventDefault();
            drag = { x: event.clientX - x, y: event.clientY - y, pointer: event.pointerId };
            preview.setPointerCapture(event.pointerId);
        };
        preview.onpointermove = (event) => {
            if (drag) {
                x = event.clientX - drag.x;
                y = event.clientY - drag.y;
                update();
            }
        };
        const release = () => {
            if (drag && preview.hasPointerCapture(drag.pointer)) {
                preview.releasePointerCapture(drag.pointer);
            }
            drag = undefined;
        };
        preview.onpointerup = release;
        preview.onpointercancel = release;
        const tools = make('div');
        tools.className = 'viewport-tools';
        tools.append(
            input,
            button(labels.reset, () => {
                zoom = 1;
                x = y = 0;
                update();
            })
        );
        preview.append(image, tools);
        host.append(preview);
    }
    const details = make('details');
    details.append(make('summary', labels.properties));
    const table = make('table');
    map.details.forEach((value) => {
        const row = make('tr');
        row.append(make('th', value.key), make('td', value.value));
        table.append(row);
    });
    details.append(table);
    host.append(details);
    const sections = make('div');
    sections.className = 'map-sections';
    map.sections.forEach((section) =>
        sections.append(button(section.name + ' · ' + section.count, () => post('source', { id: section.id })))
    );
    host.append(make('h3', labels.mapSections), sections);
}
