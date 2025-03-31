import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BunRequest } from 'bun';
import { Command } from 'commander'; // Import commander

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
    // Add other relevant stats properties if needed
}

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


// --- Core Data Processing Logic (Refactored for Reuse) ---

async function getWebpackAssetsData(statsPath: string): Promise<{ assets: WebpackAsset[], warnings: { asset: WebpackAsset, warning: string }[], statsFilePath: string }> {
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
        // Ensure asset has a path property
        if (!asset.path) {
             const warning = `Asset "${asset.name}" is missing the 'path' property. Cannot determine size. Size set to 0.`;
             console.warn(`Warning: ${warning}`);
             assetsWithWarnings.push({ asset, warning });
             asset.size = 0;
             return asset;
        }

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

    const assetsWithSize = await Promise.all(assetPromises);

    // Sort assets by size (descending) for consistency
    assetsWithSize.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

    return { assets: assetsWithSize, warnings: assetsWithWarnings, statsFilePath: statsPath };
}


const program = new Command();

program
    .name('webpack-bundle-visualizer')
    .description('Visualize webpack bundle stats')
    .version('0.1.0'); // TODO: Read from package.json?

program.command('serve')
    .description('Serve the bundle visualizer web interface')
    .argument('<stats_file_path>', 'Path to the webpack stats JSON file')
    .option('-p, --port <number>', 'Port to run the server on', '3000')
    .action(async (statsFilePathArg, options) => {
        const port = Number.parseInt(options.port, 10);
        const statsFilePath = path.resolve(statsFilePathArg); // Resolve to absolute path

        if (Number.isNaN(port)) {
            console.error(`Error: Invalid port number "${options.port}"`);
            process.exit(1);
        }

        if (!existsSync(statsFilePath)) {
             console.error(`Error: Stats file not found at "${statsFilePath}"`);
             process.exit(1);
        }

        const staticHtmlPath = path.join(import.meta.dir, 'public', 'index.html');

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
            // Get initial data (but don't filter yet for the server)
            const { assets: allAssets, warnings: initialWarnings, statsFilePath: resolvedStatsPath } = await getWebpackAssetsData(statsFilePath);

            const server = Bun.serve({
                port: port,
                hostname: 'localhost', // Consider making this configurable?
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

                    // API endpoint for table data (returns ALL assets, filtering is client-side)
                    "/api/table": async (req) => {
                        // Simply return the pre-loaded assets. Filtering happens client-side.
                        // We already have `allAssets` from the initial `getWebpackAssetsData` call.
                        return Response.json(allAssets);
                        // No try-catch needed here unless `allAssets` could be invalid,
                        // but errors during initial load are handled earlier.
                    },

                    // API endpoint for configuration info
                    "/api/config": (req: BunRequest) => {
                        // Return the resolved statsFilePath and warnings from the initial load
                        return Response.json({ statsFilePath: resolvedStatsPath, warnings: initialWarnings });
                    }
                },
                // Fallback for routes not defined above
                fetch(req: Request) {
                    return new Response("Not Found", { status: 404 });
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
    });

// --- Export Command ---
program.command('export')
    .description('Generate a standalone HTML report with embedded stats data')
    .argument('<stats_file_path>', 'Path to the webpack stats JSON file')
    .option('-o, --output <path>', 'Output HTML file path', 'webpack-bundle-visualizer-report.html')
    .action(async (statsFilePathArg, options) => {
        const statsFilePath = path.resolve(statsFilePathArg);
        const outputFilePath = path.resolve(options.output);
        const templateHtmlPath = path.join(import.meta.dir, 'public', 'index.html');

        console.log(`Exporting analysis for: ${statsFilePath}`);
        console.log(`Outputting to: ${outputFilePath}`);

        if (!existsSync(statsFilePath)) {
             console.error(`Error: Stats file not found at "${statsFilePath}"`);
             process.exit(1);
        }

        try {
            // 1. Get Stats Data
            const { assets, warnings, statsFilePath: resolvedStatsPath } = await getWebpackAssetsData(statsFilePath);

            // 2. Read HTML Template
            const templateHtml = readFileSync(templateHtmlPath, 'utf-8');

            // 3. Prepare Data for Injection
            const initialData = {
                statsFilePath: resolvedStatsPath,
                assets: assets, // Embed all assets initially
                warnings: warnings, // Embed warnings
                generationTime: new Date().toISOString()
            };
            const dataScript = `<script id="initial-data">window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};</script>`;

            // 4. Inject Data into Template using HTML Comment Placeholder
            // The client-side script now handles both modes based on `window.__INITIAL_DATA__`
            const outputHtml = templateHtml.replace('<!-- __INITIAL_DATA_PLACEHOLDER__ -->', dataScript);

            // 5. Write Output File
            writeFileSync(outputFilePath, outputHtml);
            console.log(`✅ Report successfully generated: ${outputFilePath}`);

        } catch (error) {
            console.error("Error during export:", error);
            process.exit(1);
        }
    });


program.parse(process.argv);
