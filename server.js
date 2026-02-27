const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const pLimit = require('p-limit');
const archiver = require('archiver');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const MAX_CONCURRENT = 2;
const MAX_PAGES = 20;

async function cloneSite(startUrl) {
  const domain = new URL(startUrl).hostname;
  const OUTPUT_DIR = path.join(__dirname, "backups", domain);

  await fs.emptyDir(OUTPUT_DIR);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const visited = new Set();
  const queue = [startUrl];
  const limit = pLimit(MAX_CONCURRENT);

  async function saveFile(fileUrl, buffer) {
    try {
      const parsed = new URL(fileUrl);
      if (parsed.hostname !== domain) return;

      let filePath = path.join(
        OUTPUT_DIR,
        decodeURIComponent(parsed.pathname)
      );

      if (filePath.endsWith("/")) filePath += "index.html";
      if (!path.extname(filePath)) filePath += ".html";

      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, buffer);
    } catch {}
  }

  async function crawl(url) {
    if (visited.has(url) || visited.size >= MAX_PAGES) return;
    visited.add(url);

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => req.continue());

    page.on('response', async response => {
      try {
        const resUrl = response.url();
        const buffer = await response.buffer();
        await saveFile(resUrl, buffer);
      } catch {}
    });

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });

      const content = await page.content();
      await saveFile(url, Buffer.from(content));

      const links = await page.$$eval("a[href]", as => as.map(a => a.href));

      for (let link of links) {
        try {
          const parsed = new URL(link);
          if (parsed.hostname === domain && !visited.has(link)) {
            queue.push(link);
          }
        } catch {}
      }

    } catch {}

    await page.close();
  }

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const batch = queue.splice(0, MAX_CONCURRENT);
    await Promise.all(batch.map(u => limit(() => crawl(u))));
  }

  await browser.close();
  return domain;
}

app.post('/backup', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).send("Missing URL");

  try {
    const domain = await cloneSite(url);
    res.json({ message: "Backup completed!", domain });
  } catch (err) {
    res.status(500).send("Backup failed");
  }
});

app.get('/list', async (req, res) => {
  const folder = path.join(__dirname, "backups");
  await fs.ensureDir(folder);
  const folders = await fs.readdir(folder);
  res.json(folders);
});

app.get('/download/:domain', async (req, res) => {
  const domain = req.params.domain;
  const folderPath = path.join(__dirname, "backups", domain);

  const archive = archiver('zip', { zlib: { level: 9 } });
  res.attachment(`${domain}.zip`);
  archive.pipe(res);
  archive.directory(folderPath, false);
  archive.finalize();
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
