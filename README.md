```markdown
# Wirklich - A Screenshotter Utility

A simple but powerful screenshot utility built with Playwright and Node.js. It allows you to capture web pages with various configurations, including device emulation, ad-blocking, cookie banner handling, and multiple viewport sizes.

## Features

*   Take full-page or viewport-specific screenshots.
*   Emulate various mobile and desktop devices.
*   Specify custom viewport dimensions and device scale factors.
*   Automatically attempt to accept cookie banners using a configurable list of selectors.
*   Block ads using an unpacked Chromium extension (e.g., uBlock Origin).
*   Set a delay to allow for page rendering or animations before capturing.
*   Capture screenshots at multiple specified widths in a single run.
*   Run headlessly or with a visible browser (for debugging).
*   Flexible output naming and directory options.
*   Dockerized for easy, isolated execution.

## Prerequisites

**For Local/CLI Usage:**
*   Node.js (v18.x or later recommended, as used in Dockerfile)
*   npm (comes with Node.js)

**For Docker Usage:**
*   Docker installed and running.

## Installation

### 1. Local / Command-Line Interface (CLI)

1.  **Clone the repository (or download the files):**
    ```bash
    git clone https://github.com/PeasPilaf/wirklich 
    cd wirklich
    ```

2.  **Install dependencies:**
    This will install Playwright and its necessary browser binaries.
    ```bash
    npm install
    ```
    *(Note: Playwright will download browser binaries by default. The script is also configured to use system-installed Chromium if running inside the provided Docker container.)*

### 2. Docker

1.  **Clone the repository (or ensure `Dockerfile`, `package.json`, and `screenshotter.js` are in the same directory):**
    ```bash
    git clone https://github.com/PeasPilaf/wirklich
    cd wirklich
    ```

2.  **Build the Docker image:**
    ```bash
    docker build -t screenshotter .
    ```
    This creates a Docker image named `screenshotter` containing Node.js, Chromium, and the script with its dependencies.

## Usage

### 1. Using the Command-Line Interface (CLI)

Once installed locally, you can run the script directly using `node`.

**Basic Usage:**
```bash
node screenshotter.js https://example.com
```
This will take a full-page screenshot of `https://example.com` and save it as `screenshot-1280x720_default-full.png` (or similar, depending on default viewport) in the current directory.

**Common Examples:**

*   **Specify output directory and filename prefix:**
    ```bash
    node screenshotter.js https://example.com --outputDir=./my_captures --saveFilenamePrefix=test_site
    ```

*   **Emulate a device:**
    ```bash
    node screenshotter.js https://google.com --deviceName="iPhone 13 Pro Max"
    ```

*   **Custom viewport size (not full page):**
    ```bash
    node screenshotter.js https://bing.com --viewportWidth=800 --viewportHeight=600 --fullPage=no
    ```

*   **Multiple widths:**
    ```bash
    node screenshotter.js https://playwright.dev --multipleWidths=320,768,1280
    ```

*   **Auto-accept cookie banner:**
    First, create a file (e.g., `cookie_selectors.txt`) with CSS selectors for cookie accept buttons, one per line:
    ```
    #accept-cookies-button
    .cookie-banner .accept
    [data-testid="cookie-accept"]
    ```
    Then run:
    ```bash
    node screenshotter.js https://example.com --cookieBannerAutoAccept=yes --cookieSelectorsFile=./cookie_selectors.txt
    ```

*   **Block ads (requires an unpacked adblocker extension):**
    Download an adblocker like uBlock Origin as a `.zip` or `.crx`, then unpack it to a directory.
    ```bash
    # Example: If uBlock Origin is unpacked to ./ublock_origin_unpacked
    node screenshotter.js https://news.example.com --blockAds=yes --adblockPath=./ublock_origin_unpacked
    ```

### 2. Using Docker

The Docker image makes it easy to run the screenshotter without worrying about local Node.js or browser installations.

