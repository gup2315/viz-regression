import express from "express";
import puppeteer from "puppeteer";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import Queue from "promise-queue";
import { PNG } from "pngjs";
import crypto from "crypto";

const app   = express();
const queue = new Queue(1, Infinity);
const PORT  = process.env.PORT || 10000;

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data",    c => chunks.push(c));
    stream.on("end",     () => resolve(Buffer.concat(chunks)));
    stream.on("error",  reject);
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
    if (!url) return res.status(400).send("Missing 'url' query parameter.");

    // build keys
    const hash       = crypto.createHash("md5").update(url).digest("hex");
    const basePath   = `screenshots/${hash}`;
    const ts         = Date.now();
    const captureKey = `${basePath}/capture-${ts}.png`;
    const baselineKey= `${basePath}/baseline.png`;
    const diffKey    = `${basePath}/diff-${ts}.png`;

    // launch and snapshot
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

    // upload new capture
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key:    captureKey,
      Body:   screenshot,
      ContentType: "image/png",
    }));

    // attempt to fetch existing baseline
    let baselineBuffer;
    try {
      const { Body } = await s3.send(new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key:    baselineKey,
      }));
      baselineBuffer = await streamToBuffer(Body);
    } catch {
      // no baseline yet → save this one
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key:    baselineKey,
        Body:   screenshot,
        ContentType: "image/png",
      }));
      return res.json({
        message:      "Baseline created.",
        baseline_url: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${baselineKey}`,
      });
    }

    // compute diff
    const img1 = PNG.sync.read(baselineBuffer);
    const img2 = PNG.sync.read(screenshot);
    const { width, height } = img1;
    const diffImage = new PNG({ width, height });
    const numDiff = pixelmatch(
      img1.data, img2.data, diffImage.data, width, height,
      { threshold: 0.1 }
    );
    const diffBuffer = PNG.sync.write(diffImage);

    // upload diff
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key:    diffKey,
      Body:   diffBuffer,
      ContentType: "image/png",
    }));

    // return all three public URLs
    res.json({
      message:      `Diff complete with ${numDiff} pixels changed.`,
      capture_url:  `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${captureKey}`,
      baseline_url: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${baselineKey}`,
      diff_url:     `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${diffKey}`,
    });
  } catch (err) {
    console.error("Capture error:", err);
    if (browser) await browser.close();
    res.status(500).send("Error capturing the requested content.");
  }
}

app.listen(PORT, () => {
  console.log(`Puppeteer capture service running on port ${PORT}`);
});