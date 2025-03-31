import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BunRequest } from 'bun'; // Import BunRequest type

interface WebpackAsset {
  name: string;
  publicPath: string;
  path: string;
  size?: number; // Add size property
}

interface WebpackStats {
  status: string;
  chunks: Record<string, string[]>;
  assets: Record<string, WebpackAsset>;
  startTime: number;
  endTime: number;
}

// --- Argument Parsing & Config ---
const statsFilePath = process.argv[2];
const port = Number.parseInt(process.argv[3] || '3000', 10);

if (!statsFilePath) {
    console.error("Error: Please provide the path to the webpack stats JSON file.");
    console.log("Usage: bun run index.ts <stats_file_path> [port]");
    process.exit(1);
}

const staticHtmlPath = path.join(import.meta.dir, 'public', 'index.html'); // Path to static HTML

// --- Utility Functions ---

function formatBytes(bytes: number, decimals = 2): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'N/A'; // Handle non-finite or negative numbers
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1));
    return `${Number.parseFloat((bytes / (k ** i)).toFixed(dm))} ${sizes[i]}`;
}

function parseExcludePatterns(patternsString: string): (RegExp | string)[] {
    if (!patternsString) { return []; }
    return patternsString.split(',')
        .map(p => p.trim())
        .filter(p => p) // Remove empty strings
        .map(p => {
            if (p.startsWith('/') && p.endsWith('/')) {
                try {
                    return new RegExp(p.slice(1, -1));
                } catch (e) {
                    console.warn(`Invalid regex pattern ignored: ${p}`, e); // Use template literal
                    return null;
                }
            }
            return p;
        })
        .filter((p): p is RegExp | string => p !== null);
}

// --- Core Data Processing and Filtering ---

async function getFilteredAssets(statsPath: string, minSizeKb: number, excludePatternsStr: string | null): Promise<{ assets: WebpackAsset[], warnings: { asset: WebpackAsset, warning: string }[] }> {
    console.log(`Reading stats file: ${statsPath}`);
    const statsFile = Bun.file(statsPath);
    if (!(await statsFile.exists())) {
        throw new Error(`Stats file not found at ${statsPath}`);
    }

    let stats: WebpackStats;
    try {
        stats = await statsFile.json();
    } catch (error) {
        throw new Error(`Error parsing JSON from ${statsPath}: ${error}`);
    }

    console.log('Augmenting assets with file sizes...');
    const assetsWithWarnings: { asset: WebpackAsset, warning: string }[] = [];
    const assetPromises = Object.values(stats.assets).map(async (asset) => {
        const absoluteAssetPath = path.resolve(path.dirname(statsPath), asset.path);
        if (existsSync(absoluteAssetPath)) {
            const file = Bun.file(absoluteAssetPath);
            // biome-ignore lint/suspicious/noExplicitAny: BunFile type definition seems incomplete
            asset.size = (file as any).size;
        } else {
            const warning = `Asset file not found at ${absoluteAssetPath} (referenced by ${asset.name}). Size set to 0.`;
            console.warn(`Warning: ${warning}`);
            assetsWithWarnings.push({ asset, warning });
            asset.size = 0;
        }
        return asset;
    });

    let assetsWithSize = await Promise.all(assetPromises);

    // --- Server-Side Filtering ---
    const excludeFilters = parseExcludePatterns(excludePatternsStr || '');
    const minSizeBytes = minSizeKb * 1024; // Convert KB to Bytes

    assetsWithSize = assetsWithSize.filter(asset => {
        const size = asset.size ?? 0;
        const name = asset.name;
        let hidden = false;

        // Filter by minimum size
        if (size < minSizeBytes) {
            hidden = true;
        }

        if (!hidden && excludeFilters.length > 0) {
            for (const filter of excludeFilters) {
                if (filter instanceof RegExp) {
                    if (filter.test(name)) { hidden = true; break; }
                } else if (typeof filter === 'string') {
                    if (name.includes(filter)) { hidden = true; break; }
                }
            }
        }
        return !hidden;
    });
    // --- End Server-Side Filtering ---

    // Sort remaining assets
    assetsWithSize.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

    return { assets: assetsWithSize, warnings: assetsWithWarnings };
}

