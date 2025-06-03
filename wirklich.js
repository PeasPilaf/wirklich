import { chromium, devices } from "playwright";
import path from "path";
import fs from "fs";
import os from "os";

export { devices };

/**
 * Browser Pooling
 */

class PriorityQueue {
  constructor() {
    this.items = [];
    this.taskIdCounter = 0;
  }

  enqueue(task, priority, requirements, resolve, reject) {
    const id = this.taskIdCounter++;
    this.items.push({ task, priority, requirements, resolve, reject, id });
    this.items.sort((a, b) => b.priority - a.priority);
    return id;
  }

  dequeue() {
    if (this.isEmpty()) {
      return null;
    }
    return this.items.shift();
  }

  remove(id) {
    this.items = this.items.filter((item) => item.id !== id);
  }

  isEmpty() {
    return this.items.length === 0;
  }

  get length() {
    return this.items.length;
  }
}

export async function getBrowserPool({
  pool_size_default = 3,
  playwrightLaunchOptionsDefault = { headless: true },
  pool_size_adblock = 3,
  adblockExtensionPath,
  playwrightLaunchOptionsAdblock = { headless: true },
  maxPagesPerBrowser = 1,
  taskTimeoutMs = 60000,
}) {
  if (!chromium) {
    throw new Error(
      "Chromium is not available from Playwright. Make sure it's installed (npx playwright install chromium)."
    );
  }
  if (pool_size_adblock > 0 && !adblockExtensionPath) {
    throw new Error(
      "adblockExtensionPath is required if pool_size_adblock > 0"
    );
  }

  const browsers = [];
  const taskQueue = new PriorityQueue();
  let browserIdCounter = 0;
  let shuttingDown = false;

  async function _launchBrowser(type = "default") {
    let launchOptions;
    let effectiveAdblockPath;

    if (type === "adblock") {
      if (!adblockExtensionPath) {
        console.warn(
          "[Pool] Adblock browser requested but no adblockExtensionPath configured. Launching default browser."
        );
        type = "default";
        launchOptions = { ...playwrightLaunchOptionsDefault };
      } else {
        effectiveAdblockPath = path.resolve(adblockExtensionPath);
        launchOptions = {
          ...playwrightLaunchOptionsAdblock,
          args: [
            ...(playwrightLaunchOptionsAdblock.args || []),
            `--disable-extensions-except=${effectiveAdblockPath}`,
            `--load-extension=${effectiveAdblockPath}`,
          ],
        };
        console.log(
          `[Pool] Launching AD BLOCK browser with extension: ${effectiveAdblockPath}`
        );
      }
    } else {
      launchOptions = { ...playwrightLaunchOptionsDefault };
      console.log("[Pool] Launching DEFAULT browser.");
    }

    try {
      const browser = await chromium.launch(launchOptions);
      const browserId = browserIdCounter++;
      console.log(`[Pool] Launched browser ${browserId} (type: ${type})`);
      const browserState = {
        browser,
        busy: false,
        id: browserId,
        pagesOpen: 0,
        type,
      };

      browser.on("disconnected", () => {
        if (shuttingDown) {
          console.log(
            `[Pool] Browser ${browserState.id} (type: ${browserState.type}) disconnected during shutdown.`
          );
        } else {
          console.warn(
            `[Pool] Browser ${browserState.id} (type: ${browserState.type}) disconnected unexpectedly.`
          );
        }

        _removeBrowserFromPool(browserState);
        if (!shuttingDown) {
          const currentOfTypeCount = browsers.filter(
            (b) => b.type === browserState.type
          ).length;
          const maxOfType =
            browserState.type === "adblock"
              ? pool_size_adblock
              : pool_size_default;
          if (currentOfTypeCount < maxOfType) {
            _launchBrowser(browserState.type).catch((err) =>
              console.error(
                `[Pool] Error replenishing ${browserState.type} browser:`,
                err
              )
            );
          }
          _processQueue();
        }
      });

      browsers.push(browserState);
      return browserState;
    } catch (error) {
      console.error(`[Pool] Failed to launch a ${type} browser:`, error);
      if (type === "adblock" && effectiveAdblockPath) {
        console.error(
          `[Pool] Check adblock extension path and format: ${effectiveAdblockPath}. It should be an unpacked extension directory.`
        );
      }
      throw error;
    }
  }

  function _removeBrowserFromPool(browserState) {
    const index = browsers.findIndex((b) => b.id === browserState.id);
    if (index !== -1) {
      browsers.splice(index, 1);
      console.log(
        `[Pool] Removed browser ${browserState.id} (type: ${browserState.type}) from pool.`
      );
    }
    if (browserState.browser.isConnected()) {
      browserState.browser
        .close()
        .catch((err) =>
          console.warn(
            `[Pool] Error closing removed browser ${browserState.id}:`,
            err.message
          )
        );
    }
  }

  function _findSuitableBrowser(taskRequirements) {
    const requiredType = taskRequirements.use_adblock ? "adblock" : "default";
    return browsers.find(
      (b) =>
        !b.busy &&
        b.pagesOpen < maxPagesPerBrowser &&
        b.type === requiredType &&
        b.browser.isConnected()
    );
  }

  async function _processQueue() {
    if (shuttingDown || taskQueue.isEmpty()) {
      return;
    }

    const nextTaskItem = taskQueue.items[0];
    if (!nextTaskItem) return;

    const availableBrowser = _findSuitableBrowser(nextTaskItem.requirements);

    if (availableBrowser) {
      const queuedItem = taskQueue.dequeue();
      if (!queuedItem) return;

      availableBrowser.busy = true;
      availableBrowser.pagesOpen++;

      console.log(
        `[Pool] Assigning task ${queuedItem.id} (priority ${queuedItem.priority}, adblock: ${queuedItem.requirements.use_adblock}) to browser ${availableBrowser.id} (type: ${availableBrowser.type})`
      );

      let taskCompleted = false;
      const taskExecutionPromise = queuedItem.task(availableBrowser.browser);

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => {
          if (!taskCompleted) {
            reject(
              new Error(
                `[Pool] Task ${queuedItem.id} timed out after ${
                  taskTimeoutMs / 1000
                }s`
              )
            );
          }
        }, taskTimeoutMs)
      );

      Promise.race([taskExecutionPromise, timeoutPromise])
        .then((result) => {
          taskCompleted = true;
          queuedItem.resolve(result);
        })
        .catch((error) => {
          taskCompleted = true;
          console.error(
            `[Pool] Task ${queuedItem.id} failed on browser ${availableBrowser.id} (type: ${availableBrowser.type}):`,
            error.message.split("\n")[0]
          );
          queuedItem.reject(error);
        })
        .finally(() => {
          availableBrowser.pagesOpen--;
          availableBrowser.busy = false;
          console.log(
            `[Pool] Browser ${availableBrowser.id} (type: ${availableBrowser.type}) is now free. Pages open: ${availableBrowser.pagesOpen}`
          );
          _processQueue();
        });
    } else {
      const requiredType = nextTaskItem.requirements.use_adblock
        ? "adblock"
        : "default";
      const totalOfType = browsers.filter(
        (b) => b.type === requiredType
      ).length;
      const maxOfType =
        requiredType === "adblock" ? pool_size_adblock : pool_size_default;

      if (totalOfType < maxOfType) {
        console.log(
          `[Pool] No suitable browser for task ${nextTaskItem.id} (needs ${requiredType}). Attempting to launch a new ${requiredType} browser.`
        );
        _launchBrowser(requiredType)
          .then(() => _processQueue())
          .catch((err) =>
            console.error(
              `[Pool] Failed to launch additional ${requiredType} browser on demand:`,
              err
            )
          );
      } else {
        console.log(
          `[Pool] No suitable browser for task ${nextTaskItem.id} (needs ${requiredType}). Max ${requiredType} browsers (${maxOfType}) already launched or busy. Task remains queued. Queue size: ${taskQueue.length}`
        );
      }
    }
  }

  const browserLaunchPromises = [];
  for (let i = 0; i < pool_size_default; i++) {
    browserLaunchPromises.push(_launchBrowser("default"));
  }
  if (pool_size_adblock > 0 && adblockExtensionPath) {
    for (let i = 0; i < pool_size_adblock; i++) {
      browserLaunchPromises.push(_launchBrowser("adblock"));
    }
  }

  try {
    await Promise.all(browserLaunchPromises);
    console.log(
      `[Pool] Initialized with ${browsers.length} browser(s). Default: ${
        browsers.filter((b) => b.type === "default").length
      }, Adblock: ${browsers.filter((b) => b.type === "adblock").length}.`
    );
  } catch (error) {
    console.error(
      "[Pool] Failed to initialize all browsers. Shutting down already launched ones."
    );
    await shutdown(true);
    throw new Error(`[Pool] Initialization failed: ${error.message}`);
  }

  function queueTaskWithRequirements(taskFunction, requirements, priority = 0) {
    if (shuttingDown) {
      return Promise.reject(
        new Error("Browser pool is shutting down. No new tasks accepted.")
      );
    }
    if (typeof taskFunction !== "function") {
      return Promise.reject(new Error("Task must be a function."));
    }
    if (requirements.use_adblock && !adblockExtensionPath) {
      return Promise.reject(
        new Error(
          "Task requires adblock, but no adblockExtensionPath was configured for the pool."
        )
      );
    }
    if (requirements.use_adblock && pool_size_adblock === 0) {
      return Promise.reject(
        new Error("Task requires adblock, but pool_size_adblock is 0.")
      );
    }

    return new Promise((resolve, reject) => {
      const taskId = taskQueue.enqueue(
        taskFunction,
        priority,
        requirements,
        resolve,
        reject
      );
      console.log(
        `[Pool] Queued task ${taskId} (priority ${priority}, adblock: ${requirements.use_adblock}). Queue size: ${taskQueue.length}`
      );
      _processQueue();
    });
  }

  function createScreenshotTask({
    url,
    use_adblock = false,
    accept_cookie_banners = false,
    cookie_banner_selectors = [],
    max_wait_timeout = 30000,
    wait_for_selector,
    full_page_screenshot = true,
    emulate_device = false,
    device_name = "Desktop Chrome",
    viewport_width = 1920,
    viewport_height = 1080,
    max_retries = 0,
  }) {
    if (
      accept_cookie_banners &&
      (!cookie_banner_selectors || cookie_banner_selectors.length === 0)
    ) {
      throw new Error(
        "If accept_cookie_banners is true, cookie_banner_selectors must be specified."
      );
    }

    const taskRequirements = { use_adblock };

    const taskFn = async (browser) => {
      let context;
      let page;
      let attempt = 0;

      while (attempt <= max_retries) {
        try {
          attempt++;
          console.log(
            `[Task: ${url}] (Adblock: ${use_adblock}) Attempt ${attempt}/${
              max_retries + 1
            }`
          );

          const contextOptions = {};
          if (emulate_device) {
            const device = devices[device_name];
            if (!device) throw new Error(`Device "${device_name}" not found.`);
            Object.assign(contextOptions, device);
          } else {
            contextOptions.viewport = {
              width: viewport_width,
              height: viewport_height,
            };
          }

          context = await browser.newContext(contextOptions);
          page = await context.newPage();
          page.setDefaultTimeout(max_wait_timeout);

          console.log(`[Task: ${url}] (Adblock: ${use_adblock}) Navigating...`);
          await page.goto(url, {
            waitUntil: "load",
            timeout: max_wait_timeout,
          });

          if (accept_cookie_banners) {
            console.log(
              `[Task: ${url}] (Adblock: ${use_adblock}) Attempting to accept cookie banners...`
            );
            for (const selector of cookie_banner_selectors) {
              try {
                await page.waitForSelector(selector, {
                  state: "visible",
                  timeout: 5000,
                });
                await page.click(selector, { timeout: 5000 });
                console.log(
                  `[Task: ${url}] (Adblock: ${use_adblock}) Clicked cookie banner: ${selector}`
                );
                await page.waitForTimeout(500);
                break;
              } catch (e) {}
            }
          }

          if (wait_for_selector) {
            console.log(
              `[Task: ${url}] (Adblock: ${use_adblock}) Waiting for selector: ${wait_for_selector}`
            );
            await page.waitForSelector(wait_for_selector, {
              state: "visible",
            });
          } else {
            await page.waitForTimeout(1000);
          }

          console.log(
            `[Task: ${url}] (Adblock: ${use_adblock}) Taking screenshot...`
          );
          const imageBuffer = await page.screenshot({
            fullPage: full_page_screenshot,
            type: "png",
          });

          console.log(
            `[Task: ${url}] (Adblock: ${use_adblock}) Screenshot successful.`
          );
          await context.close();
          return imageBuffer;
        } catch (error) {
          console.error(
            `[Task: ${url}] (Adblock: ${use_adblock}) Error during attempt ${attempt}: ${
              error.message.split("\n")[0]
            }`
          );
          if (context) await context.close().catch((e) => {});
          if (attempt > max_retries) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
      throw new Error(
        `[Task: ${url}] (Adblock: ${use_adblock}) Unknown error after ${max_retries} retries.`
      );
    };

    return { taskFn, requirements: taskRequirements, originalUrl: url };
  }

  function queueScreenshotTask(screenshotTaskObject, priority = 0) {
    if (
      !screenshotTaskObject ||
      typeof screenshotTaskObject.taskFn !== "function" ||
      !screenshotTaskObject.requirements ||
      typeof screenshotTaskObject.originalUrl !== "string"
    ) {
      return Promise.reject(
        new Error(
          "Invalid task object. Use createScreenshotTask to generate it. Must include taskFn, requirements, and originalUrl."
        )
      );
    }
    return queueTaskWithRequirements(
      screenshotTaskObject.taskFn,
      screenshotTaskObject.requirements,
      priority
    );
  }

  function createScreencastTask({
    url,
    actions = [],
    use_adblock = false,
    accept_cookie_banners = false,
    cookie_banner_selectors = [],
    max_wait_timeout = 30000,
    emulate_device = false,
    device_name = "Desktop Chrome",
    viewport_width = 1920,
    viewport_height = 1080,
    video_size,
    max_retries = 0,
  }) {
    if (
      accept_cookie_banners &&
      (!cookie_banner_selectors || cookie_banner_selectors.length === 0)
    ) {
      throw new Error(
        "If accept_cookie_banners is true, cookie_banner_selectors must be specified."
      );
    }
    if (!actions || actions.length === 0) {
      console.warn(
        `[ScreencastTask: ${url}] No actions provided. Screencast will only record the initial page load and interactions.`
      );
    }

    const taskRequirements = { use_adblock };

    const taskFn = async (browser) => {
      let context;
      let page;
      let attempt = 0;
      let tempVideoDir = "";

      while (attempt <= max_retries) {
        try {
          attempt++;
          console.log(
            `[ScreencastTask: ${url}] (Adblock: ${use_adblock}) Attempt ${attempt}/${
              max_retries + 1
            }`
          );

          tempVideoDir = fs.mkdtempSync(path.join(os.tmpdir(), "screencast-"));

          const contextOptions = {
            recordVideo: {
              dir: tempVideoDir,
              size: video_size,
            },
          };

          let actualViewportWidth = viewport_width;
          let actualViewportHeight = viewport_height;

          if (emulate_device) {
            const device = devices[device_name];
            if (!device) throw new Error(`Device "${device_name}" not found.`);
            Object.assign(contextOptions, device);
            if (device.viewport) {
              actualViewportWidth = device.viewport.width;
              actualViewportHeight = device.viewport.height;
            }
          } else {
            contextOptions.viewport = {
              width: viewport_width,
              height: viewport_height,
            };
          }

          if (!video_size && contextOptions.viewport) {
            contextOptions.recordVideo.size = {
              width: actualViewportWidth,
              height: actualViewportHeight,
            };
          } else if (
            !video_size &&
            !contextOptions.viewport &&
            emulate_device
          ) {
            const device = devices[device_name];
            if (device && device.viewport) {
              contextOptions.recordVideo.size = {
                width: device.viewport.width,
                height: device.viewport.height,
              };
            }
          }

          context = await browser.newContext(contextOptions);
          page = await context.newPage();
          page.setDefaultTimeout(max_wait_timeout);

          console.log(
            `[ScreencastTask: ${url}] (Adblock: ${use_adblock}) Navigating to initial URL...`
          );
          await page.goto(url, {
            waitUntil: "load",
            timeout: max_wait_timeout,
          });

          if (accept_cookie_banners) {
            console.log(
              `[ScreencastTask: ${url}] (Adblock: ${use_adblock}) Attempting to accept cookie banners...`
            );
            for (const selector of cookie_banner_selectors) {
              try {
                await page.waitForSelector(selector, {
                  state: "visible",
                  timeout: 5000,
                });
                await page.click(selector, { timeout: 5000 });
                console.log(
                  `[ScreencastTask: ${url}] (Adblock: ${use_adblock}) Clicked cookie banner: ${selector}`
                );
                await page.waitForTimeout(500);
                break;
              } catch (e) {}
            }
          }

          console.log(
            `[ScreencastTask: ${url}] (Adblock: ${use_adblock}) Executing ${actions.length} actions...`
          );
          for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            console.log(
              `[ScreencastTask: ${url}] Action ${i + 1}/${actions.length}: ${
                action.type
              } ${action.url || action.selector || action.duration || ""}`
            );
            try {
              switch (action.type) {
                case "navigate":
                  if (!action.url)
                    throw new Error("Navigate action requires a 'url'.");
                  await page.goto(action.url, {
                    waitUntil: "load",
                    timeout: max_wait_timeout,
                    ...action.options,
                  });
                  break;
                case "click":
                  if (!action.selector)
                    throw new Error("Click action requires a 'selector'.");
                  await page.click(action.selector, action.options);
                  break;
                case "type":
                  if (!action.selector)
                    throw new Error("Type action requires a 'selector'.");
                  if (typeof action.text !== "string")
                    throw new Error("Type action requires 'text'.");
                  await page.type(action.selector, action.text, action.options);
                  break;
                case "fill":
                  if (!action.selector)
                    throw new Error("Fill action requires a 'selector'.");
                  if (typeof action.text !== "string")
                    throw new Error("Fill action requires 'text'.");
                  await page.fill(action.selector, action.text, action.options);
                  break;
                case "check":
                  if (!action.selector)
                    throw new Error("Check action requires a 'selector'.");
                  await page.check(action.selector, action.options);
                  break;
                case "uncheck":
                  if (!action.selector)
                    throw new Error("Uncheck action requires a 'selector'.");
                  await page.uncheck(action.selector, action.options);
                  break;
                case "selectOption":
                  if (!action.selector)
                    throw new Error(
                      "SelectOption action requires a 'selector'."
                    );
                  if (!action.value)
                    throw new Error(
                      "SelectOption action requires a 'value' (string, array of strings, or object)."
                    );
                  await page.selectOption(
                    action.selector,
                    action.value,
                    action.options
                  );
                  break;
                case "waitForSelector":
                  if (!action.selector)
                    throw new Error(
                      "WaitForSelector action requires a 'selector'."
                    );
                  await page.waitForSelector(action.selector, {
                    state: "visible",
                    timeout: max_wait_timeout,
                    ...action.options,
                  });
                  break;
                case "waitForTimeout":
                  if (typeof action.duration !== "number")
                    throw new Error(
                      "WaitTimeout action requires a 'duration' (number)."
                    );
                  await page.waitForTimeout(action.duration);
                  break;
                case "waitForNavigation":
                  await page.waitForNavigation({
                    waitUntil: "load",
                    timeout: max_wait_timeout,
                    ...action.options,
                  });
                  break;
                case "waitForLoadState":
                  await page.waitForLoadState(
                    action.state || "load",
                    action.options
                  );
                  break;
                case "scroll":
                  if (action.direction === "bottom") {
                    await page.evaluate(() =>
                      window.scrollTo(0, document.body.scrollHeight)
                    );
                  } else if (action.direction === "top") {
                    await page.evaluate(() => window.scrollTo(0, 0));
                  } else if (action.direction === "down") {
                    await page.evaluate(
                      (amount) =>
                        window.scrollBy(0, amount || window.innerHeight),
                      action.amount
                    );
                  } else if (action.direction === "up") {
                    await page.evaluate(
                      (amount) =>
                        window.scrollBy(0, -(amount || window.innerHeight)),
                      action.amount
                    );
                  } else if (action.selector) {
                    await page.evaluate((selector) => {
                      const element = document.querySelector(selector);
                      if (element) element.scrollIntoView();
                    }, action.selector);
                  } else {
                    throw new Error(
                      "Scroll action requires 'direction': 'bottom', 'top', 'down', 'up', or a 'selector'."
                    );
                  }
                  await page.waitForTimeout(200);
                  break;
                case "hover":
                  if (!action.selector)
                    throw new Error("Hover action requires a 'selector'.");
                  await page.hover(action.selector, action.options);
                  break;
                case "focus":
                  if (!action.selector)
                    throw new Error("Focus action requires a 'selector'.");
                  await page.focus(action.selector, action.options);
                  break;
                case "press":
                  if (!action.selector)
                    throw new Error("Press action requires a 'selector'.");
                  if (!action.key)
                    throw new Error("Press action requires a 'key'.");
                  await page.press(action.selector, action.key, action.options);
                  break;
                case "evaluate":
                  if (
                    typeof action.script !== "function" &&
                    typeof action.script !== "string"
                  )
                    throw new Error(
                      "Evaluate action requires a 'script' (function or string)."
                    );
                  await page.evaluate(action.script, action.arg);
                  break;
                default:
                  console.warn(
                    `[ScreencastTask: ${url}] Unknown action type: ${action.type}`
                  );
              }
              await page.waitForTimeout(action.postActionDelay || 100);
            } catch (actionError) {
              console.error(
                `[ScreencastTask: ${url}] Error during action ${i + 1} (${
                  action.type
                }): ${actionError.message.split("\n")[0]}`
              );
              throw actionError;
            }
          }

          console.log(
            `[ScreencastTask: ${url}] (Adblock: ${use_adblock}) Actions complete. Finalizing video...`
          );

          const video = page.video();
          if (!video) {
            console.warn(
              `[ScreencastTask: ${url}] Video object not available prior to page close. Recording might have failed.`
            );
          }

          let videoPath = null;
          if (video) {
            try {
              if (!page.isClosed()) await page.close();
            } catch (pageCloseError) {
              console.warn(
                `[ScreencastTask: ${url}] Error closing page before getting video path: ${pageCloseError.message}`
              );
            }
          }

          await context.close();

          if (video) {
            videoPath = await video.path();
          } else {
            const files = fs.readdirSync(tempVideoDir);
            if (files.length > 0) {
              videoPath = path.join(tempVideoDir, files[0]);
              console.warn(
                `[ScreencastTask: ${url}] Video object was null, inferring path: ${videoPath}`
              );
            } else {
              throw new Error(
                `[ScreencastTask: ${url}] Video recording failed or video file not found.`
              );
            }
          }

          const videoBuffer = fs.readFileSync(videoPath);
          console.log(
            `[ScreencastTask: ${url}] (Adblock: ${use_adblock}) Screencast successful. Size: ${videoBuffer.length} bytes.`
          );

          fs.unlinkSync(videoPath);
          fs.rmdirSync(tempVideoDir);
          tempVideoDir = "";

          return videoBuffer;
        } catch (error) {
          console.error(
            `[ScreencastTask: ${url}] (Adblock: ${use_adblock}) Error during attempt ${attempt}: ${
              error.message.split("\n")[0]
            }`
          );
          if (page && !page.isClosed())
            await page.close().catch((e) => {
              /* ignore */
            });
          if (context)
            await context.close().catch((e) => {
              /* ignore cleanup error */
            });

          if (tempVideoDir) {
            try {
              if (fs.existsSync(tempVideoDir)) {
                const files = fs.readdirSync(tempVideoDir);
                files.forEach((file) =>
                  fs.unlinkSync(path.join(tempVideoDir, file))
                );
                fs.rmdirSync(tempVideoDir);
              }
            } catch (cleanupError) {
              console.warn(
                `[ScreencastTask: ${url}] Failed to cleanup temp video dir ${tempVideoDir}: ${cleanupError.message}`
              );
            }
            tempVideoDir = "";
          }

          if (attempt > max_retries) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * attempt * (attempt > 1 ? 2 : 1))
          );
        }
      }
      throw new Error(
        `[ScreencastTask: ${url}] (Adblock: ${use_adblock}) Unknown error after ${
          max_retries + 1
        } attempts.`
      );
    };

    return { taskFn, requirements: taskRequirements, originalUrl: url };
  }

  function queueScreencastTask(screencastTaskObject, priority = 0) {
    if (
      !screencastTaskObject ||
      typeof screencastTaskObject.taskFn !== "function" ||
      !screencastTaskObject.requirements ||
      typeof screencastTaskObject.originalUrl !== "string"
    ) {
      return Promise.reject(
        new Error(
          "Invalid task object. Use createScreencastTask to generate it. Must include taskFn, requirements, and originalUrl."
        )
      );
    }

    return queueTaskWithRequirements(
      screencastTaskObject.taskFn,
      screencastTaskObject.requirements,
      priority
    );
  }

  async function killBrowser(
    browserInstance,
    replenish = true,
    specificTypeToReplenish = null
  ) {
    const browserState = browsers.find((b) => b.browser === browserInstance);
    if (browserState) {
      const typeToReplenish = specificTypeToReplenish || browserState.type;
      console.log(
        `[Pool] Killing browser ${browserState.id} (type ${browserState.type})...`
      );
      _removeBrowserFromPool(browserState);
      if (replenish && !shuttingDown) {
        const currentOfTypeCount = browsers.filter(
          (b) => b.type === typeToReplenish
        ).length;
        const maxOfType =
          typeToReplenish === "adblock" ? pool_size_adblock : pool_size_default;

        if (currentOfTypeCount < maxOfType) {
          console.log(
            `[Pool] Attempting to replenish killed ${typeToReplenish} browser...`
          );
          try {
            await _launchBrowser(typeToReplenish);
            _processQueue();
          } catch (error) {
            console.error(
              `[Pool] Failed to replenish ${typeToReplenish} browser:`,
              error
            );
          }
        } else {
          console.log(
            `[Pool] Not replenishing ${typeToReplenish} browser, max count (${maxOfType}) reached for this type or pool shrinking.`
          );
        }
      }
    } else {
      console.warn(
        `[Pool] killBrowser: Browser instance not found in pool. Attempting to close if possible.`
      );
      try {
        if (browserInstance && browserInstance.isConnected()) {
          await browserInstance.close();
        }
      } catch (e) {
        /* ignore error during close of unknown instance */
        console.warn(`Browser Instance ${browserInstance} crashed. Ignoring!`);
      }
    }
  }

  async function shutdown(force = false) {
    console.log(`[Pool] Shutting down... (Force: ${force})`);
    shuttingDown = true;

    while (!taskQueue.isEmpty()) {
      const queuedItem = taskQueue.dequeue();
      queuedItem.reject(
        new Error("Browser pool is shutting down. Task cancelled.")
      );
    }

    const browsersToClose = [...browsers];
    const closePromises = browsersToClose.map(async (browserState) => {
      console.log(
        `[Pool] Closing browser ${browserState.id} (type: ${browserState.type})...`
      );
      try {
        await browserState.browser.close();
      } catch (error) {
        console.warn(
          `[Pool] Error explicitly closing browser ${browserState.id} (type: ${browserState.type}) during shutdown: ${error.message}`
        );

        _removeBrowserFromPool(browserState);
      }
    });

    await Promise.all(closePromises);

    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log("[Pool] All browsers closed. Shutdown complete.");
  }

  function getStats() {
    return {
      totalBrowsers: browsers.length,
      defaultBrowsers: browsers.filter((b) => b.type === "default").length,
      adblockBrowsers: browsers.filter((b) => b.type === "adblock").length,
      busyBrowsers: browsers.filter((b) => b.busy).length,
      idleBrowsers: browsers.filter((b) => !b.busy).length,
      queuedTasks: taskQueue.length,
      config: {
        pool_size_default,
        pool_size_adblock,
        adblockExtensionPath: adblockExtensionPath
          ? path.resolve(adblockExtensionPath)
          : null,
      },
    };
  }

  return {
    createScreencastTask,
    queueScreencastTask,
    createScreenshotTask,
    queueScreenshotTask,
    killBrowser,
    shutdown,
    getStats,
  };
}

async function main() {
  let pool;

  const uBlockPath =
    "/Users/kartikmudgal/Desktop/works/saas/wirklich/ext_ublock";
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
