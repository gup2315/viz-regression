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
    const { url } = req.query;
    if (!url) return res.status(400).send("Missing url parameter");

    // build your S3 keys
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
      protocolTimeout: 180000, // 3 minutes for all CDP calls
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // bump default timeouts on the page
    page.setDefaultNavigationTimeout(180000); // 3 min for page.goto
    page.setDefaultTimeout(180000);           // 3 min for waits

    // navigate
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 180000,
    });

    // find your capture element
    let handle;
    try {
      await page.waitForSelector(".mtc-eyebrow", { timeout: 60000 });
      handle = await page.$(".mtc-eyebrow");
    } catch {
      console.warn("Fallback to <main>");
      await page.waitForSelector("main", { timeout: 15000 });
      handle = await page.$("main");
    }
    if (!handle) throw new Error("Capture element not found");

    // extra time for dynamic content
    console.log("Waiting 2 minutes for dynamic content…");
    await new Promise((resolve) => setTimeout(resolve, 120000));

    // take the screenshot with NO timeout
    const screenshot = await handle.screenshot({
      type: "png",
      timeout: 0,
    });
    await browser.close();

    // upload raw capture
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: rawKey,
        Body: screenshot,
        ContentType: "image/png",
      })
    );

    // try loading a baseline
    let baselineBuffer;
    try {
      const baseline = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: baselineKey,
        })
      );
      baselineBuffer = await streamToBuffer(baseline.Body);
    } catch {
      // no baseline yet → create it
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: baselineKey,
          Body: screenshot,
          ContentType: "image/png",
        })
      );
      const baselineUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: baselineKey,
        }),
        { expiresIn: 3600 }
      );
      return res.json({
        message: "Baseline created",
        baseline_url: baselineUrl,
      });
    }

    // pixel-diff
    const img1 = PNG.sync.read(baselineBuffer);
    const img2 = PNG.sync.read(screenshot);
    const { width, height } = img1;
    const diff = new PNG({ width, height });
    const numDiff = pixelmatch(
      img1.data,
      img2.data,
      diff.data,
      width,
      height,
      { threshold: 0.1 }
    );
    const diffBuf = PNG.sync.write(diff);

    // upload diff
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: diffKey,
        Body: diffBuf,
        ContentType: "image/png",
      })
    );

    // generate signed URLs
    const [captureUrl, baselineUrl, diffUrl] = await Promise.all([
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: rawKey,
        }),
        { expiresIn: 3600 }
      ),
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: baselineKey,
        }),
        { expiresIn: 3600 }
      ),
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: diffKey,
        }),
        { expiresIn: 3600 }
      ),
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