/** Use INI terminology in the UI while preserving schema identifiers for lookups. */
export function displayType(type: string): string {
    return type.toLowerCase() === 'unittype' ? 'VehicleType' : type;
}