**Key consideration: Output Files**
To get the screenshots out of the Docker container, you need to mount a volume from your host machine to the container's output directory. The default output directory inside the container is `/app/screenshots`.

**Basic Usage (uses CMD defaults: `https://example.com --outputDir=/app/screenshots`):**
```bash
docker run --rm -v "$(pwd)/my_docker_screenshots:/app/screenshots" screenshotter
```
This will:
*   Run the `screenshotter` image.
*   Mount the `my_docker_screenshots` directory from your current host directory to `/app/screenshots` inside the container. Screenshots will appear in `my_docker_screenshots` on your host.
*   `--rm` automatically removes the container when it exits.

**Overriding the URL and other arguments:**
Simply append the arguments after the image name.

*   **Screenshot a different URL:**
    ```bash
    docker run --rm -v "$(pwd)/output:/app/screenshots" screenshotter https://playwright.dev
    ```

*   **Emulate a device and specify output:**
    ```bash
    docker run --rm -v "$(pwd)/iphone_shots:/app/screenshots" screenshotter https://playwright.dev --deviceName="iPhone 13 Pro Max" --outputDir=/app/screenshots
    ```

*   **Using cookie selectors or adblocker with Docker:**
    You'll need to mount the directory containing the cookie selector file or the adblocker extension into the container.

    *   **Cookie Selectors:**
        Assume `cookie_selectors.txt` is in your current directory (`$(pwd)`).
        ```bash
        docker run --rm \
          -v "$(pwd)/output:/app/screenshots" \
          -v "$(pwd)/cookie_selectors.txt:/app/cookie_selectors.txt:ro" \
          screenshotter https://example.com \
            --cookieBannerAutoAccept=yes \
            --cookieSelectorsFile=/app/cookie_selectors.txt \
            --outputDir=/app/screenshots
        ```
        *(Note: `:ro` makes the mounted file read-only in the container, which is good practice for config files.)*

    *   **Ad Blocker:**
        Assume your unpacked adblocker is in `$(pwd)/ublock_origin_unpacked`.
        ```bash
        docker run --rm \
          -v "$(pwd)/output:/app/screenshots" \
          -v "$(pwd)/ublock_origin_unpacked:/app/adblocker:ro" \
          screenshotter https://news.example.com \
            --blockAds=yes \
            --adblockPath=/app/adblocker \
            --outputDir=/app/screenshots
        ```

### 3. Listing Available Devices

Playwright comes with a predefined list of devices you can emulate. To list their names:

**Method 1: Using Node.js (if locally installed)**

1.  Ensure you have `screenshotter.js` and have run `npm install` in its directory.
2.  Use the helper script, e.g., `list-devices.js`, in the same directory:
    ```javascript
    // list-devices.js
    const { devices } = require('./screenshotter.js'); // Uses the exported devices from your script
    console.log("Available Playwright devices:");
    Object.keys(devices).forEach(deviceName => {
      console.log(`- ${deviceName}`);
    });
    ```
3.  Run the script:
    ```bash
    node list-devices.js
    ```

This will print a list like:
```
Available Playwright devices:
- Blackbery PlayBook
- BlackBerry Z30
- Galaxy Note 3
- Galaxy Note II
- ...
- iPhone 13 Pro Max
- ...
```
Use these exact names for the `--deviceName` option.

**Method 2: Inside the Docker Container**

You can run an interactive shell in the Docker container and use Node.js to list devices.
```bash
docker run --rm -it screenshotter node
```
Then, in the Node.js REPL:
```javascript
const { devices } = require('playwright');
console.log(Object.keys(devices));
```

## Command-Line Options

The script accepts the following command-line arguments. The first non-option argument is treated as the URL.

