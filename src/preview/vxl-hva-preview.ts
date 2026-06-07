import { HtmlPreview } from './preview-types';

export function createHvaPreview(bytes: Uint8Array, title: string): HtmlPreview {
    if (bytes.byteLength < 24) {
        throw new Error('Invalid HVA file.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const signature = new TextDecoder('latin1').decode(bytes.slice(0, 16)).replace(/\0+$/, '');
    const frameCount = view.getUint32(16, true);
    const sectionCount = view.getUint32(20, true);

    return {
        kind: 'html',
        title,
        bodyHtml: `
            <h2>HVA Preview</h2>
            <p>Signature: <code>${escapeHtml(signature)}</code></p>
            <p>Frames: <strong>${frameCount}</strong></p>
            <p>Sections: <strong>${sectionCount}</strong></p>
            <p>This preview currently shows animation metadata.</p>
        `,
    };
}

export function createVxlPreview(bytes: Uint8Array, title: string): HtmlPreview {
    if (bytes.byteLength < 802) {
        throw new Error('Invalid VXL file.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const signature = new TextDecoder('latin1').decode(bytes.slice(0, 16)).replace(/\0+$/, '');
    const limbCount = view.getUint32(20, true);
    const bodySize = view.getUint32(24, true);
    const remapStart = bytes[28];
    const remapEnd = bytes[29];

    return {
        kind: 'html',
        title,
        bodyHtml: `
            <h2>VXL Preview</h2>
            <p>Signature: <code>${escapeHtml(signature)}</code></p>
            <p>Limbs: <strong>${limbCount}</strong></p>
            <p>Body Size: <strong>${bodySize}</strong> bytes</p>
            <p>Remap Range: <code>${remapStart}</code> - <code>${remapEnd}</code></p>
            <p>This preview currently shows voxel metadata.</p>
        `,
    };
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
