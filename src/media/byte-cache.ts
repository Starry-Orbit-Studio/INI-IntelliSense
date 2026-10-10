/** A byte-budgeted LRU. Eviction never invalidates values already held by a caller. */
export class ByteCache<T> {
    private entries = new Map<string, { value: T; bytes: number }>();
    private used = 0;

    constructor(private readonly budget: number) {}

    public get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    public set(key: string, value: T, bytes: number): void {
        this.delete(key);
        if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.budget) {
            return;
        }
        this.entries.set(key, { value, bytes });
        this.used += bytes;
        while (this.used > this.budget) {
            this.delete(this.entries.keys().next().value!);
        }
    }

    public delete(key: string): void {
        const entry = this.entries.get(key);
        if (entry) {
            this.used -= entry.bytes;
            this.entries.delete(key);
        }
    }

    public clear(): void {
        this.entries.clear();
        this.used = 0;
    }
    public get byteLength(): number {
        return this.used;
    }
}
