const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Takes a screenshot of a given URL with various options.
 *
 * @param {object} options - Configuration options for the screenshot.
 * @param {string} [options.url="https://example.com"] - The URL to take a screenshot of.
 * @param {boolean} [options.fullPage=true] - Whether to take a full page screenshot.
 * @param {boolean} [options.cookieBannerAutoAccept=true] - Attempt to auto-accept cookie banners.
 * @param {string|null} [options.cookieSelectorsFilePath=null] - Path to a file containing cookie banner selectors (one per line). Required if cookieBannerAutoAccept is true.
 * @param {number} [options.delayForPaint=1000] - Milliseconds to wait after page load/action before screenshot.
 * @param {boolean} [options.blockAds=false] - Whether to enable ad blocking.
 * @param {string|null} [options.adblockPath=null] - Path to UNPACKED adblocker extension (required if blockAds is true).
 * @param {string|null} [options.deviceName=null] - Name of a Playwright device to emulate (e.g., "iPhone 13 Pro Max").
 * @param {number|null} [options.viewportWidth=null] - Explicit viewport width (used if deviceName is not set).
 * @param {number|null} [options.viewportHeight=null] - Explicit viewport height (used if deviceName is not set).
 * @param {number|null} [options.deviceScaleFactor=null] - Explicit device scale factor (used if deviceName is not set).
 * @param {string} [options.saveFilenamePrefix="screenshot"] - Prefix for the output filename.
 * @param {string} [options.outputDir="."] - Directory to save screenshots.
 * @param {number[]|null} [options.multipleWidths=null] - Array of widths to take screenshots at (e.g., [320, 768, 1920]). Overrides single device/viewport mode for taking multiple shots.
 * @param {boolean} [options.headless=true] - Whether to run the browser in headless mode.
 * @returns {Promise<string[]>} A promise that resolves with an array of paths to the saved screenshots.
 * @throws {Error} If adblocking is enabled but adblockPath is invalid, cookie auto-accept is enabled but selector file is invalid, or other critical errors.
 */
