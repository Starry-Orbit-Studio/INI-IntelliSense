const latin1Decoder = new TextDecoder('latin1', { fatal: false });
const gbkDecoder = new TextDecoder('gbk', { fatal: false });

export function decodeLocalText(bytes: Uint8Array): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Legacy XCC databases use the system code page. */ }
    try {
        return gbkDecoder.decode(bytes);
    } catch {
        return latin1Decoder.decode(bytes);
    }
}
