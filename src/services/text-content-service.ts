export class TextContentService {
    private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: false });
    private readonly latin1Decoder = new TextDecoder('latin1', { fatal: false });
    private readonly utf8Encoder = new TextEncoder();

    public isLikelyText(bytes: Uint8Array): boolean {
        const limit = Math.min(bytes.length, 4096);
        for (let i = 0; i < limit; i++) {
            const value = bytes[i];
            if (value === 0) {
                return false;
            }
        }
        return true;
    }

    public decode(bytes: Uint8Array): string {
        try {
            return this.utf8Decoder.decode(bytes);
        } catch {
            return this.latin1Decoder.decode(bytes);
        }
    }

    public encode(text: string): Uint8Array {
        return this.utf8Encoder.encode(text);
    }
}
