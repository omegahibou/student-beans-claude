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
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
      ],
    });
    contextInstance = await browserInstance.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    isLoggedIn = false;
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

    await page.fill('input[type="email"], input[name="email"]', process.env.SB_EMAIL);
    await page.fill('input[type="password"], input[name="password"]', process.env.SB_PASSWORD);
    await page.click('button[type="submit"]');

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
 */
async function searchRetailers(query) {
  const { context } = await getBrowser();
  const page = await context.newPage();

  try {
    const searchUrl = `${SB_DISCOUNTS}?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

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
 */
async function getCode(retailerUrl) {
  const loginResult = await login();
  if (!loginResult.success) throw new Error(loginResult.message);

  const { context } = await getBrowser();
  const page = await context.newPage();

  try {
    await page.goto(retailerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
      await page.click('button:has-text("Accept")', { timeout: 3000 });
    } catch (_) {}

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

    await page.waitForTimeout(2000);

    const code = await page.evaluate(() => {
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

      const allText = document.body.innerText;
      const match = allText.match(/\b([A-Z0-9]{4,20})\b/g);
      if (match) {
        const skip = new Set(['STUDENT', 'BEANS', 'DISCOUNT', 'OFFER', 'SAVE', 'FREE', 'SHOP']);
        const code = match.find((m) => !skip.has(m));
        return code || null;
      }
      return null;
    });

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
}

module.exports = { login, searchRetailers, getDeals, getCode, closeBrowser, resetSession, setCookies, testCookies };

async function setCookies(cookieStr) {
  if (!cookieStr) return;
  const { context } = await getBrowser();
  const cookies = parseCookieString(cookieStr);
  if (cookies.length === 0) return;
  // Clear existing studentbeans.com cookies and replace with the new set
  const existing = await context.cookies('https://www.studentbeans.com');
  if (existing.length > 0) {
    await context.clearCookies();
    // Re-apply just the consent cookie so the banner doesn't reappear
    await context.addCookies([
      {
        name: 'CookieConsent',
        value: '{stamp:%27-1%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cver:1%2Cutc:1700000000000%2Cregion:%27gb%27}',
        domain: '.studentbeans.com',
        path: '/',
      },
    ]);
  }
  await context.addCookies(cookies);
  // Mark as logged in since we have session cookies — login() will skip its web flow
  isLoggedIn = true;
  console.log(`[SB] setCookies: injected ${cookies.length} cookies`);
}

async function testCookies(cookieStr) {
  if (!cookieStr) return false;
  // Inject the cookies into the shared context and try to load a protected page
  const savedLoginState = isLoggedIn;
  try {
    await setCookies(cookieStr);
    const { context } = await getBrowser();
    const page = await context.newPage();
    try {
      await page.goto('https://www.studentbeans.com/student-discount/uk/asos', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);
      await page.close();
      // If we see the verify wall, cookies are expired
      if (text.includes('verify') && text.includes('student')) return false;
      return true;
    } catch (e) {
      await page.close().catch(() => {});
      return false;
    }
  } catch (e) {
    return false;
  } finally {
    // Restore previous login state so the next real search isn't affected
    isLoggedIn = savedLoginState;
  }
}

// Returns array of { label, url } where url has ?__deal=N appended so getCode knows which to click.
async function getDeals(brandUrl) {
  console.log('[SB] getDeals:', brandUrl);
  const { context } = await getBrowser();
  const page = await context.newPage();
  try {
    // networkidle gives React time to render deal cards (domcontentloaded is too early)
    await page.goto(brandUrl, { waitUntil: 'networkidle', timeout: 25000 });
    const deals = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const dealBtns = buttons.filter(b => {
        const t = b.textContent.toLowerCase();
        return t.includes('get code') || t.includes('get discount') || t.includes('reveal');
      });

      return dealBtns.map((btn, i) => {
        // Find the card container: walk up until we find an element with only this one deal button
        let card = btn.parentElement;
        for (let depth = 0; depth < 10 && card; depth++) {
          const btnsInCard = Array.from(card.querySelectorAll('button')).filter(b => {
            const t = b.textContent.toLowerCase();
            return t.includes('get code') || t.includes('get discount') || t.includes('reveal');
          });
          if (btnsInCard.length === 1) break;
          card = card.parentElement;
        }
        let label = null;
        if (card) {
          const heading = card.querySelector('h1, h2, h3, h4, h5');
          if (heading) {
            label = heading.textContent.trim();
          } else {
            const btnText = btn.textContent.trim().toLowerCase();
            const textEls = Array.from(card.querySelectorAll('p, span, div'));
            for (const el of textEls) {
              const t = el.textContent.trim();
              if (t && t.toLowerCase() !== btnText && t.length > 3 && t.length < 120) {
                if (el.children.length === 0 || el.tagName === 'P') {
                  label = t;
                  break;
                }
              }
            }
          }
        }
        return { label: label || `Deal ${i + 1}`, index: i };
      });
    });

    await page.close();
    console.log('[SB] getDeals found:', deals.length, deals.map(d => d.label));
    return deals.map(d => ({
      label: d.label,
      url: `${brandUrl}?__deal=${d.index}`,
      dealIndex: d.index,
      brandUrl,
    }));
  } catch (err) {
    console.error('[SB] getDeals error:', err.message);
    await page.close().catch(() => {});
    return [{ label: 'Default Deal', url: brandUrl, dealIndex: 0, brandUrl }];
  }
}
