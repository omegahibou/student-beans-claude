const { chromium } = require('playwright');

const SB_BASE = 'https://www.studentbeans.com';
const SB_LOGIN = `${SB_BASE}/login`;
const SB_DISCOUNTS = `${SB_BASE}/student-discount/uk`;

let browserInstance = null;
let contextInstance = null;
let isLoggedIn = false;

/**
 * Get or create a persistent browser session
 */
async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
    });
    contextInstance = await browserInstance.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
  }
  return { browser: browserInstance, context: contextInstance };
}

/**
 * Log in to Student Beans. Reuses the session if already logged in.
 */
async function login() {
  const { context } = await getBrowser();

  if (isLoggedIn) return { success: true, message: 'Already logged in' };

  const page = await context.newPage();
  try {
    await page.goto(SB_LOGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Accept cookies if banner appears
    try {
      await page.click('button:has-text("Accept")', { timeout: 5000 });
    } catch (_) {}

    // Fill in email
    await page.fill('input[type="email"], input[name="email"]', process.env.SB_EMAIL);
    await page.fill('input[type="password"], input[name="password"]', process.env.SB_PASSWORD);
    await page.click('button[type="submit"]');

    // Wait for redirect away from login page
    await page.waitForURL((url) => !url.includes('/login'), { timeout: 15000 });

    isLoggedIn = true;
    await page.close();
    return { success: true, message: 'Logged in successfully' };
  } catch (err) {
    await page.close();
    isLoggedIn = false;
    return { success: false, message: `Login failed: ${err.message}` };
  }
}

/**
 * Search for retailers matching a query and return a list of matches.
 * @param {string} query - e.g. "ASOS", "Dominos", "Spotify"
 * @returns {Array<{ name: string, url: string }>}
 */
async function searchRetailers(query) {
  const { context } = await getBrowser();
  const page = await context.newPage();

  try {
    const searchUrl = `${SB_DISCOUNTS}?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for brand cards to appear
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
          if (name && name.length > 0 && name.length < 60) {
            items.push({ name, url: `https://www.studentbeans.com${href}` });
          }
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

/**
 * Fetch a discount code from a specific retailer page URL.
 * @param {string} retailerUrl - e.g. "https://www.studentbeans.com/student-discount/uk/asos"
 * @returns {{ code: string|null, type: string, url: string }}
 */
async function getCode(retailerUrl) {
  const loginResult = await login();
  if (!loginResult.success) throw new Error(loginResult.message);

  const { context } = await getBrowser();
  const page = await context.newPage();

  try {
    await page.goto(retailerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Accept cookies if banner appears
    try {
      await page.click('button:has-text("Accept")', { timeout: 3000 });
    } catch (_) {}

    // Click "Get Discount" or "Reveal Code" button
    const buttonSelectors = [
      'button:has-text("Get Discount")',
      'button:has-text("Reveal Code")',
      'button:has-text("Get Code")',
      'button:has-text("Reveal")',
      '[data-testid*="reveal"]',
      '[data-testid*="get-discount"]',
      'button[class*="reveal"]',
      'button[class*="discount"]',
    ];

    let clicked = false;
    for (const sel of buttonSelectors) {
      try {
        await page.click(sel, { timeout: 4000 });
        clicked = true;
        break;
      } catch (_) {}
    }

    if (!clicked) {
      // Try any prominent button near the top of page
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.find(
          (b) =>
            b.textContent.toLowerCase().includes('discount') ||
            b.textContent.toLowerCase().includes('code') ||
            b.textContent.toLowerCase().includes('reveal')
        );
        if (target) target.click();
      });
    }

    // Wait a moment for the code to appear
    await page.waitForTimeout(2000);

    // Try to find the code in various places
    const code = await page.evaluate(() => {
      // Look for elements that typically hold coupon codes
      const codeSelectors = [
        '[data-testid*="code"]',
        '[class*="coupon-code"]',
        '[class*="promo-code"]',
        '[class*="discount-code"]',
        '[class*="voucher-code"]',
        'input[readonly]',
        'code',
        '[aria-label*="code"]',
        '[data-code]',
        '[class*="code-box"]',
        '[class*="codebox"]',
        'p[class*="code"]',
        'span[class*="code"]',
      ];

      for (const sel of codeSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const val = el.value || el.getAttribute('data-code') || el.textContent.trim();
          if (val && val.length >= 3 && val.length <= 40 && !val.includes(' ')) {
            return val;
          }
        }
      }

      // Last resort: look for any text that looks like a code (all caps/alphanum, 4–20 chars)
      const allText = document.body.innerText;
      const match = allText.match(/\b([A-Z0-9]{4,20})\b/g);
      if (match) {
        // Filter out common non-code words
        const skip = new Set(['STUDENT', 'BEANS', 'DISCOUNT', 'OFFER', 'SAVE', 'FREE', 'SHOP']);
        const code = match.find((m) => !skip.has(m));
        return code || null;
      }
      return null;
    });

    // Check if we got redirected to the retailer (some offers redirect directly)
    const finalUrl = page.url();
    const wasRedirected = !finalUrl.includes('studentbeans.com');

    await page.close();

    if (code) {
      return { code, type: 'code', url: retailerUrl };
    } else if (wasRedirected) {
      return { code: null, type: 'redirect', url: finalUrl };
    } else {
      return { code: null, type: 'unknown', url: retailerUrl };
    }
  } catch (err) {
    await page.close();
    throw new Error(`Failed to get code: ${err.message}`);
  }
}

/**
 * Close the browser when shutting down
 */
async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    contextInstance = null;
    isLoggedIn = false;
  }
}

/**
 * Force re-login (useful if session expires)
 */
function resetSession() {
  isLoggedIn = false;
}

module.exports = { login, searchRetailers, getCode, closeBrowser, resetSession };
