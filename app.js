import express from "express";
import puppeteer from "puppeteer";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
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
    stream.on("data", (c) => chunks.push(c));
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
    if (!url) return res.status(400).send("Missing url");

    const hash = crypto.createHash("md5").update(url).digest("hex");
    const base = `screenshots/${hash}`;
    const now = Date.now();
    const rawKey = `${base}/capture-${now}.png`;
    const baselineKey = `${base}/baseline.png`;
    const diffKey = `${base}/diff-${now}.png`;

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1900, height: 1000 });

    // Give heavy JS sites extra time to fully load
    await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

    // Ensure page animations/rendering is settled
    await page.evaluate(() => new Promise(requestAnimationFrame));

    // Try to wait for the element with fallback
    let handle;
    try {
      await page.waitForSelector(".mtc-eyebrow", { timeout: 30000 });
      handle = await page.$(".mtc-eyebrow");
    } catch {
      console.warn("Falling back to <main> selector...");
      await page.waitForSelector("main", { timeout: 15000 });
      handle = await page.$("main");
    }

    if (!handle) throw new Error("Could not find any suitable capture element");
    const png = await handle.screenshot({ type: "png" });
    await browser.close();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: rawKey,
      Body: png,
      ContentType: "image/png",
    }));

    let baselineBuf;
    try {
      const existing = await s3.send(new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: baselineKey,
      }));
      baselineBuf = await streamToBuffer(existing.Body);
    } catch {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: baselineKey,
        Body: png,
        ContentType: "image/png",
      }));
      const signedBaseline = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: baselineKey }),
        { expiresIn: 3600 }
      );
      return res.json({ message: "Baseline created", baseline_url: signedBaseline });
    }

    const img1 = PNG.sync.read(baselineBuf);
    const img2 = PNG.sync.read(png);
    const { width, height } = img1;
    const diff = new PNG({ width, height });
    const numDiff = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 });
    const diffBuf = PNG.sync.write(diff);

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: diffKey,
      Body: diffBuf,
      ContentType: "image/png",
    }));

    const captureUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: rawKey }),
      { expiresIn: 3600 }
    );
    const baselineUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: baselineKey }),
      { expiresIn: 3600 }
    );
    const diffUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: diffKey }),
      { expiresIn: 3600 }
    );

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