| Argument                  | Alias       | Description                                                                                                | Default Value       | Example                                        |
| :------------------------ | :---------- | :--------------------------------------------------------------------------------------------------------- | :------------------ | :--------------------------------------------- |
| `[url]`                   |             | The URL to take a screenshot of. Must start with `http://` or `https://`.                                | `https://example.com` | `https://google.com`                           |
| `--fullPage`              |             | Whether to take a full page screenshot (`yes`) or just the viewport (`no`).                                | `yes`               | `--fullPage=no`                                |
| `--cookieBannerAutoAccept`|             | Whether to attempt auto-accepting cookie banners (`yes`/`no`). Requires `--cookieSelectorsFile`.            | `no`                | `--cookieBannerAutoAccept=yes`                 |
| `--cookieSelectorsFile`   | `--csf`     | Path to a file containing cookie banner CSS selectors (one per line, `#` for comments).                      | `null`              | `--csf=./selectors.txt`                        |
| `--delayForPaint`         |             | Milliseconds to wait after page load/action before screenshot.                                             | `1000`              | `--delayForPaint=3000`                         |
| `--blockAds`              |             | Whether to enable ad blocking (`yes`/`no`). Requires `--adblockPath`.                                      | `no`                | `--blockAds=yes`                               |
| `--adblockPath`           |             | Path to an UNPACKED adblocker extension directory (must contain `manifest.json`).                          | `null`              | `--adblockPath=./ublock_unpacked`              |
| `--deviceName`            |             | Name of a Playwright device to emulate (e.g., "iPhone 13 Pro Max"). See "Listing Available Devices".       | `null`              | `--deviceName="iPad Mini"`                     |
| `--viewportWidth`         | `--vwpw`    | Explicit viewport width. Used if `deviceName` is not set. Both width & height should be set.               | `null` (uses 1280)  | `--vwpw=1920`                                  |
| `--viewportHeight`        | `--vwph`    | Explicit viewport height. Used if `deviceName` is not set. Both width & height should be set.              | `null` (uses 720)   | `--vwph=1080`                                  |
| `--deviceScaleFactor`     |             | Explicit device scale factor. Used if `deviceName` is not set.                                             | `null`              | `--deviceScaleFactor=2`                        |
| `--saveFilenamePrefix`    | `--save_to` | Prefix for the output filename.                                                                            | `screenshot`        | `--save_to=my_site`                            |
| `--outputDir`             |             | Directory to save screenshots.                                                                             | `.` (current dir)   | `--outputDir=./captures`                       |
| `--multipleWidths`        |             | Comma-separated list of widths to take screenshots at (e.g., `320,768,1920`). Overrides single device mode. | `null`              | `--multipleWidths=400,800,1200`                |
| `--headless`              |             | Whether to run the browser in headless mode (`yes`/`no`).                                                  | `yes`               | `--headless=no` (shows browser UI)             |

**Notes on Argument Parsing:**
*   Arguments are parsed as `key=value`. For boolean flags, `key=yes` or `key=no` (e.g., `--fullPage=yes`).
*   The URL can be provided as the first argument without a key.
*   If `--viewportWidth` is provided without `--viewportHeight` (or vice-versa) and not using `--deviceName` or `--multipleWidths`, a warning will be shown.
*   If `--deviceName` is set, explicit `--viewportWidth`, `--viewportHeight`, and `--deviceScaleFactor` are generally ignored for initial context setup, but `viewportHeight` might be used with `multipleWidths`.

## Important Considerations

*   **Ad Blocker Path (`--adblockPath`):** This MUST be the path to an *unpacked* Chromium extension directory. This directory should contain a `manifest.json` file directly within it. You typically get this by downloading the `.crx` or `.zip` file for an extension (like uBlock Origin) and then extracting its contents into a folder.
*   **Cookie Selectors File (`--cookieSelectorsFile`):** This file should contain one CSS selector per line. Lines starting with `#` are treated as comments and ignored. The script will try each selector in order until one is found and clicked.
*   **Permissions (Docker):** When using Docker and mounting volumes, ensure the `node` user inside the container (UID/GID 1000 by default in the `node:alpine` image) has permission to write to the mounted output directory. `docker run -u "$(id -u):$(id -g)" ...` can sometimes help align host user permissions if needed, but the Dockerfile already creates `/app/screenshots` and `chown`s it to `node`.

## License

MIT License