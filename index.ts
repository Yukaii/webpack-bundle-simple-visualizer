import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'bun'; // Import Server type

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

// Shared pattern parsing logic (used by server-side filtering)
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


// --- HTML Generation Functions ---

// Generates only the <tbody> inner HTML
function generateTableBodyHtml(assets: WebpackAsset[]): string {
    if (assets.length === 0) {
        return `
        <tr>
            <td colspan="3" class="px-6 py-4 text-center text-gray-500">No assets match filters.</td>
        </tr>
        `;
    }

    const maxSize = Math.max(...assets.map(a => a.size ?? 0));

    return assets.map(asset => {
        const sizeBytes = asset.size ?? 0;
        const formattedSize = formatBytes(sizeBytes);
        const percentage = maxSize > 0 ? ((sizeBytes / maxSize) * 100).toFixed(1) : 0;
        return `
        <tr data-size-bytes="${sizeBytes}" data-asset-name="${asset.name}">
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 break-all">${asset.name}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 text-right">${formattedSize}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                <div class="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700" title="${percentage}% of largest asset">
                  <div class="bg-blue-600 h-2.5 rounded-full" style="width: ${percentage}%"></div>
                </div>
            </td>
        </tr>
        `;
    }).join('');
}

// Generates the full HTML page
function generateFullPageHtml(statsPath: string, assets: WebpackAsset[], warnings: { asset: WebpackAsset, warning: string }[], minSizeKb: number, excludePatternsStr: string | null): string {
    const tableBodyContent = generateTableBodyHtml(assets);
    const initialMinSizeKbValue = minSizeKb; // Use the number directly
    const initialExcludePatternsValue = excludePatternsStr || '';

    // Escape initialExcludePatternsValue for embedding in HTML attribute and JS string
    const escapedInitialExcludePatternsValueAttr = initialExcludePatternsValue.replace(/"/g, '&quot;');
    const escapedInitialExcludePatternsValueJs = initialExcludePatternsValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');


    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Webpack Bundle Analysis</title>
    <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
    <script src="//cdnjs.cloudflare.com/ajax/libs/htmx/2.0.4/htmx.min.js" crossorigin="anonymous"></script>
    <style>
      .hidden-row { display: none; }
      body { padding-top: 0 !important; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: #f1f1f1; border-radius: 10px; }
      ::-webkit-scrollbar-thumb { background: #888; border-radius: 10px; }
      ::-webkit-scrollbar-thumb:hover { background: #555; }
      .htmx-indicator{ display:none; }
      .htmx-request .htmx-indicator{ display:inline; }
      .htmx-request.htmx-indicator{ display:inline; }
    </style>
</head>
<body class="bg-gray-100 font-sans">
    <div class="container mx-auto bg-white p-6 rounded-lg shadow-md my-8">
        <h1 class="text-2xl font-bold mb-4 text-gray-800">Webpack Bundle Analysis</h1>
        <p class="text-sm text-gray-600 mb-2">Generated: ${new Date().toLocaleString()}</p>
        <p class="text-sm text-gray-600 mb-4">Stats file: ${statsPath}</p>

        <!-- Filter Controls with HTMX -->
        <div class="mb-4 p-4 bg-gray-50 border border-gray-200 rounded flex flex-wrap gap-4 items-center">
             <div class="flex items-center">
                 <label for="minSizeKb" class="text-sm text-gray-700 mr-2">Hide assets <</label>
                 <input type="number" id="minSizeKb" name="minSizeKb" value="${initialMinSizeKbValue}" min="0" step="0.1"
                        class="w-20 px-2 py-1 text-sm border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 mr-1"
                        hx-get="/"
                        hx-trigger="input changed delay:500ms, search"
                        hx-target="#asset-table-body"
                        hx-swap="innerHTML"
                        hx-include="[name='excludePatterns'], [name='minSizeKb']"
                        hx-indicator="#loading-indicator" />
                 <span class="text-sm text-gray-700">KB</span>
            </div>
            <div class="flex-grow min-w-[200px]">
                 <label for="excludePatterns" class="sr-only">Exclude patterns (comma-separated or /regex/)</label>
                 <input type="text" id="excludePatterns" name="excludePatterns" value="${escapedInitialExcludePatternsValueAttr}"
                        placeholder="Exclude patterns (e.g., node_modules/, .map$)"
                        class="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                        title="Comma-separated list of strings or /regex/ patterns to exclude"
                        hx-get="/"
                        hx-trigger="input changed delay:500ms, search"
                        hx-target="#asset-table-body"
                        hx-swap="innerHTML"
                        hx-include="[name='minSizeKb'], [name='excludePatterns']"
                        hx-indicator="#loading-indicator" />
            </div>
            <span id="loading-indicator" class="htmx-indicator ml-2 text-sm text-gray-500">Loading...</span>
        </div>

        ${warnings.length > 0 ? `
        <div class="mb-4 p-4 bg-yellow-100 border border-yellow-300 rounded">
            <h2 class="font-semibold text-yellow-800 mb-2">Warnings:</h2>
            <ul class="list-disc list-inside text-sm text-yellow-700">
                ${warnings.map(item => `<li>${item.warning}</li>`).join('')}
            </ul>
        </div>
        ` : ''}

        <h2 class="text-xl font-semibold mb-3 text-gray-700">Asset Sizes</h2>
        <div class="overflow-auto relative max-h-[70vh] border border-gray-200 rounded">
            <table class="min-w-full divide-y divide-gray-200">
                <thead class="sticky top-0 z-10 bg-gray-50">
                    <tr>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Asset Name</th>
                        <th scope="col" class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Size</th>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Visualization</th>
                    </tr>
                </thead>
                <tbody id="asset-table-body" class="bg-white divide-y divide-gray-200">
                    ${tableBodyContent} <!-- Initial table body -->
                </tbody>
            </table>
        </div>
    </div>

    <script>
        // LocalStorage Persistence Script
        document.addEventListener('DOMContentLoaded', () => {
            const minSizeKbInput = document.getElementById('minSizeKb');
            const excludePatternsInput = document.getElementById('excludePatterns');

            // Load initial state from localStorage
            const savedMinSizeKb = localStorage.getItem('minSizeKb') || '1'; // Default to 1KB if not set
            const savedExcludePatterns = localStorage.getItem('excludePatterns') || '';

            // These variables hold the state rendered by the server based on URL params
            const initialMinSizeKb = ${initialMinSizeKbValue}; // Comes from server render
            const initialExcludePatterns = "${escapedInitialExcludePatternsValueJs}";

            let stateLoadedFromLocalStorage = false;

            // Set min size input value from localStorage if different from server render
            if (minSizeKbInput && minSizeKbInput.value !== savedMinSizeKb) {
                minSizeKbInput.value = savedMinSizeKb;
                stateLoadedFromLocalStorage = true;
            }
            // Set exclude patterns input value from localStorage if different from server render
            if (excludePatternsInput && excludePatternsInput.value !== savedExcludePatterns) {
                excludePatternsInput.value = savedExcludePatterns;
                stateLoadedFromLocalStorage = true;
            }

            // Function to save state
            function saveState() {
                if (minSizeKbInput) {
                    localStorage.setItem('minSizeKb', minSizeKbInput.value);
                }
                if (excludePatternsInput) {
                    localStorage.setItem('excludePatterns', excludePatternsInput.value);
                }
            }

            // Add event listeners to save state on change
            if (minSizeKbInput) {
                minSizeKbInput.addEventListener('input', saveState); // Use 'input' for number field
            }
            if (excludePatternsInput) {
                excludePatternsInput.addEventListener('input', saveState);
            }

            // If we loaded different state from localStorage, trigger HTMX to fetch corresponding table body
            // We need to ensure HTMX is initialized, using a small timeout is a pragmatic way
            if (stateLoadedFromLocalStorage) {
                setTimeout(() => {
                    // Trigger the element that changed last, or a default one like the text input
                    // Prefer triggering the one that actually loaded a different value
                    let elementToTrigger = null;
                    if (excludePatternsInput && excludePatternsInput.value !== initialExcludePatterns) {
                        elementToTrigger = excludePatternsInput;
                    } else if (minSizeKbInput && minSizeKbInput.value !== String(initialMinSizeKb)) { // Compare as string
                        elementToTrigger = minSizeKbInput;
                    }

                    if (elementToTrigger) {
                        console.log("State loaded from localStorage differs, triggering HTMX on:", elementToTrigger.id);
                        htmx.trigger(elementToTrigger, 'input'); // Use 'input' to respect delay
                    } else {
                         console.log("State loaded from localStorage matches server render, no HTMX trigger needed.");
                    }
                }, 100); // Small delay for safety
            } else {
                 console.log("Initial state matches localStorage, no HTMX trigger needed.");
            }
        });
    </script>
</body>
</html>
`;
}


// --- Server Configuration & Execution ---

const statsFilePath = process.argv[2];
const port = Number.parseInt(process.argv[3] || '3000', 10);
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*'; // Read from env, default to '*'

if (allowedOrigin === '*') {
    console.warn("Warning: ALLOWED_ORIGIN environment variable not set. Defaulting to allowing all origins ('*'). For production, set this to your specific frontend origin (e.g., 'http://localhost:8080').");
} else {
    console.log(`Allowing requests from origin: ${allowedOrigin}`);
}


if (!statsFilePath) {
    console.error("Error: Please provide the path to the webpack stats JSON file.");
    console.log("Usage: bun run index.ts <stats_file_path> [port]");
    process.exit(1);
}

console.log(`Attempting to analyze bundle: ${statsFilePath}`);

try {
    const server = Bun.serve({
        port: port,
        hostname: 'localhost',
        async fetch(req): Promise<Response> {
            const url = new URL(req.url);
            const isHxRequest = req.headers.get('HX-Request') === 'true';

            // Get filter params from URL
            const minSizeKbParam = url.searchParams.get('minSizeKb');
            const minSizeKb = Number.parseFloat(minSizeKbParam || '1'); // Default to 1KB if missing/invalid
            const excludePatterns = url.searchParams.get('excludePatterns'); // Keep as string | null

            if (url.pathname === '/') {
                try {
                    // Always get the filtered assets based on URL params
                    const { assets, warnings } = await getFilteredAssets(statsFilePath, Number.isNaN(minSizeKb) ? 1 : minSizeKb, excludePatterns); // Pass parsed number, default to 1 if NaN

                    if (isHxRequest) {
                        // Generate only the table body HTML
                        const tableBodyHtml = generateTableBodyHtml(assets);
                        // Use htmx.logAll() in browser console to debug headers
                        // console.log("HTMX Request - Returning Table Body");
                        return new Response(tableBodyHtml, {
                            headers: {
                                'Content-Type': 'text/html',
                                'Access-Control-Allow-Origin': allowedOrigin // Use dynamic origin
                            }
                        });
                    }
                    // Generate the full page HTML (removed redundant else)
                    // console.log("Full Page Request - Returning Full HTML");
                    // Pass the potentially adjusted minSizeKb value
                    const fullPageHtml = generateFullPageHtml(statsFilePath, assets, warnings, Number.isNaN(minSizeKb) ? 1 : minSizeKb, excludePatterns);
                    return new Response(fullPageHtml, {
                        headers: {
                            'Content-Type': 'text/html',
                            'Access-Control-Allow-Origin': allowedOrigin // Use dynamic origin
                        }
                    });

                } catch (error) {
                     console.error("Error during request processing:", error);
                     const errorMsg = error instanceof Error ? error.message : 'An unknown error occurred';
                     const status = errorMsg.includes('Stats file not found') ? 404 : 500;

                     if (isHxRequest) {
                         // Return error message within table structure for HTMX
                         return new Response(`<tr><td colspan="3" class="px-6 py-4 text-center text-red-600">Error: ${errorMsg}</td></tr>`, {
                             status: status,
                             headers: {
                                 'Content-Type': 'text/html',
                                 'Access-Control-Allow-Origin': allowedOrigin // Use dynamic origin
                             }
                         });
                     }
                     // Return a simple full error page (removed redundant else)
                     return new Response(`<html><body><h1>Error</h1><p>${errorMsg}</p></body></html>`, {
                         status: status,
                         headers: {
                             'Content-Type': 'text/html',
                             'Access-Control-Allow-Origin': allowedOrigin // Use dynamic origin
                         }
                     });
                }
            }

            // Fallback for any other path (removed redundant else)
            return new Response('Not Found', {
                status: 404,
                headers: {
                    'Access-Control-Allow-Origin': allowedOrigin // Use dynamic origin for 404s too
                }
             });
        },
        error(error: Error): Response | Promise<Response> {
            // This catches errors during server startup or connection issues
            console.error("Server startup/connection error:", error);
            return new Response("Internal Server Error", { status: 500 });
        },
    });

    console.log(`Server running at http://${server.hostname}:${server.port}`);
    console.log(`Serving analysis for: ${statsFilePath}`);

} catch (error) {
    // This might catch errors if Bun.serve itself fails immediately
    console.error("Failed to start server:", error);
    process.exit(1);
}
