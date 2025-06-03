import { getBrowserPool, devices } from "./wirklich.js";
import fs from "fs";
async function main() {
  let pool;

  const uBlockPath = "/path/to/unpacked/extension/ext_ublock";
  /**
   * Note: While extension loading currently works,
   * since each new browser context loads a fresh ublock extension,
   * it does not preserve the extension's filter list
   *
   * If launching browser's with adblocking enabled, please
   * allow some time (~2-3s should be enough) for the extensions
   * to fully load
   *
   * I haven't done so in the example.js file. This means that
   * the extension doesn't block all ads (as can be seen in the
   * example screenshots)
   *
   * `screenshotter.js` does allow time for adblock to fully load
   * before taking screenshots, but I did have situations where I
   * did not want to wait, so ...
   *
   * Anyways, you can configure a wait time in the task_config object
   * passed to createScreenshotTask or createScreencastTask
   */
  const adblockerAvailable = fs.existsSync(uBlockPath);

  if (!adblockerAvailable) {
    console.warn(
      `Adblocker extension not found at ${uBlockPath}. Adblock tests will be skipped or fail if forced.`
    );
  }

  try {
    pool = await getBrowserPool({
      pool_size_default: 4,
      pool_size_adblock: adblockerAvailable ? 2 : 0,
      adblockExtensionPath: adblockerAvailable ? uBlockPath : undefined,
      playwrightLaunchOptionsDefault: { headless: false },
      playwrightLaunchOptionsAdblock: { headless: false },
      taskTimeoutMs: 60000,
    });

    console.log("Pool stats at start:", pool.getStats());

    const screenshotTasksToRun = [
      pool.createScreenshotTask({
        url: "https://example.com",
        use_adblock: true,
        max_retries: 0,
      }),
      pool.createScreenshotTask({
        url: "https://docs.google.com/document/d/1ZFe9Rv8mnQPOhPQDvKMTpuY1Msqui8lk6K1yNEJyhXQ/edit?usp=sharing",
        use_adblock: false,
        device_name: "Nokia N9",
        emulate_device: true,
        max_retries: 3,
        cookie_banner_selectors: [
          "docs-branding-icon-img",
          "docs-branding-icon-documents-36",
        ],
      }),
      pool.createScreenshotTask({
        url: "https://www.whatismybrowser.com/",
        use_adblock: true,
        emulate_device: true,
        device_name: "iPhone 13 Pro",
        max_retries: 0,
      }),
      pool.createScreenshotTask({
        url: "https://adblock-tester.com/",
        use_adblock: false,
      }),
      pool.createScreenshotTask({
        url: "https://adblock-tester.com/",
        use_adblock: true,
      }),
      {},
      pool.createScreenshotTask({
        url: "https://a-site-that-does-not-exist-for-testing-errors.com",
        use_adblock: false,
      }),
    ];

    console.log("\n--- Processing Screenshot Tasks ---");
    const screenshotPromises = screenshotTasksToRun.map((taskObject, index) => {
      if (
        !taskObject ||
        typeof taskObject.taskFn !== "function" ||
        typeof taskObject.originalUrl !== "string"
      ) {
        console.warn(
          `Skipping malformed screenshot task object at index ${index}. TaskObject:`,
          taskObject
        );
        return Promise.resolve(`SKIPPED (malformed task object)`);
      }
      const taskUrl = taskObject.originalUrl;

      if (
        taskObject.requirements.use_adblock &&
        (!adblockerAvailable || pool.getStats().config.pool_size_adblock === 0)
      ) {
        console.warn(
          `Skipping adblock screenshot task for ${taskUrl} as adblocker is not configured/available or pool_size_adblock is 0.`
        );
        return Promise.resolve(
          `SKIPPED (adblock not available/configured): ${taskUrl}`
        );
      }

      return pool
        .queueScreenshotTask(taskObject, index % 3)
        .then((imageBuffer) => {
          if (
            typeof imageBuffer === "string" &&
            imageBuffer.startsWith("SKIPPED")
          )
            return;

          console.log(
            `SUCCESS: Screenshot for ${taskUrl} (adblock: ${
              taskObject.requirements.use_adblock
            }) received (${(imageBuffer.length / 1024).toFixed(1)} KB)`
          );
          const safeUrl = taskUrl.replace(/[^a-zA-Z0-9]/g, "_");
          const filename = `screenshot_${safeUrl}_adb-${taskObject.requirements.use_adblock}.png`;
          fs.writeFileSync(filename, imageBuffer);
          console.log(`Saved: ${filename}`);
        })
        .catch((error) => {
          console.error(
            `FAILURE: Screenshot for ${taskUrl} (adblock: ${
              taskObject.requirements.use_adblock
            }) - ${error.message.split("\n")[0]}`
          );
        });
    });

    await Promise.allSettled(screenshotPromises);
    console.log("All screenshot tasks processed or failed.");
    console.log("Pool stats after screenshots:", pool.getStats());

    const screencastTasksToRun = [
      pool.createScreencastTask({
        url: "https://www.google.com",
        actions: [
          {
            type: "waitForSelector",
            selector: 'textarea[name="q"], input[name="q"]',
            options: { timeout: 10000 },
          },
          {
            type: "fill",
            selector: 'textarea[name="q"], input[name="q"]',
            text: "Playwright browser automation",
          },
          {
            type: "press",
            selector: 'textarea[name="q"], input[name="q"]',
            key: "Enter",
          },
          {
            type: "waitForNavigation",
            options: { waitUntil: "networkidle", timeout: 15000 },
          },
          { type: "waitTimeout", duration: 3000 },
          { type: "scroll", direction: "down", amount: 500 },
          { type: "waitTimeout", duration: 1000 },
        ],
        use_adblock: false,
        max_retries: 1,
        viewport_width: 1280,
        viewport_height: 720,
      }),
      pool.createScreencastTask({
        url: "https://www.google.com",
        actions: [
          {
            type: "waitForSelector",
            selector: 'textarea[name="q"], input[name="q"]',
            options: { timeout: 10000 },
          },
          {
            type: "type",
            selector: 'textarea[name="q"], input[name="q"]',
            text: "benefits of adblockers",
          },
          {
            type: "press",
            selector: 'textarea[name="q"], input[name="q"]',
            key: "Enter",
          },
          {
            type: "waitForNavigation",
            options: { waitUntil: "domcontentloaded", timeout: 15000 },
          },
          { type: "waitTimeout", duration: 2000 },
          { type: "scroll", direction: "bottom" },
          { type: "waitTimeout", duration: 1000 },
          { type: "scroll", direction: "top" },
          { type: "waitTimeout", duration: 1000 },
        ],
        use_adblock: true,
        emulate_device: true,
        device_name: "iPhone SE",
        max_retries: 1,
      }),
    ];

    console.log("\n--- Processing Screencast Tasks ---");
    const screencastPromises = screencastTasksToRun.map((taskObject, index) => {
      if (
        !taskObject ||
        typeof taskObject.taskFn !== "function" ||
        typeof taskObject.originalUrl !== "string"
      ) {
        console.warn(
          `Skipping malformed screencast task object at index ${index}. TaskObject:`,
          taskObject
        );
        return Promise.resolve(`SKIPPED (malformed task object)`);
      }
      const taskUrl = taskObject.originalUrl;

      if (
        taskObject.requirements.use_adblock &&
        (!adblockerAvailable || pool.getStats().config.pool_size_adblock === 0)
      ) {
        console.warn(
          `Skipping adblock screencast task for ${taskUrl} as adblocker is not configured/available or pool_size_adblock is 0.`
        );
        return Promise.resolve(
          `SKIPPED (adblock not available/configured): ${taskUrl}`
        );
      }

      return pool
        .queueScreencastTask(taskObject, index % 2)
        .then((videoBuffer) => {
          if (
            typeof videoBuffer === "string" &&
            videoBuffer.startsWith("SKIPPED")
          )
            return;

          console.log(
            `SUCCESS: Screencast for ${taskUrl} (adblock: ${
              taskObject.requirements.use_adblock
            }, device: ${
              taskObject.emulate_device ? taskObject.device_name : "default"
            }) received (${(videoBuffer.length / 1024).toFixed(1)} KB)`
          );
          const safeUrl = taskUrl.replace(/[^a-zA-Z0-9]/g, "_");
          const adbSuffix = taskObject.requirements.use_adblock
            ? "adb"
            : "noadb";
          const deviceSuffix = taskObject.emulate_device
            ? taskObject.device_name.replace(/\s+/g, "_")
            : "desktop";
          const filename = `screencast_${safeUrl}_${deviceSuffix}_${adbSuffix}.webm`;
          fs.writeFileSync(filename, videoBuffer);
          console.log(`Saved: ${filename}`);
        })
        .catch((error) => {
          console.error(
            `FAILURE: Screencast for ${taskUrl} (adblock: ${
              taskObject.requirements.use_adblock
            }, device: ${
              taskObject.emulate_device ? taskObject.device_name : "default"
            }) - ${error.message.split("\n")[0]}`
          );
        });
    });

    await Promise.allSettled(screencastPromises);
    console.log("All screencast tasks processed or failed.");
    console.log("Final Pool stats:", pool.getStats());
  } catch (error) {
    console.error("Error in main execution:", error);
  } finally {
    if (pool) {
      console.log("Shutting down pool...");
      await pool.shutdown();
    }
  }
}

main();
