# Webpack Bundle Visualizer

A simple web-based tool to visualize the contents and sizes of assets listed in a standard webpack `stats.json` file.

This tool provides a user interface to inspect asset sizes, filter them based on size and name patterns, and view warnings or errors reported in the stats file.

## Features

*   **Web Interface:** Serves an HTML page using Bun, Tailwind CSS, and HTMX (in serve mode) for interactive analysis.
*   **Asset Listing:** Displays assets from the stats file, showing their names and sizes as reported by webpack.
*   **Size Visualization:** Includes a simple bar visualization comparing asset sizes relative to the largest asset in the current view.
*   **Filtering:**
    *   Hide assets smaller than a specified size (in KB).
    *   Exclude assets matching specific string patterns or regular expressions (e.g., `node_modules/`, `/\.map$/`).
*   **Warnings & Errors:** Displays any warnings or errors captured in the `stats.json` file.
*   **Multi-Compiler Support:** Handles stats files generated from multi-compiler webpack configurations (uses the first child compilation).

## Prerequisites

*   [Bun](https://bun.sh/) runtime environment.

## Installation

1.  Clone the repository (if applicable).
2.  Install dependencies:
    ```bash
    bun install
    ```

## Usage

1.  **Generate Stats File:** Generate a `stats.json` file using the webpack CLI. The `--profile` flag is recommended to include detailed module information, though not strictly required by this tool.

    ```bash
    npx webpack --profile --json=stats.json
    # Or using your project's build script if it incorporates these flags
    ```
    Replace `stats.json` with your desired output filename.

2.  **Run the Server (`serve` command):**
    Use the `serve` command via `bun run index.ts`, providing the path to your generated stats file. You can optionally specify a port using the `--port` or `-p` flag (defaults to 3000).

    ```bash
    bun run index.ts serve <path_to_your_stats.json> [--port <number>]
    ```

    *   **`<path_to_your_stats.json>`:** Replace this with the actual path to your stats file.
    *   **`--port <number>` or `-p <number>`:** (Optional) Specify a port number if you don't want to use the default `3000`.

    **Examples:**
    ```bash
    # Serve using the default port (3000)
    bun run index.ts serve ./stats.json

    # Serve on port 8080 using a stats file in a different location
    bun run index.ts serve ../my-project/dist/stats.json -p 8080
    ```

    Then, open your web browser and navigate to `http://localhost:<port>` (e.g., `http://localhost:3000`).

3.  **Getting Help:**
    You can see help information for the tool and its commands:
    ```bash
    bun run index.ts --help
    bun run index.ts serve --help
    ```

## Interface Guide

*   **Stats File Path:** Displays the path of the stats file being analyzed.
*   **Filter Controls:**
    *   **Hide assets < X KB:** Enter a minimum size in kilobytes. Assets smaller than this will be hidden from the table.
    *   **Exclude patterns:** Enter comma-separated strings or `/regex/` patterns. Assets whose names match any pattern will be excluded. Examples: `node_modules/`, `.map$`, `/vendor\..*\.js$/`.
*   **Errors/Warnings:** If the `stats.json` file contains errors or warnings, they will be displayed in dedicated sections below the filters.
*   **Asset Table:**
    *   **Asset Name:** The name of the asset as listed in the stats file.
    *   **Size:** The size of the asset as reported in the stats file (formatted).
    *   **Visualization:** A horizontal bar indicating the asset's size relative to the largest asset currently displayed in the table.

Filter changes are applied automatically after a short delay. Filter settings are saved in your browser's `localStorage`.
