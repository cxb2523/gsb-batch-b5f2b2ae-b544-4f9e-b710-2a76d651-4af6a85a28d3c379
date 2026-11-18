/**
 * Real-browser end-to-end verification of plane tap animation ownership,
 * formation switching and plane model (re)loading / GPU resource release.
 *
 * The script starts a static server for the built demo, launches a headless
 * Chrome over the DevTools protocol, performs real mouse clicks on the WebGL
 * canvas, and asserts on the renderer's `getDebugState()` snapshot.
 *
 * Requirements:
 *   - `npm run build` has been run (dist/js/es/index.js must exist)
 *   - Chrome installed; override its path with CHROME_PATH
 *   - puppeteer-core (devDependency)
 *
 * Usage: node tests/browser/check.js
 */
const puppeteer = require("puppeteer-core");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const VIEWPORT = { width: 1280, height: 900 };
const PORT = 8000 + (process.pid % 900);
const DEBUG_PORT = PORT + 1000;

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate));

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bin": "application/octet-stream"
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const results = [];
function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
        const filePath = path.join(ROOT, relative);

        // Never serve outside the project directory.
        if (!filePath.startsWith(ROOT)) {
            res.writeHead(403);
            res.end();
            return;
        }

        fs.readFile(filePath, (error, data) => {
            if (error) {
                res.writeHead(404);
                res.end();
                return;
            }
            res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
            res.end(data);
        });
    });

    return new Promise(resolve => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

async function waitForDevTools(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            return await new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${port}/json/version`, res => {
                    let body = "";
                    res.on("data", chunk => (body += chunk));
                    res.on("end", () => resolve(JSON.parse(body)));
                });
                req.on("error", reject);
                req.setTimeout(1000, () => req.destroy(new Error("timeout")));
            });
        } catch {
            await sleep(250);
        }
    }
    throw new Error("Chrome DevTools endpoint did not come up");
}

const getState = page => page.evaluate(() => window.__planeRenderer.getDebugState());
const getPlanePositions = page => page.evaluate(() => window.__planeRenderer.getPlaneScreenPositions());

async function waitForState(page, predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const state = await getState(page);
        if (predicate(state)) {
            return state;
        }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await getState(page))}`);
}

async function clickPlane(page, id) {
    // Planes bob with idle movement, so a plane can drift just off the edge of
    // the viewport for a moment. Wait briefly for a clickable position.
    const deadline = Date.now() + 8000;
    let plane;
    while (Date.now() < deadline) {
        plane = (await getPlanePositions(page)).find(candidate => candidate.id === id);
        if (plane === undefined) {
            throw new Error(`plane ${id} is not drawn`);
        }
        if (plane.visible
            && plane.x >= 5 && plane.x <= VIEWPORT.width - 5
            && plane.y >= 5 && plane.y <= VIEWPORT.height - 5) {
            break;
        }
        await sleep(100);
    }

    if (!plane.visible
        || plane.x < 5 || plane.x > VIEWPORT.width - 5
        || plane.y < 5 || plane.y > VIEWPORT.height - 5) {
        throw new Error(`plane ${id} is off-screen: ${JSON.stringify(plane)}`);
    }

    await page.mouse.click(plane.x, plane.y);
    await sleep(80);
}

async function setFormation(page, formation) {
    await page.evaluate(value => window.__planeRenderer.setFormation(value), formation);
    await sleep(120);
}

