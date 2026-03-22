/**
 * Baidu Space Article Scraper (wenzhang.baidu.com)
 * Uses Chrome cookies for authentication — no login required.
 */
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chrome = require('chrome-cookies-secure');
chromium.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const BASE_URL = 'https://wenzhang.baidu.com/';
const OUTPUT_DIR = path.join(__dirname, 'blog_backup', 'baidu');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

function getChromeCookies(url) {
  return new Promise((resolve, reject) => {
    chrome.getCookies(url, 'playwright', (err, raw) => {
      if (err) return reject(err);
      const domain = new URL(url).hostname;
      const cookies = Object.entries(raw || {}).map(([name, value]) => ({
        name, value: String(value),
        domain: '.' + domain.replace(/^[^.]+\./, ''), // e.g. .baidu.com
        path: '/', httpOnly: false, secure: false, sameSite: 'Lax',
      }));
      resolve(cookies);
    });
  });
}

function downloadImage(url, dest) {
  return new Promise((resolve) => {
    if (!url || url.startsWith('data:')) return resolve(false);
    const full = url.startsWith('//') ? 'https:' + url : url;
    const mod = full.startsWith('https') ? https : http;
    const req = mod.get(full, {
      headers: { 'Referer': 'https://wenzhang.baidu.com/', 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      if (res.statusCode >= 300 && res.headers.location) return downloadImage(res.headers.location, dest).then(resolve);
      if (res.statusCode !== 200) return resolve(false);
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => { f.close(); resolve(true); });
      f.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
  });
}

function slugify(s) {
  return (s || 'untitled').slice(0, 50)
    .replace(/[^\u4e00-\u9fff\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim() || 'untitled';
}

async function scrapeArticle(page, url, title) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Baidu wenzhang.baidu.com loads article content in an iframe from wenzhang.bdstatic.com
    // We must switch to the iframe to read the actual article text.
    let contentFrame = null;
    const frames = page.frames();
    for (const f of frames) {
      if (f.url().includes('bdstatic.com/page/content')) {
        contentFrame = f;
        break;
      }
    }

    let data;
    const extractContent = () => {
      const body = document.body;
      if (!body) return { md: '', imgs: [], date: '' };

      const imgs = [];
      body.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (src && !src.startsWith('data:') && !src.includes('static') && !src.includes('logo') && !src.includes('icon')) {
          imgs.push(src);
        }
      });

      const md = body.innerHTML
        .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => '\n' + '#'.repeat(+l+1) + ' ' + t.replace(/<[^>]+>/g,'').trim() + '\n')
        .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => '\n' + t.replace(/<[^>]+>/g,'').trim() + '\n')
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => '- ' + t.replace(/<[^>]+>/g,'').trim() + '\n')
        .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g,'')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/\u00a0/g,' ')
        .replace(/\n{3,}/g, '\n\n').trim();

      return { md, imgs, date: '' };
    };

    if (contentFrame) {
      try {
        await contentFrame.waitForLoadState('domcontentloaded');
        await contentFrame.waitForTimeout(1000);
        data = await contentFrame.evaluate(extractContent);
      } catch {
        data = { md: '', imgs: [], date: '' };
      }
    }

    // Fallback: try main page if iframe failed
    if (!data || !data.md || data.md.length < 20) {
      data = await page.evaluate(extractContent);
    }

    // Get date from main page
    const date = await page.evaluate(() => {
      const el = document.querySelector('time') || document.querySelector('[class*="date"]') || document.querySelector('.time');
      return el ? el.textContent?.trim() || '' : '';
    });
    if (date) data.date = date;

    if (!data.md || data.md.length < 10) return null;

    const slug = slugify(title);
    const imgDir = path.join(IMAGES_DIR, slug);
    fs.mkdirSync(imgDir, { recursive: true });
    let imgSaved = 0;
    for (let i = 0; i < data.imgs.length; i++) {
      const ext = (data.imgs[i].split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
      if (await downloadImage(data.imgs[i], path.join(imgDir, `img-${i+1}.${ext}`))) imgSaved++;
    }

    // Parse date
    const dateMatch = (data.date || url).match(/(\d{4}[-年]\d{1,2}[-月]\d{1,2})/);
    const dateStr = dateMatch
      ? dateMatch[1].replace(/[年月]/g, '-').replace(/日/, '').slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const content = `---\ntitle: "${title.replace(/"/g,'\\"')}"\ndate: "${dateStr}"\nurl: "${url}"\nsource: "百度空间"\n---\n\n# ${title}\n\n${data.md}`;
    fs.writeFileSync(path.join(OUTPUT_DIR, `${dateStr}-${slug}.md`), content, 'utf-8');
    return { imgSaved, date: dateStr };
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('Reading Baidu cookies from Chrome...');
  let cookies;
  try {
    cookies = await getChromeCookies('https://wenzhang.baidu.com');
    console.log(`✓ Got ${cookies.length} cookies\n`);
  } catch (e) {
    console.error('Failed to read cookies:', e.message);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
  });
  await ctx.addCookies(cookies);

  const page = await ctx.newPage();
  console.log('Loading Baidu Space...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  console.log('Title:', await page.title());
  console.log('URL:', page.url());

  // Scroll to load all articles (more iterations to find all)
  process.stdout.write('Scrolling');
  for (let i = 0; i < 60; i++) {
    const prev = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    const curr = await page.evaluate(() => document.body.scrollHeight);
    process.stdout.write('.');
    if (curr === prev) break;
  }
  console.log();

  // Extract article links (format: /page/view?key=XXXXX)
  const articles = await page.evaluate(() => {
    const seen = new Set(), items = [];
    document.querySelectorAll('a[href*="/page/view"], a[href*="wenzhang.baidu.com/page"]').forEach(el => {
      const href = el.href || '';
      const t = el.textContent?.trim() || el.title || '';
      if (href && t && t.length > 2 && !seen.has(href)) {
        seen.add(href);
        items.push({ url: href, title: t });
      }
    });
    return items;
  });

  // Remove duplicate titles (same article linked twice with/without text)
  const deduped = [];
  const titleseen = new Set();
  for (const a of articles) {
    if (!titleseen.has(a.title)) {
      titleseen.add(a.title);
      deduped.push(a);
    }
  }

  console.log(`\nFound ${deduped.length} articles\n`);
  if (!deduped.length) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'debug-index.html'), await page.content());
    console.log('No articles found. Saved debug-index.html');
    await browser.close(); return;
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'article-list.json'), JSON.stringify(deduped, null, 2));

  // Check existing files — re-scrape if content is too small (< 500 bytes = empty shell)
  const existingFiles = new Map();
  for (const f of fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.md'))) {
    const size = fs.statSync(path.join(OUTPUT_DIR, f)).size;
    // Extract title from frontmatter
    const content = fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf-8');
    const titleMatch = content.match(/^title:\s*"(.+?)"/m);
    if (titleMatch) existingFiles.set(titleMatch[1], { file: f, size });
  }
  const MIN_SIZE = 500; // bytes — below this is an empty shell

  let ok = 0, fail = 0, skipped = 0;
  for (let i = 0; i < deduped.length; i++) {
    const { url, title } = deduped[i];
    const existing = existingFiles.get(title);
    if (existing && existing.size >= MIN_SIZE) {
      skipped++;
      continue; // Already has real content
    }
    process.stdout.write(`[${i+1}/${deduped.length}] ${existing ? '🔄' : '🆕'} ${title.slice(0,43).padEnd(43)} `);
    const r = await scrapeArticle(page, url, title);
    if (r) { console.log(`✓ ${r.date} (${r.imgSaved} imgs)`); ok++; }
    else { console.log('✗'); fail++; }
    await page.waitForTimeout(800);
  }
  console.log(`\nSkipped ${skipped} articles with existing content`);

  console.log(`\n✅ Baidu done: ${ok} saved, ${fail} failed`);
  console.log(`📁 ${OUTPUT_DIR}`);
  await browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
