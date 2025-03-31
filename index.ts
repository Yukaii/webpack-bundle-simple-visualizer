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

function formatBytes(bytes: number, decimals = 2): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'N/A'; // Handle non-finite or negative numbers
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    // Ensure i is within the bounds of the sizes array
    const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1));
    // Use Number.parseFloat, template literal, and ** operator
    return `${Number.parseFloat((bytes / (k ** i)).toFixed(dm))} ${sizes[i]}`;
}

// Modified to return HTML content instead of writing to file
async function generateAnalysisHtml(statsPath: string): Promise<string> {
  console.log(`Reading stats file: ${statsPath}`);
  const statsFile = Bun.file(statsPath);
  if (!(await statsFile.exists())) {
    console.error(`Error: Stats file not found at ${statsPath}`);
    // Instead of exiting, throw an error to be caught by the caller
    throw new Error(`Stats file not found at ${statsPath}`);
  }

  let stats: WebpackStats;
  try {
    stats = await statsFile.json();
  } catch (error) {
    console.error(`Error parsing JSON from ${statsPath}:`, error);
    throw new Error(`Error parsing JSON from ${statsPath}: ${error}`);
  }

  console.log('Augmenting assets with file sizes...');
  const assetsWithWarnings: { asset: WebpackAsset, warning: string }[] = [];
  const assetPromises = Object.values(stats.assets).map(async (asset) => {
    // Resolve the asset path relative to the stats file location
    const absoluteAssetPath = path.resolve(path.dirname(statsPath), asset.path);

    if (existsSync(absoluteAssetPath)) {
      const file = Bun.file(absoluteAssetPath);
      // TODO: Investigate TS error 'Property 'size' does not exist on type 'BunFile'' - casting to any as workaround
      // biome-ignore lint/suspicious/noExplicitAny: BunFile type definition seems incomplete, size property exists at runtime.
      asset.size = (file as any).size; // Bun.file().size returns size in bytes
    } else {
      const warning = `Asset file not found at ${absoluteAssetPath} (referenced by ${asset.name}). Size set to 0.`;
      console.warn(`Warning: ${warning}`);
      assetsWithWarnings.push({ asset, warning });
      asset.size = 0; // Treat missing files as 0 size for sorting/display
    }
    return asset;
  });

  const assetsWithSize = await Promise.all(assetPromises);

  // Sort assets by size descending
  assetsWithSize.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  const maxSize = Math.max(...assetsWithSize.map(a => a.size ?? 0)); // Calculate maxSize once

  // --- Generate HTML ---
  // Using backticks for the template literal
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Webpack Bundle Analysis</title>
    <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
    <style>
      /* Add styles for hidden rows */
      .hidden-row { display: none; }
      /* Ensure body padding doesn't interfere with sticky header */
      body { padding-top: 0 !important; }
      /* Custom scrollbar styling (optional) */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        ::-webkit-scrollbar-track {
            background: #f1f1f1;
            border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb {
            background: #888;
            border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: #555;
        }
    </style>
</head>
<body class="bg-gray-100 font-sans">
    <div class="container mx-auto bg-white p-6 rounded-lg shadow-md my-8"> {/* Added my-8 for spacing */}
        <h1 class="text-2xl font-bold mb-4 text-gray-800">Webpack Bundle Analysis</h1>
        <p class="text-sm text-gray-600 mb-2">Generated: ${new Date().toLocaleString()}</p>
        <p class="text-sm text-gray-600 mb-4">Stats file: ${statsPath}</p>

        {/* Filter Controls - Moved back to correct HTML location */}
        <div class="mb-4 p-4 bg-gray-50 border border-gray-200 rounded flex flex-wrap gap-4 items-center">
            <div class="flex items-center">
                <input type="checkbox" id="filterSmall" class="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 mr-2" />
                <label for="filterSmall" class="text-sm text-gray-700">Hide assets &lt; 1KB</label>
            </div>
            <div class="flex-grow min-w-[200px]">
                 <label for="excludePatterns" class="sr-only">Exclude patterns</label>
                 <input type="text" id="excludePatterns" placeholder="Exclude patterns (e.g., node_modules/, .map$)" class="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500" title="Comma-separated list of strings or /regex/ patterns to exclude" />
            </div>
        </div>

        ${assetsWithWarnings.length > 0 ? `
        <div class="mb-4 p-4 bg-yellow-100 border border-yellow-300 rounded">
            <h2 class="font-semibold text-yellow-800 mb-2">Warnings:</h2>
            <ul class="list-disc list-inside text-sm text-yellow-700">
                ${assetsWithWarnings.map(item => `<li>${item.warning}</li>`).join('')}
            </ul>
        </div>
        ` : ''}

        <h2 class="text-xl font-semibold mb-3 text-gray-700">Asset Sizes</h2>
        {/* Added max-h-[70vh] for vertical scroll */}
        <div class="overflow-auto relative max-h-[70vh] border border-gray-200 rounded">
            <table class="min-w-full divide-y divide-gray-200">
                {/* Added sticky top-0 z-10 bg-gray-50 */}
                <thead class="sticky top-0 z-10 bg-gray-50">
                    <tr>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Asset Name</th>
                        <th scope="col" class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Size</th>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Visualization</th>
                    </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                    ${assetsWithSize.length === 0 ? `
                    <tr>
                        <td colspan="3" class="px-6 py-4 text-center text-gray-500">No assets found in stats file.</td>
                    </tr>
                    ` : assetsWithSize.map(asset => {
                        const sizeBytes = asset.size ?? 0;
                        const formattedSize = formatBytes(sizeBytes);
                        // Use pre-calculated maxSize
                        const percentage = maxSize > 0 ? ((sizeBytes / maxSize) * 100).toFixed(1) : 0;
                        // Add data attributes for filtering
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
                    }).join('')}
                </tbody>
            </table>
        </div>
    </div>

    <script>
        // Ensure script runs after DOM is loaded
        document.addEventListener('DOMContentLoaded', () => {
            const filterSmallCheckbox = document.getElementById('filterSmall'); // No need for TS cast here
            const excludePatternsInput = document.getElementById('excludePatterns'); // No need for TS cast here
            const tableBody = document.querySelector('table tbody');

            // Check if elements exist before proceeding
            if (!filterSmallCheckbox || !excludePatternsInput || !tableBody) {
                console.error("Filter controls or table body not found!");
                return;
            }
            const tableRows = tableBody.querySelectorAll('tr');

            // Standard JS function, no TS annotations needed inside script tag
            function parseExcludePatterns(patternsString) {
                if (!patternsString) { return []; }
                return patternsString.split(',')
                    .map(p => p.trim())
                    .filter(p => p) // Remove empty strings
                    .map(p => {
                        // Check if it looks like a regex (starts and ends with /)
                        if (p.startsWith('/') && p.endsWith('/')) {
                            try {
                                // Attempt to create a RegExp object, removing the slashes
                                return new RegExp(p.slice(1, -1));
                            } catch (e) {
                                console.warn('Invalid regex pattern ignored: ' + p, e);
                                return null; // Ignore invalid regex
                            }
                        }
                        // Otherwise, treat as a simple string includes check
                        return p;
                    })
                    .filter(p => p !== null); // Simplified filter
            }

            function filterAssets() {
                // Add null checks again just in case
                if (!filterSmallCheckbox || !excludePatternsInput || !tableBody) { return; }

                const filterSmall = filterSmallCheckbox.checked;
                const excludePatternsRaw = excludePatternsInput.value;
                const excludeFilters = parseExcludePatterns(excludePatternsRaw);
                const minSize = 1024; // 1KB

                tableRows.forEach(row => {
                    // Ensure row is an HTMLElement to access dataset
                    if (!(row instanceof HTMLElement)) return;

                    let size = Number.parseInt(row.dataset.sizeBytes || '0', 10);
                    if (Number.isNaN(size)) { size = 0; } // Ensure size is a number
                    const name = row.dataset.assetName || '';
                    let hidden = false;

                    // Check size filter
                    if (filterSmall && size < minSize) {
                        hidden = true;
                    }

                    // Check exclude patterns only if not already hidden by size
                    if (!hidden && excludeFilters.length > 0) {
                        for (const filter of excludeFilters) {
                            if (filter instanceof RegExp) {
                                if (filter.test(name)) {
                                    hidden = true;
                                    break; // Stop checking patterns if one matches
                                }
                            } else if (typeof filter === 'string') {
                                if (name.includes(filter)) {
                                    hidden = true;
                                    break; // Stop checking patterns if one matches
                                }
                            }
                        }
                    }

                    // Apply visibility
                    if (hidden) {
                        row.classList.add('hidden-row');
                    } else {
                        row.classList.remove('hidden-row');
                    }
                });
            } // Removed semicolon here, not needed after function block

            // Add event listeners
            filterSmallCheckbox.addEventListener('input', filterAssets);
            excludePatternsInput.addEventListener('input', filterAssets);

            // Initial filter application on load
            filterAssets(); // Removed semicolon here, not needed after function call
        });
    </script>
</body>
</html>
`; // End of template literal

  return htmlContent;
}

// --- Configuration ---
const statsFilePath = process.argv[2];
const port = Number.parseInt(process.argv[3] || '3000', 10); // Default port 3000

if (!statsFilePath) {
    console.error("Error: Please provide the path to the webpack stats JSON file.");
    console.log("Usage: bun run index.ts <stats_file_path> [port]");
    process.exit(1);
}

// --- Run Analysis and Start Server ---
console.log(`Attempting to analyze bundle: ${statsFilePath}`);

try {
    // Generate the HTML content once on startup
    const analysisHtml = await generateAnalysisHtml(statsFilePath);
    console.log("Bundle analysis complete. Starting server...");

    const server = Bun.serve({
        port: port,
        hostname: 'localhost', // Explicitly set hostname
        fetch(req): Response | Promise<Response> {
            const url = new URL(req.url);
            if (url.pathname === '/') {
                return new Response(analysisHtml, {
                    headers: { 'Content-Type': 'text/html' },
                });
            }
            // Fallback for any other path
            return new Response('Not Found', { status: 404 });
        },
        error(error: Error): Response | Promise<Response> {
            console.error("Server error:", error);
            return new Response("Internal Server Error", { status: 500 });
        },
    });

    console.log(`Server running at http://${server.hostname}:${server.port}`);
    console.log(`Serving analysis for: ${statsFilePath}`);

} catch (error) {
    console.error("Failed to generate analysis or start server:", error);
    process.exit(1); // Exit if initial analysis fails
}
