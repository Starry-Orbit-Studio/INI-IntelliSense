import * as vscode from 'vscode';
import { normalizeMixPath } from '../core/path-utils';

export interface DecodedMixUri {
    containerUri: vscode.Uri;
    nestedChain: string[];
    virtualPath: string;
}

interface MixUriPayload {
    container: string;
    chain?: string[];
}

export class MixUriCodec {
    public static readonly scheme = 'ra2mix';

    public static toRootUri(containerUri: vscode.Uri, nestedChain: string[] = []): vscode.Uri {
        return vscode.Uri.from({
            scheme: MixUriCodec.scheme,
            path: '/',
            query: MixUriCodec.encodePayload({
                container: containerUri.toString(),
                chain: nestedChain,
            }),
        });
    }

    public static toChildUri(rootUri: vscode.Uri, virtualPath: string): vscode.Uri {
        const decoded = MixUriCodec.decode(rootUri);
        return vscode.Uri.from({
            scheme: MixUriCodec.scheme,
            path: normalizePath(virtualPath),
            query: MixUriCodec.encodePayload({
                container: decoded.containerUri.toString(),
                chain: decoded.nestedChain,
            }),
        });
    }

    public static toNestedRootUri(fileUri: vscode.Uri): vscode.Uri {
        const decoded = MixUriCodec.decode(fileUri);
        const segments = decoded.virtualPath.split('/').filter(Boolean);
        const leaf = segments.at(-1);
        if (!leaf) {
            return MixUriCodec.toRootUri(decoded.containerUri, decoded.nestedChain);
        }

        return MixUriCodec.toRootUri(decoded.containerUri, [...decoded.nestedChain, decoded.virtualPath.slice(1)]);
    }

    public static decode(uri: vscode.Uri): DecodedMixUri {
        if (uri.scheme !== MixUriCodec.scheme) {
            throw new Error(`Unsupported scheme: ${uri.scheme}`);
        }

        const payload = MixUriCodec.decodePayload(uri.query);
        return {
            containerUri: vscode.Uri.parse(payload.container),
            nestedChain: payload.chain ?? [],
            virtualPath: normalizePath(uri.path || '/'),
        };
    }

    private static encodePayload(payload: MixUriPayload): string {
        return encodeURIComponent(JSON.stringify(payload));
    }

    private static decodePayload(query: string): MixUriPayload {
        const payload = JSON.parse(decodeURIComponent(query)) as MixUriPayload;
        if (
            !payload ||
            typeof payload.container !== 'string' ||
            (payload.chain !== undefined &&
                (!Array.isArray(payload.chain) ||
                    payload.chain.length > 32 ||
                    payload.chain.some((segment) => typeof segment !== 'string' || normalizeMixPath(segment) === '/')))
        ) {
            throw new Error('Invalid MIX address.');
        }
        return payload;
    }
}

function normalizePath(value: string): string {
    return normalizeMixPath(value);
}
