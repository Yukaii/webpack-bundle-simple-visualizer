import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BunRequest } from 'bun';
import { Command } from 'commander';

// --- Native Webpack Stats Interfaces (Based on provided documentation) ---

interface WebpackAssetNative {
  name: string; // The `output` filename
  size: number; // The size of the file in bytes
  chunks: (string | number)[]; // Chunk names or IDs
  chunkNames: string[];
  emitted: boolean;
  // Add other potentially useful fields from the docs if needed later
  // e.g., info: { immutable?: boolean; development?: boolean; hotModuleReplacement?: boolean; sourceFilename?: string; }
}

// Interface for native errors/warnings
interface WebpackProblem {
    message: string;
    details?: string;
    stack?: string;
    moduleName?: string;
    moduleIdentifier?: string;
    loc?: string;
    // Add other fields if necessary
}

interface WebpackStatsNative {
  version?: string;
  hash?: string;
  time?: number; // Compilation time in ms
  outputPath?: string;
  publicPath?: string;
  assets: WebpackAssetNative[]; // List of asset objects
  chunks?: unknown[]; // Use unknown instead of any[]
  modules?: unknown[]; // Use unknown instead of any[]
  entrypoints?: Record<string, unknown>; // Use unknown instead of any
  errors: WebpackProblem[]; // List of error objects
  errorsCount: number;
  warnings: WebpackProblem[]; // List of warning objects
  warningsCount: number;
  // Add other top-level fields if needed
}


// --- Utility Functions (Keep formatBytes, remove parseExcludePatterns if client-side only) ---

function formatBytes(bytes: number, decimals = 2): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'N/A'; // Handle non-finite or negative numbers
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1));
    return `${Number.parseFloat((bytes / (k ** i)).toFixed(dm))} ${sizes[i]}`;
}

// parseExcludePatterns seems to be handled client-side now, can be removed if not used elsewhere server-side.

// Type to represent either the direct stats or the multi-compiler structure
// (Not strictly needed for parsing logic below, but good for documentation)
// type WebpackStatsInput = WebpackStatsNative | { children: WebpackStatsNative[] };

// --- Core Data Processing Logic (Refactored for Native Stats) ---

