import express from "express";
import puppeteer from "puppeteer";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import Queue from "promise-queue";
import PDFDocument from "pdfkit";
import { PNG } from "pngjs";
import crypto from "crypto";

const queue = new Queue(1, Infinity);
const app = express();
const PORT = process.env.PORT || 10000;

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// helper to turn a ReadableStream into a Buffer
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
    if (!url) return res.status(400).send("Missing 'url' query parameter.");

    // create deterministic keys
    const hash = crypto.createHash("md5").update(url).digest("hex");
    const base = `screenshots/${hash}`;
    const now = Date.now();
    const captureKey  = `${base}/capture-${now}.png`;
    const baselineKey = `${base}/baseline.png`;
    const diffKey     = `${base}/diff-${now}.png`;

    // launch and snap
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width:1220, height:1000 });
    await page.goto(url, { waitUntil:"networkidle2" });
    await page.waitForSelector(".mtc-eyebrow", { timeout:60000 });
    const el = await page.$(".mtc-eyebrow");
    const screenshot = await el.screenshot({ type:"png" });
    await browser.close();

    // upload capture
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: captureKey,
      Body: screenshot,
      ContentType: "image/png"
    }));

    // fetch or create baseline
    let baselineBuffer;
    try {
      const got = await s3.send(new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: baselineKey
      }));
      baselineBuffer = await streamToBuffer(got.Body);
    } catch {
      // first run: store this as baseline
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: baselineKey,
        Body: screenshot,
        ContentType: "image/png"
      }));
      // return a signed URL for the baseline
      const url = await getSignedUrl(s3,
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: baselineKey
        }),
        { expiresIn: 60 * 60 } // 1 hour
      );
      return res.json({ message:"Baseline created.", baseline_url:url });
    }

    // diff
    const img1 = PNG.sync.read(baselineBuffer);
    const img2 = PNG.sync.read(screenshot);
    const diff = new PNG({ width:img1.width, height:img1.height });
    const numDiff = pixelmatch(
      img1.data, img2.data, diff.data,
      img1.width, img1.height,
      { threshold:0.1 }
    );
    const diffBuffer = PNG.sync.write(diff);

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: diffKey,
      Body: diffBuffer,
      ContentType:"image/png"
    }));

    // generate signed URLs (good for 1 hour each)
    const captureUrl  = await getSignedUrl(s3, new GetObjectCommand({ Bucket:process.env.S3_BUCKET_NAME, Key:captureKey }), { expiresIn:3600 });
    const diffUrl     = await getSignedUrl(s3, new GetObjectCommand({ Bucket:process.env.S3_BUCKET_NAME, Key:diffKey    }), { expiresIn:3600 });

    res.json({
      message:       `Diff complete: ${numDiff} pixels changed.`,
      capture_url:   captureUrl,
      diff_url:      diffUrl
    });
  }
  catch (err) {
    console.error("Capture error:", err);
    if (browser) await browser.close();
    res.status(500).send("Error capturing the requested content.");
  }
}

app.listen(PORT, () => {
  console.log(`Puppeteer capture service running on port ${PORT}`);
});