import express from "express";
import puppeteer from "puppeteer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import Queue from "promise-queue";
import { PNG } from "pngjs";
import crypto from "crypto";

const queue = new Queue(1, Infinity);
const app   = express();
const PORT  = process.env.PORT || 10000;

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// helper to drain a streaming Body into a Buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data",    c => chunks.push(c));
    stream.on("end",     () => resolve(Buffer.concat(chunks)));
    stream.on("error",  reject);
  });
}

async function handleCapture(req, res) {
  let browser;
  try {
    const { default: pixelmatch } = await import("pixelmatch");
    const { url } = req.query;
    if (!url) return res.status(400).send("Missing 'url' query parameter.");

    // build stable S3 keys
    const hash       = crypto.createHash("md5").update(url).digest("hex");
    const basePath   = `screenshots/${hash}`;
    const ts         = Date.now();
    const captureKey = `${basePath}/capture-${ts}.png`;
    const baselineKey= `${basePath}/baseline.png`;
    const diffKey    = `${basePath}/diff-${ts}.png`;

    // launch Puppeteer and take the snippet
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"],
      timeout: 60000,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1220, height: 1000 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector(".mtc-eyebrow", { timeout: 60000 });

    const el         = await page.$(".mtc-eyebrow");
    const screenshot = await el.screenshot({ type: "png" });
    await browser.close();

    // upload the new capture
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key:    captureKey,
      Body:   screenshot,
      ContentType: "image/png",
    }));

    // try to fetch existing baseline
    let baselineBuffer;
    try {
      const { Body } = await s3.send(new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key:    baselineKey,
      }));
      baselineBuffer = await streamToBuffer(Body);
    } catch {
      // no baseline → save this one as baseline
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key:    baselineKey,
        Body:   screenshot,
        ContentType: "image/png",
      }));
      const baselineUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key:    baselineKey,
        }),
        { expiresIn: 3600 }
      );
      return res.json({ 
        message:      "Baseline created.",
        baseline_url: baselineUrl
      });
    }

    // diff it
    const img1 = PNG.sync.read(baselineBuffer);
    const img2 = PNG.sync.read(screenshot);
    const { width, height } = img1;
    const diffImage = new PNG({ width, height });
    const numDiff = pixelmatch(
      img1.data, img2.data, diffImage.data, width, height,
      { threshold: 0.1 }
    );
    const diffBuffer = PNG.sync.write(diffImage);

    // upload the diff
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key:    diffKey,
      Body:   diffBuffer,
      ContentType: "image/png",
    }));

    // generate presigned URLs
    const [ capUrl, baseUrl, diffUrl ] = await Promise.all([
      getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: captureKey }), { expiresIn: 3600 }),
      getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: baselineKey }),{ expiresIn: 3600 }),
      getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: diffKey }),    { expiresIn: 3600 }),
    ]);

    return res.json({
      message:        `Diff complete with ${numDiff} pixels changed.`,
      capture_url:    capUrl,
      baseline_url:   baseUrl,
      diff_url:       diffUrl,
    });
  } catch (err) {
    console.error("Capture error:", err);
    if (browser) await browser.close();
    res.status(500).send("Error capturing the requested content.");
  }
}

app.get("/capture", (req, res) => {
  queue.add(() => handleCapture(req, res));
});

app.listen(PORT, () => {
  console.log(`Puppeteer capture service running on port ${PORT}`);
});