async function runChecks(page) {
    // Freeze the camera so plane screen positions stay stable while clicking.
    await page.evaluate(() => window.__planeRenderer.changeCameraMode());
    await sleep(300);

    // The dat.GUI overlay floats over the scene and would intercept clicks on
    // planes drawn beneath it. It is a dev overlay, not part of the scene.
    await page.addStyleTag({ content: ".dg { display: none !important; }" });
    await sleep(100);

    // 1. Initial state.
    let state = await getState(page);
    record(
        "initial: Triangle formation, model resident, taps enabled",
        state.formationPlaneIds.join(",") === "center,triangle-1,triangle-2"
        && state.tapEnabled === true
        && state.planeModel.liveBuffers === 4,
        JSON.stringify(state)
    );

    // 2. Clicking a satellite animates exactly that plane.
    await clickPlane(page, "triangle-1");
    state = await waitForState(page, st => st.animatedPlaneIds.length > 0, 3000, "triangle-1 animation");
    record(
        "clicking a satellite animates that exact plane",
        state.animatedPlaneIds.length === 1 && state.animatedPlaneIds[0] === "triangle-1",
        JSON.stringify(state.animatedPlaneIds)
    );

    // 3. Formation switch mid-animation keeps the animation on the same plane,
    //    even when the plane's draw index changes. triangle-1 is draw index 1 in
    //    Triangle but draw index 3 in LargeTriangle; an index-keyed animator
    //    would leave the animation behind on whichever plane took index 1.
    await setFormation(page, 2); // LargeTriangle: [center, lt-1, lt-2, triangle-1, triangle-2]
    state = await getState(page);
    record(
        "formation switch keeps a running animation on the same plane despite a new draw index",
        state.formationPlaneIds.indexOf("triangle-1") === 3
        && state.animatedPlaneIds.length === 1
        && state.animatedPlaneIds[0] === "triangle-1",
        `formation=${state.formationPlaneIds} animated=${state.animatedPlaneIds}`
    );

    // 4. Index-shift regression: Triangle index 2 -> Line index 2.
    // With index-keyed animations the animation would move onto line-2.
    await setFormation(page, 1); // Triangle
    await waitForState(page, st => st.animatedPlaneIds.length === 0, 5000, "animations settle");
    await clickPlane(page, "triangle-2");
    await waitForState(page, st => st.animatedPlaneIds.includes("triangle-2"), 3000, "triangle-2 animation");
    await setFormation(page, 5); // Line, whose index 2 is line-2
    state = await getState(page);
    record(
        "formation switch cannot move an animation onto another plane's slot",
        state.formationPlaneIds.join(",") === "center,line-1,line-2"
        && !state.animatedPlaneIds.includes("line-2")
        && !state.animatedPlaneIds.includes("triangle-2"),
        `formation=${state.formationPlaneIds} animated=${state.animatedPlaneIds}`
    );

    // 5. Taps in the new formation hit the new planes.
    await clickPlane(page, "line-2");
    state = await waitForState(page, st => st.animatedPlaneIds.length > 0, 3000, "line-2 animation");
    record(
        "taps after a formation switch hit the new formation's planes",
        state.animatedPlaneIds.length === 1 && state.animatedPlaneIds[0] === "line-2",
        JSON.stringify(state.animatedPlaneIds)
    );

    // 6. Plane model switch disables taps during the transition.
    const before = await getState(page);
    const transition = page.evaluate(() => window.__planeRenderer.changePlane());
    await sleep(150);
    state = await getState(page);
    record("taps are disabled while the plane model changes", state.tapEnabled === false, state.planeState);
    await transition;

    // 7. After the transition taps are enabled for the new preset, and the
    //    outgoing model's GPU buffers have been released.
    const expectedPreset = (before.currentPlane + 1) % 9;
    state = await waitForState(page, st => st.planeState === "NORMAL", 15000, "plane transition to finish");
    record(
        "after the model change, taps are re-enabled for the new preset",
        state.tapEnabled === true && state.currentPlane === expectedPreset && state.animatedPlaneIds.length === 0,
        JSON.stringify({ preset: state.currentPlane, animated: state.animatedPlaneIds })
    );
    record(
        "replaced model's buffers are released (only one preset resident)",
        state.planeModel.residentPresets.length === 1
        && state.planeModel.residentPresets[0] === expectedPreset
        && state.planeModel.liveBuffers === 4,
        JSON.stringify(state.planeModel)
    );

    // 8. Switching back reloads the previously released model.
    const liveBeforeBack = state.planeModel.liveBuffers;
    const createdBeforeBack = state.planeModel.createdBuffers;
    await page.evaluate(preset => window.__planeRenderer.changePlane(preset), before.currentPlane);
    state = await waitForState(page, st => st.planeState === "NORMAL", 15000, "switch back");
    record(
        "switching back reloads the previously released model",
        state.currentPlane === before.currentPlane
        && state.planeModel.residentPresets.length === 1
        && state.planeModel.residentPresets[0] === before.currentPlane
        && state.planeModel.createdBuffers > createdBeforeBack
        && state.planeModel.liveBuffers === liveBeforeBack,
        JSON.stringify({ preset: state.currentPlane, model: state.planeModel })
    );

    // 9. Repeated switches keep GPU buffers bounded.
    let maxLive = 0;
    for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.__planeRenderer.changePlane());
        await waitForState(page, st => st.planeState === "NORMAL", 15000, `model cycle ${i}`);
        maxLive = Math.max(maxLive, (await getState(page)).planeModel.liveBuffers);
    }
    state = await getState(page);
    record(
        "repeated model switches keep GPU buffers bounded at one plane's models",
        maxLive === liveBeforeBack && state.planeModel.residentPresets.length === 1,
        `maxLive=${maxLive} resident=${JSON.stringify(state.planeModel.residentPresets)}`
    );

    // 10. Tapping still works after model switches.
    await setFormation(page, 1); // Triangle
    await waitForState(page, st => st.animatedPlaneIds.length === 0, 5000, "animations settle");
    await clickPlane(page, "center");
    state = await waitForState(page, st => st.animatedPlaneIds.length > 0, 3000, "center animation after model switch");
    record(
        "tap after a model switch animates the drawn plane",
        state.animatedPlaneIds.length === 1 && state.animatedPlaneIds[0] === "center",
        JSON.stringify(state.animatedPlaneIds)
    );

    // 11. Terrain transition is unchanged.
    const terrainBefore = await page.evaluate(() => window.__planeRenderer.config.currentTerrain);
    await page.evaluate(() => window.__planeRenderer.changeTerrain());
    await sleep(2500);
    const terrainAfter = await page.evaluate(() => window.__planeRenderer.config.currentTerrain);
    record(
        "terrain transition still advances the terrain",
        terrainAfter !== terrainBefore,
        `${terrainBefore} -> ${terrainAfter}`
    );

    // 12. Palette switch is unchanged.
    const paletteBefore = await page.evaluate(() => window.__planeRenderer.config.currentPalette);
    await page.evaluate(() => window.__planeRenderer.changePlanePalette());
    await sleep(600);
    const paletteAfter = await page.evaluate(() => window.__planeRenderer.config.currentPalette);
    record(
        "palette switch still works",
        paletteAfter !== paletteBefore,
        `${paletteBefore} -> ${paletteAfter}`
    );
}

