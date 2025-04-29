import express from "express";
import puppeteer from "puppeteer";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import Queue from "promise-queue";
import PDFDocument from "pdfkit";
import { PNG } from "pngjs";
import crypto from "crypto";

const queue = new Queue(1, Infinity);
const app = express();
const PORT = process.env.PORT || 10000;
const chromePath = "/usr/bin/google-chrome-stable";

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    const { url, type } = req.query;
    if (!url) return res.status(400).send("Missing 'url' query parameter.");
    const isPDF = type && type.toLowerCase() === "pdf";

    const urlHash = crypto.createHash("md5").update(url).digest("hex");
    const basePath = `screenshots/${urlHash}`;
    const timestamp = Date.now();
    const fileName = `${basePath}/capture-${timestamp}.png`;
    const baselineKey = `${basePath}/baseline.png`;
    const diffKey = `${basePath}/diff-${timestamp}.png`;

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      timeout: 60000,
      protocolTimeout: 60000,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117 Safari/537.36"
    );
    await page.setViewport({ width: 1220, height: 1000 });

    await safeGoto(page, url);
    await page.waitForSelector("mtc-eyebrow", { timeout: 30000 });

    const elementHandle = await page.$("mtc-eyebrow");
    const box = await elementHandle.boundingBox();
    if (!box) throw new Error("Could not determine bounding box");
    const screenshot = await elementHandle.screenshot({ type: "png" });

    await browser.close();

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: fileName,
        Body: screenshot,
        ContentType: "image/png",
      })
    );

    let baselineBuffer;
    try {
      const baseline = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: baselineKey,
        })
      );
      baselineBuffer = await streamToBuffer(baseline.Body);
    } catch (err) {
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: baselineKey,
          Body: screenshot,
          ContentType: "image/png",
        })
      );
      return res.json({
        message: "Baseline created.",
        url: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${baselineKey}`,
      });
    }

    const img1 = PNG.sync.read(baselineBuffer);
    const img2 = PNG.sync.read(screenshot);
    const { width, height } = img1;
    const diff = new PNG({ width, height });

    const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, {
      threshold: 0.1,
    });

    const diffBuffer = PNG.sync.write(diff);

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: diffKey,
        Body: diffBuffer,
        ContentType: "image/png",
      })
    );

    res.json({
      message: `Diff complete with ${numDiffPixels} pixels changed`,
      diff_url: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${diffKey}`,
    });
  } catch (err) {
    console.error("Capture error:", err);
    if (browser) await browser.close();
    res.status(500).send("Error capturing the requested content.");
  }
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

app.listen(PORT, () => {
  console.log(`Puppeteer capture service running on port ${PORT}`);
});