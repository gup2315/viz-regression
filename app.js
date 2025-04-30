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
const s3 = new S3Client({ region: process.env.AWS_REGION });

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
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

    let ignoreRegions = [];
    if (ignore) {
      try {
        const parsed = JSON.parse(ignore);
        ignoreRegions = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return res.status(400).send("Invalid JSON for ignore regions");
      }
    }

    const hash = crypto.createHash("md5").update(url).digest("hex");
    const base = `screenshots/${hash}`;
    const now = Date.now();
    const rawKey = `${base}/capture-${now}.png`;
    const baselineKey = `${base}/baseline.png`;
    const diffKey = `${base}/diff-${now}.png`;

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      protocolTimeout: 180000,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultNavigationTimeout(180000);
    page.setDefaultTimeout(180000);

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    );

    console.log(`[NAVIGATE] ${url}`);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 180000,
    });

    let handle;
    try {
      await page.waitForSelector(".mtc-eyebrow", { timeout: 60000 });
      handle = await page.$(".mtc-eyebrow");
    } catch {
      console.warn("Fallback to .main-content");
      handle = await page.$(".main-content");

      if (!handle) {
        console.warn("Fallback to <body>");
        handle = await page.$("body");
      }
    }

    if (!handle) throw new Error("Capture element not found");

    console.log("Waiting up to 120s for charts to render…");
    await Promise.race([
      page.waitForSelector(".mtc-eyebrow svg, .mtc-eyebrow canvas", { timeout: 20000 }),
      new Promise((resolve) => setTimeout(resolve, 120000)),
    ]);

    const screenshot = await handle.screenshot({ type: "png", timeout: 0 });
    await browser.close();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: rawKey,
      Body: screenshot,
      ContentType: "image/png",
    }));

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

    const img1 = PNG.sync.read(baselineBuffer);
    const img2 = PNG.sync.read(screenshot);

    ignoreRegions.forEach(({ x, y, width: w, height: h }) => {
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const idx = (yy * img1.width + xx) * 4;
          img1.data[idx]     = img2.data[idx];
          img1.data[idx + 1] = img2.data[idx + 1];
          img1.data[idx + 2] = img2.data[idx + 2];
          img1.data[idx + 3] = img2.data[idx + 3];
        }
      }
    });

    const diff = new PNG({ width: img1.width, height: img1.height });
    const numDiff = pixelmatch(
      img1.data,
      img2.data,
      diff.data,
      img1.width,
      img1.height,
      { threshold: 0.1 }
    );
    const diffBuf = PNG.sync.write(diff);

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: diffKey,
      Body: diffBuf,
      ContentType: "image/png",
    }));

    const [captureUrl, baselineUrl, diffUrl] = await Promise.all([
      getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: rawKey }), { expiresIn: 3600 }),
      getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: baselineKey }), { expiresIn: 3600 }),
      getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: diffKey }), { expiresIn: 3600 }),
    ]);

    res.json({
      message: `Diff complete: ${numDiff} pixels changed`,
      capture_url: captureUrl,
      baseline_url: baselineUrl,
      diff_url: diffUrl,
    });

  } catch (err) {
    console.error("Capture Error:", err);
    if (browser) await browser.close();
    res.status(500).send("Capture Error");
  }
}

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});