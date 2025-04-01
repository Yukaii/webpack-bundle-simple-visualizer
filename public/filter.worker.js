// public/filter.worker.js

/**
 * Filters assets based on minimum size and exclusion patterns.
 * @param {Array<Object>} allAssets - The full list of asset objects.
 * @param {number} minSizeBytes - Minimum size in bytes to include.
 * @param {Array<string|RegExp>} excludeFilters - Filters (strings or regex).
 * @returns {Array<Object>} - The filtered list of assets.
 */
function filterAssets(allAssets, minSizeBytes, excludeFilters) {
    if (!Array.isArray(allAssets)) return [];

    return allAssets.filter(asset => {
        if (typeof asset !== 'object' || asset === null || typeof asset.name !== 'string') {
            console.warn("Worker: Filtering out invalid asset object:", asset);
            return false;
        }
        const size = asset.size ?? 0;
        const name = asset.name;
        let hidden = false;

        if (size < minSizeBytes) hidden = true;

        if (!hidden && excludeFilters.length > 0) {
            for (const filter of excludeFilters) {
                // Check if filter is a serialized RegExp string
                if (typeof filter === 'string' && filter.startsWith('/') && filter.endsWith('/')) {
                    try {
                        const regex = new RegExp(filter.slice(1, -1));
                        if (regex.test(name)) { hidden = true; break; }
                    } catch (e) {
                        console.warn('Worker: Invalid regex pattern received:', filter);
                    }
                } else if (typeof filter === 'string') {
                     if (name.includes(filter)) { hidden = true; break; }
                 }
                 // Note: Actual RegExp objects cannot be directly passed to workers,
                 // so we handle string representations.
            }
        }
        return !hidden;
    });
}

/**
 * Calculates the total size and percentage for each asset in a list.
 * @param {Array<Object>} assets - List of asset objects.
 * @returns {{processedAssets: Array<Object>, totalSize: number}} - Assets with added 'percentage' property and the total size.
 */
function calculatePercentages(assets) {
    const totalSize = assets.reduce((sum, asset) => sum + (asset.size ?? 0), 0);
    const processedAssets = assets.map(asset => {
        const sizeBytes = asset.size ?? 0;
        let percentage = 0;
        if (totalSize > 0 && sizeBytes > 0) {
            percentage = Math.max(0, Math.min(100, (sizeBytes / totalSize) * 100));
        }
        return {
            ...asset,
            percentage: percentage.toFixed(1) // Add percentage property
        };
    });
    return { processedAssets, totalSize };
}

// Listen for messages from the main thread
self.onmessage = (event) => { // Changed to arrow function
    const { allAssets, minSizeBytes, excludeFilters } = event.data;

    // console.log('Worker received data:', { minSizeBytes, excludeFilters: excludeFilters.length });

    try {
        // 1. Filter assets
        const filtered = filterAssets(allAssets, minSizeBytes, excludeFilters);

        // 2. Calculate total size and percentages for filtered assets
        const { processedAssets, totalSize } = calculatePercentages(filtered);

        // 3. Send the results back to the main thread
        self.postMessage({
            type: 'RESULT',
            payload: {
                processedAssets,
                totalSize
            }
        });
    } catch (error) {
         console.error('Worker error:', error);
         self.postMessage({
             type: 'ERROR',
             payload: error.message || 'An unknown error occurred in the worker.'
         });
    }
};