async function getWebpackStatsData(statsPath: string): Promise<{ assets: WebpackAssetNative[], warnings: WebpackProblem[], errors: WebpackProblem[], statsFilePath: string, statsData: WebpackStatsNative }> { // Return the effective stats
    console.log(`Reading native webpack stats file: ${statsPath}`);
    const statsFile = Bun.file(statsPath);
    if (!(await statsFile.exists())) {
        throw new Error(`Stats file not found at ${statsPath}`);
    }

    let rawStats: unknown; // Start with unknown for safety
    let effectiveStats: WebpackStatsNative;

    try {
        rawStats = await statsFile.json(); // Parse as unknown first

        // Check if rawStats is an object
        if (typeof rawStats !== 'object' || rawStats === null) {
            throw new Error("Stats JSON is not an object.");
        }

        // Type guard for multi-compiler structure
        // We need to check 'children' exists and is an array before accessing it
        if ('children' in rawStats && Array.isArray(rawStats.children) && rawStats.children.length > 0) {
            console.log("Detected multi-compiler stats format, using first child.");
            const firstChild = rawStats.children[0];
            // Check if the first child is a valid stats object before assigning
            if (typeof firstChild === 'object' && firstChild !== null && 'assets' in firstChild && Array.isArray(firstChild.assets)) {
                 // We assume the first child conforms to WebpackStatsNative structure
                 effectiveStats = firstChild as WebpackStatsNative;
            } else {
                 throw new Error("First child in multi-compiler stats is not a valid stats object (missing 'assets' array?).");
            }
        // Check if it looks like a single stats object (has 'assets' array directly)
        } else if ('assets' in rawStats && Array.isArray(rawStats.assets)) {
             console.log("Detected single-compiler stats format.");
             // We assume the top-level object conforms to WebpackStatsNative
             effectiveStats = rawStats as WebpackStatsNative;
        } else {
             // Handle cases where the structure doesn't match expected formats
             throw new Error("Unrecognized stats JSON structure: Missing 'assets' array at top level or in first child.");
        }

        // Validation and defaults (now applied to the confirmed effectiveStats)
        // The 'assets' array existence is already checked above, but this is fine.
        if (!Array.isArray(effectiveStats.assets)) {
             throw new Error("Invalid stats format: 'assets' array not found in effective stats object.");
        }
        // Ensure errors/warnings are arrays even if missing or null in the JSON
        effectiveStats.errors = Array.isArray(effectiveStats.errors) ? effectiveStats.errors : [];
        effectiveStats.warnings = Array.isArray(effectiveStats.warnings) ? effectiveStats.warnings : [];
        // Calculate counts if not present
        effectiveStats.errorsCount = effectiveStats.errorsCount ?? effectiveStats.errors.length;
        effectiveStats.warningsCount = effectiveStats.warningsCount ?? effectiveStats.warnings.length;

    } catch (error) {
        // Catch parsing errors or validation/structure errors
        if (error instanceof Error && (error.message.startsWith("Invalid stats format:") || error.message.startsWith("Unrecognized stats JSON structure:") || error.message.startsWith("Stats JSON is not an object.") || error.message.startsWith("First child in multi-compiler stats"))) {
             console.error(`Stats file structure error: ${error.message}`); // Log specific error
             throw error; // Re-throw specific validation/structure errors
        }
        // Catch potential JSON parsing errors from Bun or other unexpected errors
        console.error(`Generic error processing stats file: ${error}`);
        throw new Error(`Error parsing or validating JSON from ${statsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log(`Found ${effectiveStats.assets.length} assets, ${effectiveStats.warningsCount} warnings, ${effectiveStats.errorsCount} errors.`);

    // Assets already have name and size. No need for augmentation.
    // Sort assets by size (descending) for consistency
    // Add nullish coalescing for safety in case size is missing (though unlikely based on schema)
    effectiveStats.assets.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

    return {
        assets: effectiveStats.assets,
        warnings: effectiveStats.warnings,
        errors: effectiveStats.errors,
        statsFilePath: statsPath,
        statsData: effectiveStats // Return the effective stats object
    };
}


const program = new Command();

program
    .name('webpack-bundle-visualizer')
    .description('Visualize webpack bundle stats (Native Format)')
    .version('0.2.0'); // Increment version

program.command('serve')
    .description('Serve the bundle visualizer web interface')
    .argument('<stats_file_path>', 'Path to the native webpack stats JSON file')
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

        // --- Server Configuration & Execution ---
        console.log(`Attempting to analyze bundle: ${statsFilePath}`);
        console.log(`Serving static file from: ${staticHtmlPath}`);

        try {
            // Get initial data using the new function
            const { assets: allAssets, warnings: allWarnings, errors: allErrors, statsFilePath: resolvedStatsPath } = await getWebpackStatsData(statsFilePath);

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

                    // API endpoint for table data (returns ALL assets)
                    "/api/table": async (req) => {
                        // Return the pre-loaded assets. Filtering happens client-side.
                        return Response.json(allAssets);
                    },

                    // API endpoint for configuration info (stats path, warnings, errors)
                    "/api/config": (req: BunRequest) => {
                        return Response.json({
                            statsFilePath: resolvedStatsPath,
                            warnings: allWarnings,
                            errors: allErrors // Include errors
                        });
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
            if (allWarnings.length > 0) console.warn(`Note: ${allWarnings.length} warnings found in stats file.`);
            if (allErrors.length > 0) console.error(`Error: ${allErrors.length} errors found in stats file.`);


        } catch (error) {
            // Catch errors from getWebpackStatsData or Bun.serve setup
            console.error("Failed to start server:", error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    });

// --- Export Command ---
program.command('export')
    .description('Generate a standalone HTML report with embedded native stats data')
    .argument('<stats_file_path>', 'Path to the native webpack stats JSON file')
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
            // 1. Get Stats Data using the new function
            const { assets, warnings, errors, statsFilePath: resolvedStatsPath } = await getWebpackStatsData(statsFilePath);

            // 2. Read HTML Template
            const templateHtml = readFileSync(templateHtmlPath, 'utf-8');

            // 3. Prepare Data for Injection
            const initialData = {
                statsFilePath: resolvedStatsPath,
                assets: assets, // Embed all assets
                warnings: warnings, // Embed warnings
                errors: errors, // Embed errors
                generationTime: new Date().toISOString()
            };
            // Use JSON.stringify with precautions for potential large objects or circular refs if necessary, though stats JSON usually isn't circular.
            const dataScript = `<script id="initial-data">window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};</script>`;

            // 4. Inject Data into Template
            const outputHtml = templateHtml.replace('<!-- __INITIAL_DATA_PLACEHOLDER__ -->', dataScript);

            // 5. Write Output File
            writeFileSync(outputFilePath, outputHtml);
            console.log(`✅ Report successfully generated: ${outputFilePath}`);
            if (warnings.length > 0) console.warn(`Note: ${warnings.length} warnings included in the report.`);
            if (errors.length > 0) console.error(`Error: ${errors.length} errors included in the report.`);


        } catch (error) {
             // Catch errors from getWebpackStatsData or file operations
            console.error("Error during export:", error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    });


program.parse(process.argv);