async function main() {
    if (CHROME === undefined) {
        throw new Error("Chrome/Edge not found; set CHROME_PATH to its executable");
    }

    const bundle = path.join(ROOT, "dist", "js", "es", "index.js");
    if (!fs.existsSync(bundle)) {
        throw new Error("dist/js/es/index.js is missing; run `npm run build` first");
    }

    const server = await startServer();
    const profileDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "plane-e2e-"));
    const chrome = spawn(CHROME, [
        "--headless=new",
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${DEBUG_PORT}`,
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        "about:blank"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let chromeLog = "";
    chrome.stdout.on("data", chunk => (chromeLog += chunk));
    chrome.stderr.on("data", chunk => (chromeLog += chunk));

    let browser;
    try {
        await waitForDevTools(DEBUG_PORT, 20000);
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
        const page = (await browser.pages())[0] ?? (await browser.newPage());
        await page.setViewport(VIEWPORT);

        const consoleErrors = [];
        page.on("console", message => {
            if (message.type() === "error") {
                consoleErrors.push(message.text());
            }
        });
        page.on("pageerror", error => consoleErrors.push(String(error)));

        await page.goto(`http://127.0.0.1:${PORT}/index.html?debug=1`, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForFunction(
            () => window.__planeRenderer !== undefined
                && window.__planeRenderer.getDebugState().planeState === "NORMAL",
            { timeout: 60000 }
        );

        await runChecks(page);

        record("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
    } catch (error) {
        record("browser run", false, `${error}\nchrome log: ${chromeLog.slice(-600)}`);
    } finally {
        if (browser !== undefined) {
            try {
                await browser.close();
            } catch {
                // Ignore: the browser may already have exited.
            }
        }
        chrome.kill();
        await new Promise(resolve => {
            const timer = setTimeout(resolve, 5000);
            chrome.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
            if (chrome.exitCode !== null) {
                clearTimeout(timer);
                resolve();
            }
        });
        server.close();
        try {
            fs.rmSync(profileDir, { recursive: true, force: true });
        } catch {
            // Windows may still hold the profile briefly; leave it for the OS to clean up.
        }
    }

    const failed = results.filter(result => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error("Browser check crashed:", error);
    process.exitCode = 1;
});
