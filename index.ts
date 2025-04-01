import { existsSync } from 'node:fs'; // Removed readFileSync and writeFileSync
import path from 'node:path';
import type { BunRequest } from 'bun';
import { Command } from 'commander';
import staticHtmlContent from './public/index.html' with { type: 'text' }; // Import HTML content directly
import staticWorkerContent from './public/filter.worker.js' with { type: 'text' }; // Import Worker content directly

// --- Native Webpack Stats Interfaces (Based on provided documentation) ---

interface WebpackAssetNative {
  name: string; // The `output` filename
  size: number; // The size of the file in bytes
  chunks: (string | number)[]; // Chunk names or IDs
  chunkNames: string[];
  emitted: boolean;
  // Add other potentially useful fields from the docs if needed later
  // e.g., info: { immutable?: boolean; development?: boolean; hotModuleReplacement?: boolean; sourceFilename?: string; }
  // Added from inspection
  filteredAssets?: number;
  filteredModules?: number;
}

// --- Detailed Interfaces based on test/webpack-stats.json ---
interface WebpackReason {
    moduleId: number | string | null; // Can be number or string ID
    moduleIdentifier: string | null;
    module: string | null;
    moduleName: string | null;
    type: string;
    userRequest: string;
    loc: string;
}

interface WebpackModuleNative {
    id: number | string; // Can be number or string
    identifier: string;
    name: string; // Often relative path
    index: number;
    index2: number;
    size: number;
    cacheable: boolean;
    built: boolean;
    optional: boolean;
    prefetched: boolean;
    chunks: (string | number)[]; // Chunk IDs
    assets: string[]; // Asset names associated directly? (Usually empty)
    issuer: string | null; // Module identifier that imported this
    issuerId: number | string | null;
    issuerName: string | null; // Module name that imported this
    failed: boolean;
    errors: number;
    warnings: number;
    reasons: WebpackReason[];
    usedExports: boolean | string[]; // Can be boolean or array of strings
    providedExports: string[] | null;
    optimizationBailout: string[];
    depth: number;
    source?: string; // Source code (optional)
    modules?: WebpackModuleNative[]; // Added: For concatenated modules
}

