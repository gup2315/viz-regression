import express from "express";
import puppeteer from "puppeteer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import Queue from "promise-queue";
import { PNG } from "pngjs";
import crypto from "crypto";

const app = express();
const queue = new Queue(1, Infinity);
const PORT = process.env.PORT || 10000;
const chromePath = "/usr/bin/google-chrome-stable";

const s3 = new S3Client({ region: process.env.AWS_REGION });

// helper to collect stream into a Buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// safeGoto: race page.goto against a manual reject after `timeout` ms
async function safeGoto(page, url, timeout = 60000) {
  return Promise.race([
    page.goto(url, { waitUntil: "domcontentloaded", timeout }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Manual navigation timeout")), timeout)
    ),
  ]);
}

app.get("/capture", (req, res) => {
  queue.add(() => handleCapture(req, res));
});

async function handleCapture(req, res) {
  let browser;
  try {
    const { default: pixelmatch } = await import("pixelmatch");
    const { url, ignore } = req.query;
    if (!url) return res.status(400).send("Missing url parameter");

    // parse ignore regions
    let ignoreRegions = [];
    if (ignore) {
      try {
        ignoreRegions = JSON.parse(ignore);
      } catch {
        return res.status(400).send("Invalid JSON for ignore regions");
      }
    }

    // build S3 keys
    const hash = crypto.createHash("md5").update(url).digest("hex");
    const base = `screenshots/${hash}`;
    const now = Date.now();
    const rawKey      = `${base}/capture-${now}.png`;
    const baselineKey = `${base}/baseline.png`;
    const diffKey     = `${base}/diff-${now}.png`;

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      protocolTimeout: 60000, // 1 min CDP timeout
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    // navigate with our safe timeout
    try {
      await safeGoto(page, url, 60000);
    } catch (err) {
      console.warn(`Navigation warning: ${err.message}`);
    }

    // wait for your target element (or fallback)
    let handle = null;
    try {
      await page.waitForSelector(".mtc-eyebrow", { timeout: 30000 });
      handle = await page.$(".mtc-eyebrow");
    } catch {
      console.warn(".mtc-eyebrow not found, trying <main>…");
      try {
        await page.waitForSelector("main", { timeout: 15000 });
        handle = await page.$("main");
      } catch {
        console.warn("main not found, falling back to full-page");
      }
    }

    // take screenshot (selector or full page)
    const screenshot = handle
      ? await handle.screenshot({ type: "png", timeout: 0 })
      : await page.screenshot({ type: "png", fullPage: true, timeout: 0 });

    // upload raw
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: rawKey,
      Body: screenshot,
      ContentType: "image/png",
    }));

    // load or init baseline
    let baselineBuffer;
    try {
      const baselineObj = await s3.send(new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: baselineKey,
      }));
      baselineBuffer = await streamToBuffer(baselineObj.Body);
    } catch {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: baselineKey,
        Body: screenshot,
        ContentType: "image/png",
      }));
      const baselineUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: baselineKey }),
        { expiresIn: 3600 }
      );
      return res.json({ message: "Baseline created", baseline_url: baselineUrl });
    }

    // diff
    const img1 = PNG.sync.read(baselineBuffer);
    const img2 = PNG.sync.read(screenshot);
    ignoreRegions.forEach(({ x, y, width: w, height: h }) => {
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const idx = (yy * img1.width + xx) * 4;
          img1.data[idx + 0] = img2.data[idx + 0];
          img1.data[idx + 1] = img2.data[idx + 1];
          img1.data[idx + 2] = img2.data[idx + 2];
          img1.data[idx + 3] = img2.data[idx + 3];
        }
      }
    });

    const diff = new PNG({ width: img1.width, height: img1.height });
    const numDiff = pixelmatch(
      img1.data, img2.data, diff.data,
      img1.width, img1.height,
      { threshold: 0.1 }
    );
    const diffBuf = PNG.sync.write(diff);

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: diffKey,
      Body: diffBuf,
      ContentType: "image/png",
    }));

    // signed URLs
    const [capture_url, baseline_url, diff_url] = await Promise.all([
      getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: rawKey }),      { expiresIn: 3600 }),
      getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: baselineKey }), { expiresIn: 3600 }),
      getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: diffKey }),     { expiresIn: 3600 }),
    ]);

    res.json({
      message: `Diff complete: ${numDiff} pixels changed`,
      capture_url,
      baseline_url,
      diff_url,
    });

  } catch (err) {
    console.error("Capture Error:", err);
    res.status(500).send("Capture Error");
  } finally {
    if (browser) {
      try { await browser.close(); }
      catch (e) { console.warn("Error closing browser:", e); }
    }
  }
}

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});