async function takeScreenshot(options = {}) {
  const {
    url = "https://example.com",
    fullPage = true,
    cookieBannerAutoAccept = true,
    cookieSelectorsFilePath = null, // New option
    delayForPaint = 1000,
    blockAds = false,
    adblockPath = null,
    deviceName = null,
    viewportWidth = null,
    viewportHeight = null,
    deviceScaleFactor = null,
    saveFilenamePrefix = "screenshot",
    outputDir = ".",
    multipleWidths = null,
    headless = true,
  } = options;

  if (blockAds) {
    if (!adblockPath) {
      const errMsg = "❌ Adblock enabled, but adblockPath is missing.";
      console.error(errMsg);
      throw new Error(errMsg);
    }
    if (!fs.existsSync(adblockPath)) {
      const errMsg = `❌ Adblock enabled, but adblockPath "${adblockPath}" does not exist or is not accessible. 👉 Ensure it's the path to the UNPACKED extension directory.`;
      console.error(errMsg);
      throw new Error(errMsg);
    }
    try {
      const stats = fs.statSync(adblockPath);
      if (!stats.isDirectory()) {
        const errMsg = `❌ Adblock path "${adblockPath}" is not a directory.`;
        console.error(errMsg);
        throw new Error(errMsg);
      }
      if (!fs.existsSync(path.join(adblockPath, "manifest.json"))) {
        const errMsg = `❌ Adblock path "${adblockPath}" does not seem to be an unpacked extension (missing manifest.json).`;
        console.error(errMsg);
        throw new Error(errMsg);
      }
    } catch (e) {
      const errMsg = `❌ Error accessing adblock_path "${adblockPath}": ${e.message}`;
      console.error(errMsg);
      throw new Error(errMsg);
    }
  }

  let acceptSelectors = [];
  if (cookieBannerAutoAccept) {
    if (!cookieSelectorsFilePath) {
      const errMsg =
        "❌ cookieBannerAutoAccept is true, but cookieSelectorsFilePath is not provided.";
      console.error(errMsg);
      throw new Error(errMsg);
    }
    if (!fs.existsSync(cookieSelectorsFilePath)) {
      const errMsg = `❌ Cookie selectors file not found at path: ${cookieSelectorsFilePath}`;
      console.error(errMsg);
      throw new Error(errMsg);
    }

    try {
      const fileContent = fs.readFileSync(cookieSelectorsFilePath, "utf-8");
      acceptSelectors = fileContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));

      if (acceptSelectors.length === 0) {
        const errMsg = `❌ Cookie selectors file "${cookieSelectorsFilePath}" is empty or contains no valid selectors.`;
        console.error(errMsg);
        throw new Error(errMsg);
      }
      console.log(
        `🍪 Will attempt to auto-accept cookie banner using ${acceptSelectors.length} selectors from: ${cookieSelectorsFilePath}`
      );
    } catch (e) {
      const errMsg = `❌ Error reading or parsing cookie selectors file "${cookieSelectorsFilePath}": ${e.message}`;
      console.error(errMsg);
      throw new Error(errMsg);
    }
  } else {
    console.log("🍪 Cookie banner auto-accept is disabled.");
  }

  console.log(`📸 Starting screenshots for: ${url}`);

  let browser;
  let context;
  const tempUserDataDir = blockAds
    ? path.join(os.tmpdir(), `playwright_user_data_${Date.now()}`)
    : null;
  const savedFilePaths = [];

  let contextOptions = {};

  if (deviceName && devices[deviceName]) {
    console.log(`📱 Emulating device: ${deviceName}`);
    contextOptions = { ...devices[deviceName] };
  } else {
    const vp = {};
    if (viewportWidth) vp.width = viewportWidth;
    if (viewportHeight) vp.height = viewportHeight;

    if (Object.keys(vp).length > 0) {
      contextOptions.viewport = vp;
      console.log(
        `🖥️ Setting explicit viewport: ${vp.width || "default"}x${
          vp.height || "default"
        }`
      );
    } else {
      console.log(
        "💡 Using Playwright's default viewport size (if not overridden by multipleWidths)."
      );
    }
    if (deviceScaleFactor) {
      contextOptions.deviceScaleFactor = deviceScaleFactor;
      console.log(`📏 Setting deviceScaleFactor: ${deviceScaleFactor}`);
    }
  }

  if (blockAds && tempUserDataDir) {
    console.log(
      `🚀 Launching with adblocker (${adblockPath}) using a persistent context.`
    );
    if (!fs.existsSync(tempUserDataDir)) {
      fs.mkdirSync(tempUserDataDir, { recursive: true });
    }

    const persistentContextLaunchOptions = {
      headless: headless,
      args: [
        `--disable-extensions-except=${adblockPath}`,
        `--load-extension=${adblockPath}`,
      ],
      ...contextOptions,
    };
    context = await chromium.launchPersistentContext(
      tempUserDataDir,
      persistentContextLaunchOptions
    );
  } else {
    console.log(`🚀 Launching browser without adblocker...`);
    browser = await chromium.launch({ headless: headless });
    context = await browser.newContext(contextOptions);
  }

  const page = await context.newPage();

  console.log(`🌐 Navigating to ${url}...`);
  await page.goto(url, { waitUntil: "load", timeout: 2 * 60000 });

  if (blockAds) {
    console.log("⏳ Allowing a moment for adblocker to process the page...");
    await page.waitForTimeout(2000);
  }

  if (cookieBannerAutoAccept) {
    console.log(
      "🍪 Attempting to auto-accept cookie banner with loaded selectors..."
    );
    try {
      let bannerClicked = false;
      for (const selector of acceptSelectors) {
        const button = page.locator(selector).first();
        try {
          if (await button.isVisible({ timeout: 2000 })) {
            console.log(
              `✅ Clicking cookie banner button using selector: ${selector}`
            );
            await button.click({ force: true, timeout: 5000 });
            await page.waitForTimeout(1000);
            bannerClicked = true;
            break;
          }
        } catch (e) {
          // Button not visible or other error, try next selector
          // console.debug(`Button for selector "${selector}" not found or not clickable: ${e.message}`);
        }
      }
      if (!bannerClicked) {
        console.log(
          "🤔 No cookie banner button found or clicked using provided selectors."
        );
      }
    } catch (err) {
      console.warn(
        "⚠️ Could not handle cookie banner automatically:",
        err.message
      );
    }
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (
    multipleWidths &&
    Array.isArray(multipleWidths) &&
    multipleWidths.length > 0
  ) {
    if (deviceName) {
      console.warn(
        "⚠️ Device emulation is active. 'multipleWidths' will override width, but other device characteristics (UA, scale, etc.) will be kept."
      );
    }
    console.log(
      `📸 Taking screenshots for multiple widths: ${multipleWidths.join(", ")}`
    );

    for (const currentLoopWidth of multipleWidths) {
      let heightForLoopViewport;
      if (options.viewportHeight) {
        heightForLoopViewport = options.viewportHeight;
      } else if (contextOptions.viewport && contextOptions.viewport.height) {
        heightForLoopViewport = contextOptions.viewport.height;
      } else {
        heightForLoopViewport = fullPage ? 1080 : 800;
      }

      await page.setViewportSize({
        width: currentLoopWidth,
        height: heightForLoopViewport,
      });
      console.log(
        `🎨 Applying paint delay: ${delayForPaint}ms before screenshot at ${currentLoopWidth}x${heightForLoopViewport}`
      );
      await page.waitForTimeout(delayForPaint);

      const filename = path.join(
        outputDir,
        `${saveFilenamePrefix}-${currentLoopWidth}x${
          fullPage ? "full" : heightForLoopViewport
        }.png`
      );
      console.log(`📷 Taking screenshot: ${filename}`);
      await page.screenshot({ path: filename, fullPage: fullPage });
      console.log(`👍 Saved screenshot: ${filename}`);
      savedFilePaths.push(filename);
    }
  } else {
    let filenameParts = [saveFilenamePrefix];
    let actualViewportHeightForFilename;

    if (deviceName && devices[deviceName]) {
      const device = devices[deviceName];
      filenameParts.push(deviceName.replace(/[^\w.-]+/g, "_"));
      actualViewportHeightForFilename = device.viewport.height;
      console.log(
        `View configured for device ${deviceName}: ${device.viewport.width}x${device.viewport.height}` +
          (device.deviceScaleFactor ? ` @${device.deviceScaleFactor}x` : "")
      );
    } else if (options.viewportWidth && options.viewportHeight) {
      filenameParts.push(`${options.viewportWidth}x${options.viewportHeight}`);
      actualViewportHeightForFilename = options.viewportHeight;
      console.log(
        `View configured for explicit size: ${options.viewportWidth}x${options.viewportHeight}` +
          (options.deviceScaleFactor ? ` @${options.deviceScaleFactor}x` : "")
      );
    } else {
      const vp = page.viewportSize() ||
        contextOptions.viewport || { width: 1280, height: 720 };
      filenameParts.push(`${vp.width}x${vp.height}_default`);
      actualViewportHeightForFilename = vp.height;
      console.log(
        `View configured using page/context/default: ${vp.width}x${vp.height}`
      );
    }

    if (fullPage) {
      filenameParts.push("full");
    } else {
      const currentViewport = page.viewportSize();
      filenameParts.push(
        `h${
          currentViewport
            ? currentViewport.height
            : actualViewportHeightForFilename
        }`
      );
    }

    console.log(`🎨 Applying paint delay: ${delayForPaint}ms`);
    await page.waitForTimeout(delayForPaint);

    const finalFilename = path.join(
      outputDir,
      `${filenameParts.join("-")}.png`
    );
    console.log(`📷 Taking screenshot: ${finalFilename}`);
    await page.screenshot({ path: finalFilename, fullPage: fullPage });
    console.log(`👍 Saved screenshot: ${finalFilename}`);
    savedFilePaths.push(finalFilename);
  }

  await context.close();
  if (browser) {
    await browser.close();
  }

  if (blockAds && tempUserDataDir && fs.existsSync(tempUserDataDir)) {
    console.log(
      `🗑️ Cleaning up temporary user data directory: ${tempUserDataDir}`
    );
    try {
      if (fs.rmSync) {
        // fs.rmSync is available in Node.js v14.14.0+
        fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      } else {
        // Fallback for older Node.js versions
        const deleteFolderRecursive = function (directoryPath) {
          if (fs.existsSync(directoryPath)) {
            fs.readdirSync(directoryPath).forEach((file) => {
              const curPath = path.join(directoryPath, file);
              if (fs.lstatSync(curPath).isDirectory()) {
                // recurse
                deleteFolderRecursive(curPath);
              } else {
                // delete file
                fs.unlinkSync(curPath);
              }
            });
            fs.rmdirSync(directoryPath);
          }
        };
        deleteFolderRecursive(tempUserDataDir);
      }
      console.log("✅ Temporary directory cleaned up.");
    } catch (e) {
      console.warn(
        `⚠️ Could not automatically clean up ${tempUserDataDir}. Please remove it manually. Error: ${e.message}`
      );
    }
  }

  console.log("✅ Screenshot process complete!");
  return savedFilePaths;
}