// --- Helper to get query params ---
function getFilterParams(req: BunRequest): { minSizeKb: number, excludePatterns: string | null } {
    const url = new URL(req.url);
    const minSizeKbParam = url.searchParams.get('minSizeKb');
    const minSizeKb = Number.parseFloat(minSizeKbParam || '1'); // Default to 1KB if missing/invalid
    const excludePatterns = url.searchParams.get('excludePatterns'); // Keep as string | null
    return {
        minSizeKb: Number.isNaN(minSizeKb) ? 1 : minSizeKb,
        excludePatterns
    };
}

// --- Server Configuration & Execution ---

console.log(`Attempting to analyze bundle: ${statsFilePath}`);
console.log(`Serving static file from: ${staticHtmlPath}`);

try {
    const server = Bun.serve({
        port: port,
        hostname: 'localhost',
        routes: {
            // Serve static HTML for the root
            "/": async (req) => {
                const file = Bun.file(staticHtmlPath);
                if (await file.exists()) {
                    return new Response(file, {
                        headers: { 'Content-Type': 'text/html; charset=utf-8' }
                    });
                }
                return new Response("Not Found", { status: 404 });
            },

            // API endpoint for table body HTML
            "/api/table": async (req) => {
                try {
                    const { minSizeKb, excludePatterns } = getFilterParams(req);
                    const { assets, warnings } = await getFilteredAssets(statsFilePath, minSizeKb, excludePatterns);
                    // TODO: Handle warnings - maybe return them in a wrapper object?
                    // Return assets as JSON
                    // Return assets as JSON
                    return Response.json(assets); // Use Response.json helper
                } catch (error) {
                    console.error("Error during /api/table request:", error);
                    const errorMsg = error instanceof Error ? error.message : 'An unknown error occurred';
                    const status = errorMsg.includes('Stats file not found') ? 404 : 500;
                    // Return error as JSON
                    // Return error as JSON
                    return Response.json({ error: errorMsg }, {
                        status: status
                    });
                }
            },

            // API endpoint for raw data HTML fragment
            "/api/data": async (req) => {
                try {
                    const { minSizeKb, excludePatterns } = getFilterParams(req);
                    const { assets } = await getFilteredAssets(statsFilePath, minSizeKb, excludePatterns);
                    const jsonString = JSON.stringify(assets, null, 2);
                    // Correctly escape HTML characters
                    const escapedJsonString = jsonString.replace(/</g, '<').replace(/>/g, '>'); // Use HTML entities
                    return new Response(`<pre class="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-60"><code>${escapedJsonString}</code></pre>`, {
                        headers: {
                            'Content-Type': 'text/html'
                        }
                    });
                } catch (error) {
                    console.error("Error during /api/data request:", error);
                    const errorMsg = error instanceof Error ? error.message : 'An unknown error occurred';
                    const status = errorMsg.includes('Stats file not found') ? 404 : 500;
                    return new Response(`<div class="text-red-600">Error fetching data: ${errorMsg}</div>`, {
                        status: status,
                        headers: {
                            'Content-Type': 'text/html'
                        }
                    });
                }
            },

            // API endpoint for configuration info
            // API endpoint for configuration info
            "/api/config": (req: BunRequest) => { // Add BunRequest type
                return Response.json({ statsFilePath: statsFilePath });
            }
        },
        // Fallback for routes not defined above
        // Fallback for routes not defined above
        fetch(req: Request) { // Use standard Request type here
            return new Response("Not Found", {
                status: 404
            });
        },
        error(error: Error): Response | Promise<Response> {
            console.error("Server startup/connection error:", error);
            return new Response("Internal Server Error", { status: 500 });
        },
    });

    console.log(`Server running at http://${server.hostname}:${server.port}`);
    console.log(`Serving analysis for: ${statsFilePath}`);

} catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
}
