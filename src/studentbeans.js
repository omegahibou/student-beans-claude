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
    // Use the search API directly instead of scraping the page
    const apiUrl = `https://www.studentbeans.com/api/v1/offers/search?q=${encodeURIComponent(query)}&country=gb&limit=8`;
    console.log('[SB] Fetching search API:', apiUrl);
    
    const response = await page.goto(apiUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText);
    console.log('[SB] API response:', text.substring(0, 500));
    
    let results = [];
    try {
      const data = JSON.parse(text);
      // Handle various API response shapes
      const items = data.results || data.offers || data.brands || data.data || data || [];
      if (Array.isArray(items)) {
        results = items.slice(0, 8).map(item => ({
          name: item.brand_name || item.name || item.title || item.slug || 'Unknown',
          url: `https://www.studentbeans.com/student-discount/uk/${item.slug || item.brand_slug || item.id}`
        })).filter(r => r.name !== 'Unknown');
      }
    } catch (_) {
      console.log('[SB] API parse failed, falling back to page scrape');
    }
    
    // If API didn't work, fall back to scraping with longer wait
    if (results.length === 0) {
      console.log('[SB] Trying page scrape fallback...');
      await page.goto(`https://www.studentbeans.com/student-discount/uk?q=${encodeURIComponent(query)}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      
      // Log what links exist
      const allLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href'))
          .filter(h => h && h.includes('/student-discount/uk/') && !h.includes('/uk/brands') && !h.includes('/uk/cats') && !h.includes('/uk/all') && h !== '/student-discount/uk/')
          .slice(0, 20);
      });
      console.log('[SB] All matching links:', JSON.stringify(allLinks));
      
      results = allLinks
        .filter((href, i, arr) => arr.indexOf(href) === i)
        .slice(0, 8)
        .map(href => ({
          name: href.split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          url: `https://www.studentbeans.com${href}`
        }));
    }
    
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
  const { context } = await getBrowser();
  const page = await context.newPage();
  console.log('[SB] getCode called with URL:', retailerUrl);
  try {
    await page.goto(retailerUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    console.log('[SB] At URL:', page.url());

    // Log page text before clicking anything
    const beforeText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log('[SB] Before click text:', beforeText);

    // Listen for new popup/tab
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
      const skip = new Set([
        'STUDENT','BEANS','DISCOUNT','OFFER','SAVE','FREE','SHOP','GRANTED','ACCESS',
        'VERIFY','VALID','CLAIM','LOGIN','EMAIL','APPLY','TERMS','CODE','VIEW','OPEN',
        'BACK','NEXT','SKIP','NULL','TRUE','HTTP','HTML','HTTPS','YOUR','THIS','THAT',
        'WITH','FROM','THEY','BEEN','HAVE','WILL','MORE','ALSO','THAN','THEN','WHEN',
        'WHAT','ABOUT','ADDICT','BRANDS','BROWSE','NEVER','MISS','DEALS','CHROME',
        'EXTENSION','ALERTS','SITES','VISIT','SAVINGS','ADD','NOW','ALL','HERE',
        'LIST','JUST','BEING','NOSY','LOOKING','SPECIFIC','BRAND','MAYBE','FIND','CAN',
        'ADEXE','UNIQUE','SHARE','IMPORTANT','ONLY','ONCE','USED','COPY','COPIED',
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