if (require.main === module) {
  const cliOptions = {
    url: "https://example.com",
    fullPage: true,
    cookieBannerAutoAccept: false,
    cookieSelectorsFilePath: null,
    delayForPaint: 1000,
    blockAds: false,
    adblockPath: null,
    deviceName: null,
    viewportWidth: null,
    viewportHeight: null,
    deviceScaleFactor: null,
    saveFilenamePrefix: "screenshot",
    outputDir: ".",
    multipleWidths: null,
    headless: true,
  };

  process.argv.slice(2).forEach((arg) => {
    const [key, value] = arg.split("=");
    if (arg.startsWith("http://") || arg.startsWith("https://")) {
      cliOptions.url = arg;
    } else if (key === "--fullPage") {
      cliOptions.fullPage = value !== "no";
    } else if (key === "--cookieBannerAutoAccept") {
      cliOptions.cookieBannerAutoAccept = value !== "no";
    } else if (key === "--cookieSelectorsFile" || key === "--csf") {
      cliOptions.cookieSelectorsFilePath = value;
    } else if (key === "--delayForPaint") {
      cliOptions.delayForPaint = parseInt(value, 10);
    } else if (key === "--blockAds") {
      cliOptions.blockAds = value === "yes";
    } else if (key === "--adblockPath") {
      cliOptions.adblockPath = value;
    } else if (key === "--deviceName") {
      cliOptions.deviceName = value;
    } else if (key === "--viewportWidth" || key === "--vwpw") {
      cliOptions.viewportWidth = Number(value);
    } else if (key === "--viewportHeight" || key === "--vwph") {
      cliOptions.viewportHeight = Number(value);
    } else if (key === "--deviceScaleFactor") {
      cliOptions.deviceScaleFactor = Number(value);
    } else if (key === "--saveFilenamePrefix" || key === "--save_to") {
      cliOptions.saveFilenamePrefix = value;
    } else if (key === "--outputDir") {
      cliOptions.outputDir = value;
    } else if (key === "--multipleWidths") {
      cliOptions.multipleWidths = value.split(",").map(Number);
    } else if (key === "--headless") {
      cliOptions.headless = value !== "no";
    } else {
      console.warn(`Unknown argument: ${arg}`);
    }
  });

  if (
    (cliOptions.viewportWidth && !cliOptions.viewportHeight) ||
    (!cliOptions.viewportWidth && cliOptions.viewportHeight)
  ) {
    if (!cliOptions.deviceName && !cliOptions.multipleWidths) {
      console.warn(
        "⚠️ Both --viewportWidth and --viewportHeight should be provided for explicit viewport sizing. One is missing. Defaulting might occur."
      );
    }
  }
  if (
    cliOptions.deviceName &&
    (cliOptions.viewportWidth ||
      cliOptions.viewportHeight ||
      cliOptions.deviceScaleFactor)
  ) {
    console.warn(
      "⚠️ --deviceName is specified; explicit --viewportWidth, --viewportHeight, and --deviceScaleFactor will be ignored for initial context setup (but viewportHeight might be used with --multipleWidths)."
    );
  }

  console.log("--- Effective CLI Options ---");
  console.log(cliOptions);
  console.log("-----------------------------");

  takeScreenshot(cliOptions)
    .then((savedFiles) => {
      console.log("\n🎉 All screenshots taken successfully! Files saved:");
      savedFiles.forEach((file) => console.log(`  - ${file}`));
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n❌ Screenshotting failed:", err.message);
      if (err.stack && (process.env.DEBUG || cliOptions.debug)) {
        console.error(err.stack);
      }
      process.exit(1);
    });
}

module.exports = { takeScreenshot, devices };
