import { existsSync } from 'node:fs';
import path from 'node:path';

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
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    // Use Number.parseFloat, template literal, and ** operator
    return `${Number.parseFloat((bytes / (k ** i)).toFixed(dm))} ${sizes[i]}`;
}

async function analyzeBundle(statsPath: string, outputPath: string) {
  console.log(`Reading stats file: ${statsPath}`);
  const statsFile = Bun.file(statsPath);
  if (!(await statsFile.exists())) {
    console.error(`Error: Stats file not found at ${statsPath}`);
    process.exit(1);
  }

  let stats: WebpackStats;
  try {
    stats = await statsFile.json();
  } catch (error) {
    console.error(`Error parsing JSON from ${statsPath}:`, error);
    process.exit(1);
  }

  console.log('Augmenting assets with file sizes...');
  const assetsWithWarnings: { asset: WebpackAsset, warning: string }[] = [];
  const assetPromises = Object.values(stats.assets).map(async (asset) => {
    // Resolve the asset path relative to the stats file location
    const absoluteAssetPath = path.resolve(path.dirname(statsPath), asset.path);

    if (existsSync(absoluteAssetPath)) {
      const file = Bun.file(absoluteAssetPath);
      asset.size = file.size; // Bun.file().size returns size in bytes
    } else {
      const warning = `Asset file not found at ${absoluteAssetPath} (referenced by ${asset.name}).`;
      console.warn(`Warning: ${warning}`);
      assetsWithWarnings.push({ asset, warning });
      asset.size = 0; // Treat missing files as 0 size for sorting/display
    }
    return asset;
  });

  const assetsWithSize = await Promise.all(assetPromises);

  // Sort assets by size descending
  assetsWithSize.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

  // --- Generate HTML ---
  // Use const as htmlContent is only assigned once
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Webpack Bundle Analysis</title>
    <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
</head>
<body class="bg-gray-100 p-8 font-sans">
    <div class="container mx-auto bg-white p-6 rounded-lg shadow-md">
        <h1 class="text-2xl font-bold mb-4 text-gray-800">Webpack Bundle Analysis</h1>
        <p class="text-sm text-gray-600 mb-2">Generated: ${new Date().toLocaleString()}</p>
        <p class="text-sm text-gray-600 mb-4">Stats file: ${statsPath}</p>

        ${assetsWithWarnings.length > 0 ? `
        <div class="mb-4 p-4 bg-yellow-100 border border-yellow-300 rounded">
            <h2 class="font-semibold text-yellow-800 mb-2">Warnings:</h2>
            <ul class="list-disc list-inside text-sm text-yellow-700">
                ${assetsWithWarnings.map(item => `<li>${item.warning}</li>`).join('')}
            </ul>
        </div>
        ` : ''}


        <h2 class="text-xl font-semibold mb-3 text-gray-700">Asset Sizes</h2>
        <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                    <tr>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Asset Name</th>
                        <th scope="col" class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Size</th>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Visualization</th>
                    </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                    ${assetsWithSize.map(asset => {
                        const sizeBytes = asset.size ?? 0;
                        const formattedSize = formatBytes(sizeBytes);
                        const maxSize = Math.max(...assetsWithSize.map(a => a.size ?? 0)); // Recalculate or pass maxSize
                        const percentage = maxSize > 0 ? ((sizeBytes / maxSize) * 100).toFixed(1) : 0;
                        return `
                    <tr>
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 break-all">${asset.name}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 text-right">${formattedSize}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            <div class="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700">
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
</body>
</html>
  `;

  // --- Write HTML to file ---
  try {
    await Bun.write(outputPath, htmlContent);
    console.log(`Analysis complete. HTML report saved to: ${outputPath}`);
  } catch (error) {
    console.error(`Error writing HTML file to ${outputPath}:`, error);
    process.exit(1);
  }
}

// --- Configuration ---
// Read paths from command line arguments
// Usage: bun run index.ts <stats_file_path> [output_html_path]
const statsFilePath = process.argv[2];
const outputHtmlPath = process.argv[3] || 'bundle-analysis.html'; // Default output path

if (!statsFilePath) {
    console.error("Error: Please provide the path to the webpack stats JSON file.");
    console.log("Usage: bun run index.ts <stats_file_path> [output_html_path]");
    process.exit(1);
}

// --- Run Analysis ---
analyzeBundle(statsFilePath, outputHtmlPath);