interface WebpackChunkNative {
    id: number | string;
    rendered: boolean;
    initial: boolean;
    entry: boolean;
    extraAsync: boolean;
    size: number; // Size of the modules in the chunk
    names: string[];
    files: string[]; // Asset filenames generated from this chunk
    hash: string;
    parents: (string | number)[];
    modules?: WebpackModuleNative[]; // Modules included in this chunk (Optional based on stats detail level)
    filteredModules?: number;
    origins: unknown[]; // Use unknown for complex/untyped fields
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
  chunks?: WebpackChunkNative[]; // Use detailed type
  modules?: WebpackModuleNative[]; // Use detailed type
  entrypoints?: Record<string, { chunks: (string|number)[], assets: string[] }>; // More specific type
  errors: WebpackProblem[]; // List of error objects
  errorsCount?: number; // Make optional, will calculate if missing
  warnings: WebpackProblem[]; // List of warning objects
  warningsCount?: number; // Make optional, will calculate if missing
  // Add other top-level fields if needed
  children?: WebpackStatsNative[]; // For multi-compiler
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

// --- Core Data Processing Logic (Refactored for Native Stats & Module Info) ---

// Return the full stats data now, as we need modules/chunks later
async function getWebpackStatsData(statsPath: string): Promise<{ statsData: WebpackStatsNative, statsFilePath: string }> {
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

        // Determine the effective stats object.
        // Prioritize top-level if it has modules, otherwise check children.
        if ('modules' in rawStats && Array.isArray(rawStats.modules) && rawStats.modules.length > 0) {
            console.log("Detected single-compiler stats format with modules.");
            effectiveStats = rawStats as WebpackStatsNative;
        } else if ('children' in rawStats && Array.isArray(rawStats.children) && rawStats.children.length > 0) {
            console.log("Detected multi-compiler stats format.");
            // Find the first child that looks like a valid stats object with assets
            const validChild = rawStats.children.find(child =>
                typeof child === 'object' && child !== null && 'assets' in child && Array.isArray(child.assets)
            );
            if (validChild) {
                console.log("Using first valid child compilation for stats.");
                effectiveStats = validChild as WebpackStatsNative;
            } else if ('assets' in rawStats && Array.isArray(rawStats.assets)) {
                 console.warn("Multi-compiler format detected, but no valid children found. Falling back to top-level assets (module info might be missing).");
                 effectiveStats = rawStats as WebpackStatsNative; // Fallback to top-level if no valid child
            } else {
                 throw new Error("Multi-compiler stats detected, but no valid child compilation found and top-level lacks 'assets'.");
            }
        } else if ('assets' in rawStats && Array.isArray(rawStats.assets)) {
             console.log("Detected single-compiler stats format (modules might be missing).");
             effectiveStats = rawStats as WebpackStatsNative; // Likely a simpler stats file without module details
        } else {
             // Handle cases where the structure doesn't match expected formats
             throw new Error("Unrecognized stats JSON structure: Missing 'assets' array at top level or in any child compilations.");
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
    // Add nullish coalescing for safety in case size is missing
    // Ensure assets is an array before sorting
    if (Array.isArray(effectiveStats.assets)) {
        effectiveStats.assets.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    } else {
        console.warn("Effective stats object missing 'assets' array, cannot sort.");
        effectiveStats.assets = []; // Ensure it's an empty array if missing
    }
    // Ensure modules/chunks are arrays if they exist
    effectiveStats.modules = Array.isArray(effectiveStats.modules) ? effectiveStats.modules : [];
    effectiveStats.chunks = Array.isArray(effectiveStats.chunks) ? effectiveStats.chunks : [];


    console.log(`Processed stats: Found ${effectiveStats.assets.length} assets, ${effectiveStats.modules.length} modules, ${effectiveStats.chunks.length} chunks, ${effectiveStats.warningsCount} warnings, ${effectiveStats.errorsCount} errors.`);

    return {
        statsData: effectiveStats, // Return the entire processed stats object
        statsFilePath: statsPath
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

        // const staticHtmlPath = path.join(import.meta.dir, 'public', 'index.html'); // No longer needed

        // --- Server Configuration & Execution ---
        console.log(`Attempting to analyze bundle: ${statsFilePath}`);
        // console.log(`Serving static file from: ${staticHtmlPath}`); // No longer needed
        // Removed erroneous console log referencing staticHtmlPath

        try {
            // Get the full stats data
            const { statsData, statsFilePath: resolvedStatsPath } = await getWebpackStatsData(statsFilePath);
            const allAssets = statsData.assets || []; // Ensure assets is an array
            const allWarnings = statsData.warnings || [];
            const allErrors = statsData.errors || [];

            // --- Precompute Module Maps for Efficient Lookup ---
            const modulesById = new Map<string | number, WebpackModuleNative>();
            const modulesByIdentifier = new Map<string, WebpackModuleNative>();
            if (Array.isArray(statsData.modules)) {
                for (const mod of statsData.modules) {
                    if (mod.id !== null && mod.id !== undefined) { // Ensure id is present
                        modulesById.set(mod.id, mod);
                    }
                    if (mod.identifier) { // Ensure identifier is present
                        modulesByIdentifier.set(mod.identifier, mod);
                    }
                }
                console.log(`Created module maps: ${modulesById.size} by ID, ${modulesByIdentifier.size} by Identifier.`);
            } else {
                 console.warn("No top-level 'modules' array found in stats data. Dependency lookup might be incomplete.");
            }
            // --- End Module Maps ---


            // --- Helper to find modules for an asset ---
            const getModulesForAsset = (assetName: string): WebpackModuleNative[] => {
                const asset = allAssets.find(a => a.name === assetName);
                if (!asset || !statsData.chunks) return [];

                const relevantChunkIds = new Set(asset.chunks);
                const relevantModules = new Set<WebpackModuleNative>();

                if (statsData.chunks) {
                    for (const chunk of statsData.chunks) {
                        if (relevantChunkIds.has(chunk.id) && chunk.modules) {
                            for (const module of chunk.modules) {
                                relevantModules.add(module);
                            }
                        }
                    }
                }
                // Also check top-level modules if chunks don't have them detailed
                 if (relevantModules.size === 0 && statsData.modules) {
                     for (const module of statsData.modules) {
                         // Check if module is associated with any of the asset's chunks
                         if (module.chunks.some(chunkId => relevantChunkIds.has(chunkId))) {
                             relevantModules.add(module);
                         }
                     } // Removed trailing }); here
                 }

                return Array.from(relevantModules).sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
            }; // Removed trailing }); here
            // --- End Helper ---


            const server = Bun.serve({
                port: port,
                hostname: 'localhost', // Consider making this configurable?
                routes: {
                    // Serve static HTML for the root using the imported content
                    "/": (req) => {
                        return new Response(staticHtmlContent, {
                            headers: { 'Content-Type': 'text/html; charset=utf-8' }
                        });
                    },

                    // Serve the worker script using imported content
                    "/filter.worker.js": (req) => {
                        return new Response(staticWorkerContent, {
                            headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
                        });
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
                            errors: allErrors,
                            // Optionally include counts if needed by frontend
                            // warningsCount: allWarnings.length,
                            // errorsCount: allErrors.length,
                        });
                    },

                    // API endpoint for asset details (modules)
                    // Using typed BunRequest as per documentation example
                    "/api/asset-details/:assetName": (req: BunRequest<"/api/asset-details/:assetName">) => {
                         // Params are directly available on req.params with type safety
                         const { assetName: encodedAssetName } = req.params;
                         if (!encodedAssetName) {
                              console.error("Could not extract assetName from req.params.");
                              return new Response("Bad Request: Missing assetName parameter", { status: 400 });
                         }
                         const assetName = decodeURIComponent(encodedAssetName);
                         // console.log(`Requesting details for asset: ${assetName}`); // Removed log
                         const modules = getModulesForAsset(assetName);
                         if (modules.length === 0) {
                             // console.log(`No modules found for asset: ${assetName}`); // Removed log
                         }
                 return Response.json(modules);
            },

            // API endpoint for module dependencies (children)
            "/api/module-dependencies/:moduleIdOrIdentifier": (req: BunRequest<"/api/module-dependencies/:moduleIdOrIdentifier">) => {
                 const { moduleIdOrIdentifier: encodedId } = req.params;
                 if (!encodedId) {
                     return new Response("Bad Request: Missing moduleIdOrIdentifier parameter", { status: 400 });
                 }
                 const moduleIdOrIdentifier = decodeURIComponent(encodedId);
                 // console.log(`Requesting dependencies for module: ${moduleIdOrIdentifier}`);

                 let directDependencies: WebpackModuleNative[] = [];

                 // --- Revised Dependency Logic ---
                 // 1. Find the target module first
                 let targetModule: WebpackModuleNative | undefined;
                 // Try finding by ID (if it looks like a number or is a string ID like './path')
                 if (modulesById.has(moduleIdOrIdentifier)) {
                     targetModule = modulesById.get(moduleIdOrIdentifier);
                 }
                 // If not found by ID, try by identifier
                 if (!targetModule && modulesByIdentifier.has(moduleIdOrIdentifier)) {
                     targetModule = modulesByIdentifier.get(moduleIdOrIdentifier);
                 }
                 // Special case: if the ID looks like a path, try finding by name too
                 if (!targetModule && moduleIdOrIdentifier.includes('/')) {
                     targetModule = (statsData.modules || []).find(m => m.name === moduleIdOrIdentifier);
                 }


                 if (targetModule) {
                     // 2. Check if the target module itself contains concatenated modules
                     if (Array.isArray(targetModule.modules) && targetModule.modules.length > 0) {
                         // console.log(`Found ${targetModule.modules.length} concatenated modules within ${moduleIdOrIdentifier}`);
                         directDependencies = targetModule.modules;
                     } else {
                         // 3. Fallback: Find modules that list the target module as their issuer
                         // console.log(`No concatenated modules found within ${moduleIdOrIdentifier}. Searching for issuers...`);
                         const targetId = targetModule.id;
                         const targetIdentifier = targetModule.identifier;

                         if (statsData.modules) {
                             for (const potentialChild of statsData.modules) {
                                 // Check issuerId first
                                 if (targetId !== null && targetId !== undefined && potentialChild.issuerId !== null && potentialChild.issuerId !== undefined && String(potentialChild.issuerId) === String(targetId)) {
                                     directDependencies.push(potentialChild);
                                     continue;
                                 }
                                 // Fallback to checking issuer identifier string
                                 if (targetIdentifier && potentialChild.issuer === targetIdentifier) {
                                     directDependencies.push(potentialChild);
                                 }
                             }
                         }
                     }
                 } else {
                     console.warn(`Could not find target module for dependency lookup: ${moduleIdOrIdentifier}`);
                 }
                 // --- End Revised Logic ---


                 // Sort dependencies by size (descending)
                 directDependencies.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));


                 // console.log(`Found ${directDependencies.length} dependencies for ${moduleIdOrIdentifier}`); // Removed log
                 return Response.json(directDependencies);
            },
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


        } catch (error: unknown) { // Add type unknown
            // Catch errors from getWebpackStatsData or Bun.serve setup
            // Check if it's an error object before accessing message
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("Failed to start server:", errorMessage);
            process.exit(1);
        }
    }); // Removed trailing }); here


program.parse(process.argv);
