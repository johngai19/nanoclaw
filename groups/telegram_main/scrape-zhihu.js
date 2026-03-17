/**
 * Zhihu Article Scraper — Cookie injection from Chrome
 * No login required. Reads existing Chrome cookies automatically.
 */
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chrome = require('chrome-cookies-secure');
chromium.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PROFILE_URL = 'https://www.zhihu.com/people/weisiauto/posts';
const OUTPUT_DIR = path.join(__dirname, 'blog_backup', 'zhihu');
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
        domain: '.' + domain.replace(/^www\./, ''),
        path: '/', httpOnly: false, secure: true, sameSite: 'Lax',
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
      headers: { 'Referer': 'https://www.zhihu.com/', 'User-Agent': 'Mozilla/5.0' }
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      const el = document.querySelector('.Post-RichTextContainer') ||
                 document.querySelector('.RichText') ||
                 document.querySelector('[class*="Post-RichText"]');
      if (!el) return null;
      const imgs = [];
      el.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('data-original') || img.getAttribute('data-actualsrc') || img.src || '';
        if (src && !src.startsWith('data:')) imgs.push(src);
      });
      const dateEl = document.querySelector('time');
      const date = dateEl ? (dateEl.getAttribute('datetime') || dateEl.textContent || '').slice(0, 10) : '';
      const md = el.innerHTML
        .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => '\n' + '#'.repeat(+l+1) + ' ' + t.replace(/<[^>]+>/g,'').trim() + '\n')
        .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => '\n' + t.replace(/<[^>]+>/g,'').trim() + '\n')
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => '- ' + t.replace(/<[^>]+>/g,'').trim() + '\n')
        .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g,'')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
        .replace(/\n{3,}/g, '\n\n').trim();
      return { md, imgs, date };
    });

    if (!data || !data.md) return null;

    const slug = slugify(title);
    const imgDir = path.join(IMAGES_DIR, slug);
    fs.mkdirSync(imgDir, { recursive: true });
    let imgSaved = 0;
    for (let i = 0; i < data.imgs.length; i++) {
      const ext = (data.imgs[i].split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
      if (await downloadImage(data.imgs[i], path.join(imgDir, `img-${i+1}.${ext}`))) imgSaved++;
    }
    const dateStr = data.date || new Date().toISOString().slice(0, 10);
    const content = `---\ntitle: "${title.replace(/"/g,'\\"')}"\ndate: "${dateStr}"\nurl: "${url}"\nsource: "zhihu"\n---\n\n# ${title}\n\n${data.md}`;
    fs.writeFileSync(path.join(OUTPUT_DIR, `${dateStr}-${slug}.md`), content, 'utf-8');
    return { imgSaved, date: dateStr };
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('Reading Zhihu cookies from Chrome...');
  let cookies;
  try {
    cookies = await getChromeCookies('https://www.zhihu.com');
    console.log(`✓ Got ${cookies.length} cookies\n`);
  } catch (e) {
    console.error('Failed to read Chrome cookies:', e.message);
    console.error('Make sure Chrome is installed and you have logged into Zhihu.');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
  });
  await ctx.addCookies(cookies);

  const page = await ctx.newPage();

  // Verify login
  console.log('Verifying Zhihu login...');
  await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  const title0 = await page.title();
  if (title0.includes('安全验证')) {
    console.error('Security check still triggered. Please log in to Zhihu in Chrome first.');
    await browser.close(); process.exit(1);
  }
  const loggedIn = await page.evaluate(() =>
    !!document.querySelector('.AppHeader-profile, [class*="Avatar"], .UserAvatar')
  );
  console.log(loggedIn ? '✓ Logged in\n' : '⚠ Not logged in, but no security check — proceeding\n');

  // Load articles page
  console.log('Loading articles page...');
  await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Scroll
  process.stdout.write('Scrolling');
  for (let i = 0; i < 25; i++) {
    const prev = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    const curr = await page.evaluate(() => document.body.scrollHeight);
    process.stdout.write('.');
    if (curr === prev) break;
  }
  console.log();

  // Extract articles using confirmed selectors
  const articles = await page.evaluate(() => {
    const seen = new Set(), items = [];
    // Method 1: ContentItem-title h2 links (most reliable)
    document.querySelectorAll('.ContentItem-title a, h2.ContentItem-title a').forEach(el => {
      const href = (el.href || '').split('?')[0];
      const t = el.textContent?.trim() || '';
      if (href && t && href.includes('zhuanlan.zhihu.com/p/') && !seen.has(href)) {
        seen.add(href); items.push({ url: href, title: t });
      }
    });
    // Method 2: all zhuanlan.zhihu.com/p/ links
    if (items.length === 0) {
      document.querySelectorAll('a[href*="zhuanlan.zhihu.com/p/"]').forEach(el => {
        const href = (el.href || '').split('?')[0];
        const t = el.textContent?.trim() || '';
        if (href && t && t.length > 2 && !seen.has(href) && href !== 'https://zhuanlan.zhihu.com/write') {
          seen.add(href); items.push({ url: href, title: t });
        }
      });
    }
    return items;
  });

  console.log(`\nFound ${articles.length} articles`);
  if (!articles.length) {
    const html = await page.content();
    fs.writeFileSync(path.join(OUTPUT_DIR, 'debug.html'), html);
    console.log('No articles found. Saved debug.html. URL:', page.url());
    await browser.close(); return;
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'article-list.json'), JSON.stringify(articles, null, 2));
  console.log('Article list saved\n');

  let ok = 0, fail = 0;
  for (let i = 0; i < articles.length; i++) {
    const { url, title } = articles[i];
    process.stdout.write(`[${i+1}/${articles.length}] ${title.slice(0,45).padEnd(45)} `);
    const r = await scrapeArticle(page, url, title);
    if (r) { console.log(`✓ ${r.date} (${r.imgSaved} imgs)`); ok++; }
    else { console.log('✗'); fail++; }
    await page.waitForTimeout(800);
  }

  console.log(`\n✅ Zhihu done: ${ok} saved, ${fail} failed`);
  console.log(`📁 ${OUTPUT_DIR}`);
  await browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
