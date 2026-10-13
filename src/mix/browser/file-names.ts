/** Names shared by drag uploads, transfer planning and host-side dialogs. */
export function validFileName(name: string): boolean {
    return (
        !!name &&
        name.length <= 255 &&
        name !== '.' &&
        name !== '..' &&
        !/[\\/:*?"<>|\x00-\x1f]/.test(name) &&
        !/[. ]$/.test(name) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    );
}
export function validRelativeFileName(name: string): boolean {
    return name.split('/').every(validFileName);
}
export function isRecoveryFile(name: string): boolean {
    return /\.ra2-(?:backup-|workbench\.lock)|\.ra2-.*\.tmp$/i.test(name);
}
