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
        if (href && href.includes('/student-discount/uk/') && !seen.has(href)) {
          seen.add(href);
          const nameEl = card.querySelector('h2, h3, [class*="brand"], [class*="name"], [class*="title"]');
          const name = nameEl ? nameEl.textContent.trim() : card.textContent.trim().split('\n')[0].trim();
          if (name && name.length > 0 && name.length < 60) items.push({ name, url: `https://www.studentbeans.com${href}` });
        }
      }
      return items.slice(0, 8);
    });
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
  const { context } = await getBrowser();
  const page = await context.newPage();
  try {
    await page.goto(retailerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.body && document.body.children.length > 0, { timeout: 15000 });
    await page.waitForTimeout(2000);

    // Click reveal button
    for (const sel of ['button:has-text("Get Discount")', 'button:has-text("Reveal Code")', 'button:has-text("Get Code")', 'button:has-text("Reveal")', '[data-testid*="reveal"]', 'button[class*="reveal"]', 'button[class*="discount"]']) {
      try { await page.click(sel, { timeout: 4000 }); console.log('[SB] Clicked:', sel); break; } catch (_) {}
    }
    await page.waitForTimeout(2000);

    // Log page text to debug what's visible
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    console.log('[SB] Page text:', bodyText);

    const code = await page.evaluate(() => {
      // Try specific code elements first
      for (const sel of ['[data-testid*="code"]', '[class*="coupon-code"]', '[class*="promo-code"]', '[class*="discount-code"]', 'input[readonly]', '[data-code]', 'p[class*="code"]', 'span[class*="code"]']) {
        const el = document.querySelector(sel);
        if (el) {
          const val = el.value || el.getAttribute('data-code') || el.textContent.trim();
          if (val && val.length >= 3 && val.length <= 30 && !/\s/.test(val)) return val;
        }
      }
      // Fallback: find uppercase alphanumeric codes in page text
      const skip = new Set(['STUDENT','BEANS','DISCOUNT','OFFER','SAVE','FREE','SHOP','GRANTED','ACCESS','VERIFY','VALID','CLAIM','LOGIN','EMAIL','APPLY','TERMS','CODE','VIEW','OPEN','BACK','NEXT','SKIP','NULL','TRUE','HTTP','HTML','HTTPS']);
      const match = document.body.innerText.match(/\b([A-Z][A-Z0-9]{3,19})\b/g);
      if (match) return match.find(m => !skip.has(m)) || null;
      return null;
    });

    const finalUrl = page.url();
    console.log('[SB] Final URL:', finalUrl, 'Code found:', code);
    await page.close();

    if (code) return { code, type: 'code', url: retailerUrl };
    if (!finalUrl.includes('studentbeans.com')) return { code: null, type: 'redirect', url: finalUrl };
    return { code: null, type: 'unknown', url: retailerUrl };
  } catch (err) {
    await page.close();
    throw new Error(`Failed to get code: ${err.message}`);
  }
}

async function closeBrowser() {
  if (browserInstance) { await browserInstance.close(); browserInstance = null; contextInstance = null; isLoggedIn = false; }
}

function resetSession() {
  isLoggedIn = false;
  if (browserInstance) { browserInstance.close().catch(() => {}); browserInstance = null; contextInstance = null; }
}

module.exports = { login, searchRetailers, getCode, closeBrowser, resetSession };
