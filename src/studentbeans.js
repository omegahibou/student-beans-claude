const { chromium } = require('playwright');

let browserInstance = null;
let contextInstance = null;
let isLoggedIn = false;

function parseCookieString(cookieStr) {
  return cookieStr.split(';').map(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return null;
    const name = pair.substring(0, idx).trim();
    const value = pair.substring(idx + 1).trim();
    if (!name) return null;
    return { name, value, domain: '.studentbeans.com', path: '/' };
  }).filter(Boolean);
}

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    contextInstance = await browserInstance.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    if (process.env.SB_COOKIES) {
      const cookies = parseCookieString(process.env.SB_COOKIES);
      await contextInstance.addCookies(cookies);
      console.log('[SB] Injected', cookies.length, 'cookies from env');
    }
    isLoggedIn = !!process.env.SB_COOKIES;
  }
  return { browser: browserInstance, context: contextInstance };
}

async function login() {
  if (process.env.SB_COOKIES) {
    await getBrowser();
    isLoggedIn = true;
    return { success: true, message: 'Session loaded from cookies' };
  }
  return { success: false, message: 'No SB_COOKIES set.' };
}

async function searchRetailers(query) {
  const { context } = await getBrowser();
  const page = await context.newPage();
  try {
    await page.goto(`https://www.studentbeans.com/student-discount/uk?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('a[href*="/student-discount/uk/"]', { timeout: 10000 }).catch(() => {});
    const results = await page.evaluate(() => {
      const cards = document.querySelectorAll('a[href*="/student-discount/uk/"]');
      const seen = new Set();
      const items = [];
      for (const card of cards) {
        const href = card.getAttribute('href');
        // Must be a brand page (e.g. /student-discount/uk/asos), not /brands or /uk itself
        if (href && /\/student-discount\/uk\/[^/]+$/.test(href) && !href.endsWith('/uk/') && !seen.has(href)) {
          seen.add(href);
          const nameEl = card.querySelector('h2, h3, [class*="brand"], [class*="name"], [class*="title"]');
          const name = nameEl ? nameEl.textContent.trim() : card.textContent.trim().split('\n')[0].trim();
          if (name && name.length > 0 && name.length < 60) items.push({ name, url: `https://www.studentbeans.com${href}` });
        }
      }
      return items.slice(0, 8);
    });
    console.log('[SB] Search results:', JSON.stringify(results));
    await page.close();
    return results;
  } catch (err) {
    await page.close();
    throw new Error(`Search failed: ${err.message}`);
  }
}

async function getCode(retailerUrl) {
  const loginResult = await login();
  if (!loginResult.success) throw new Error(loginResult.message);
  const { browser, context } = await getBrowser();
  const page = await context.newPage();
  console.log('[SB] getCode called with URL:', retailerUrl);
  try {
    await page.goto(retailerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.body && document.body.children.length > 2, { timeout: 15000 });
    await page.waitForTimeout(3000);

    console.log('[SB] At URL:', page.url());

    // Listen for new pages (popup/tab) opened by button click
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
      (async () => {
        for (const sel of [
          'button:has-text("Get Discount")',
          'button:has-text("Reveal Code")',
          'button:has-text("Get Code")',
          'button:has-text("Reveal")',
          '[data-testid*="reveal"]',
          'button[class*="reveal"]',
          'button[class*="discount"]',
          'a:has-text("Get Discount")',
          'a:has-text("Get Code")',
        ]) {
          try {
            await page.click(sel, { timeout: 3000 });
            console.log('[SB] Clicked:', sel);
            break;
          } catch (_) {}
        }
      })(),
    ]);

    // If a new tab/popup opened, work there instead
    const activePage = newPage || page;
    if (newPage) {
      console.log('[SB] New page opened:', newPage.url());
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      await newPage.waitForTimeout(2000);
    } else {
      await page.waitForTimeout(2000);
    }

    const bodyText = await activePage.evaluate(() => document.body.innerText.substring(0, 800));
    console.log('[SB] Active page text:', bodyText);
    console.log('[SB] Active page URL:', activePage.url());

    const code = await activePage.evaluate(() => {
      // Try specific code elements first
      for (const sel of [
        '[data-testid*="code"]',
        '[class*="coupon-code"]',
        '[class*="promo-code"]',
        '[class*="discount-code"]',
        '[class*="voucher-code"]',
        'input[readonly]',
        '[data-code]',
        'p[class*="code"]',
        'span[class*="code"]',
        'div[class*="code"]',
      ]) {
        const el = document.querySelector(sel);
        if (el) {
          const val = el.value || el.getAttribute('data-code') || el.textContent.trim();
          if (val && val.length >= 3 && val.length <= 30 && !/\s/.test(val)) return val;
        }
      }
      // Fallback: uppercase alphanumeric words that look like promo codes
      const skip = new Set([
        'STUDENT','BEANS','DISCOUNT','OFFER','SAVE','FREE','SHOP','GRANTED','ACCESS',
        'VERIFY','VALID','CLAIM','LOGIN','EMAIL','APPLY','TERMS','CODE','VIEW','OPEN',
        'BACK','NEXT','SKIP','NULL','TRUE','HTTP','HTML','HTTPS','YOUR','THIS','THAT',
        'WITH','FROM','THEY','BEEN','HAVE','WILL','MORE','ALSO','THAN','THEN','WHEN',
        'WHAT','ABOUT','ADDICT','BRANDS','BROWSE','NEVER','MISS','DEALS','CHROME',
        'EXTENSION','ALERTS','SITES','VISIT','SAVINGS','ADD','NOW','FOR','ALL','HERE',
        'LIST','JUST','BEING','NOSY','LOOKING','SPECIFIC','BRAND','MAYBE','FIND','CAN',
      ]);
      const match = document.body.innerText.match(/\b([A-Z][A-Z0-9]{4,19})\b/g);
      if (match) return match.find(m => !skip.has(m)) || null;
      return null;
    });

    const finalUrl = activePage.url();
    console.log('[SB] Final URL:', finalUrl, '| Code found:', code);

    if (newPage) await newPage.close().catch(() => {});
    await page.close();

    if (code) return { code, type: 'code', url: retailerUrl };
    if (!finalUrl.includes('studentbeans.com')) return { code: null, type: 'redirect', url: finalUrl };
    return { code: null, type: 'unknown', url: retailerUrl };
  } catch (err) {
    await page.close().catch(() => {});
    throw new Error(`Failed to get code: ${err.message}`);
  }
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    contextInstance = null;
    isLoggedIn = false;
  }
}

function resetSession() {
  isLoggedIn = false;
  if (browserInstance) {
    browserInstance.close().catch(() => {});
    browserInstance = null;
    contextInstance = null;
  }
}

module.exports = { login, searchRetailers, getCode, closeBrowser, resetSession };
