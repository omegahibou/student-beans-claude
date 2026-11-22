const { chromium } = require('playwright');

const SB_BASE = 'https://www.studentbeans.com';
const SB_LOGIN = `${SB_BASE}/login`;
const SB_DISCOUNTS = `${SB_BASE}/student-discount/uk`;

let browserInstance = null;
let contextInstance = null;
let isLoggedIn = false;

// Parse a cookie string (from browser DevTools / account storage) into Playwright cookie objects
function parseCookieString(cookieStr) {
  if (!cookieStr) return [];
  return cookieStr.split(';').map((part) => {
    const [name, ...rest] = part.trim().split('=');
    return {
      name: name.trim(),
      value: rest.join('=').trim(),
      domain: '.studentbeans.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'None',
    };
  }).filter((c) => c.name && c.value);
}

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    console.log('[SB] Launching browser...');
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
      ],
    });
    console.log('[SB] Browser launched');
    contextInstance = await browserInstance.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      // Pre-accept cookies so the banner never blocks the page
      extraHTTPHeaders: {
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    // Set cookies to bypass consent banner
    await contextInstance.addCookies([
      {
        name: 'CookieConsent',
        value: '{stamp:%27-1%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cver:1%2Cutc:1700000000000%2Cregion:%27gb%27}',
        domain: '.studentbeans.com',
        path: '/',
      },
    ]);
    isLoggedIn = false;
  }
  return { browser: browserInstance, context: contextInstance };
}

// Inject cookies into the existing browser context without killing the browser.
// Call this before a search when switching accounts.
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

async function login() {
  console.log('[SB] login() called, isLoggedIn=', isLoggedIn);
  const { context } = await getBrowser();

  if (isLoggedIn) return { success: true, message: 'Already logged in' };

  const page = await context.newPage();
  try {
    console.log('[SB] Navigating to login page...');
    await page.goto(SB_LOGIN, { waitUntil: 'networkidle', timeout: 45000 });
    console.log('[SB] Login page loaded, URL:', page.url());

    // Dismiss any cookie/consent banners
    const consentSelectors = [
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("Accept")',
      'button:has-text("Allow all")',
      '#onetrust-accept-btn-handler',
      '[id*="accept"]',
      '[class*="accept"]',
    ];
    for (const sel of consentSelectors) {
      try {
        await page.click(sel, { timeout: 2000 });
        console.log('[SB] Dismissed consent banner:', sel);
        await page.waitForTimeout(500);
        break;
      } catch (_) {}
    }

    // Wait for the email input to appear
    console.log('[SB] Waiting for email input...');
    await page.waitForSelector('input[type="email"], input[name="email"], input[id*="email"]', { timeout: 30000 });
    console.log('[SB] Email input found');

    await page.fill('input[type="email"], input[name="email"], input[id*="email"]', process.env.SB_EMAIL);
    await page.fill('input[type="password"], input[name="password"], input[id*="password"]', process.env.SB_PASSWORD);

    console.log('[SB] Submitting login form...');
    await page.click('button[type="submit"]');

    await page.waitForURL((url) => !url.includes('/login'), { timeout: 15000 });
    console.log('[SB] Logged in! URL now:', page.url());

    isLoggedIn = true;
    await page.close();
    return { success: true, message: 'Logged in successfully' };
  } catch (err) {
    // Take a screenshot to debug what the page looks like
    try {
      const html = await page.content();
      console.log('[SB] Page HTML snippet:', html.substring(0, 500));
    } catch (_) {}
    console.error('[SB] Login error:', err.message);
    await page.close();
    isLoggedIn = false;
    return { success: false, message: `Login failed: ${err.message}` };
  }
}

// Convert a user query into a URL slug: lowercase, spaces→hyphens, strip specials
function toSlug(query) {
  return query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function searchRetailers(query) {
  if (query === '__warmup__') return [];
  console.log('[SB] searchRetailers:', query);
  const { context } = await getBrowser();

  // Strategy 1: try the direct brand URL (e.g. /student-discount/uk/asos)
  const slug = toSlug(query);
  const directUrl = `${SB_BASE}/student-discount/uk/${slug}`;
  console.log('[SB] Trying direct URL:', directUrl);

  const page = await context.newPage();
  try {
    const response = await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const finalUrl = page.url();
    const status = response ? response.status() : 0;

    // If the page loaded and didn't redirect to a 404/error page, use it
    if (status < 400 && finalUrl.includes('/student-discount/uk/') && !finalUrl.includes('/uk/cats') && !finalUrl.includes('/uk?')) {
      // Extract the brand name from the page title or h1
      const name = await page.evaluate((fallback) => {
        const h1 = document.querySelector('h1');
        if (h1) {
          // Strip common suffixes like "Student Discount | ..."
          return h1.textContent.trim().replace(/\s*student discount.*/i, '').trim() || fallback;
        }
        return document.title.replace(/\s*student discount.*/i, '').replace(/\s*\|.*/, '').trim() || fallback;
      }, query);
      await page.close();
      console.log('[SB] Direct URL hit:', name, directUrl);
      return [{ name, url: directUrl }];
    }

    // Strategy 2: direct URL failed — try the all-brands listing page and search there
    console.log('[SB] Direct URL miss (status', status, '), trying brands listing');
    await page.goto(`${SB_BASE}/student-discount/uk/brands`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const results = await page.evaluate((q) => {
      const links = Array.from(document.querySelectorAll('a[href*="/student-discount/uk/"]'));
      const ql = q.toLowerCase();
      const seen = new Set();
      const items = [];
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        // Skip category/collection pages
        if (href.includes('/cats') || href.includes('/collections') || href.includes('/brands')) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const text = a.textContent.trim().toLowerCase();
        const slug = href.split('/').pop();
        if (text.includes(ql) || slug.includes(ql)) {
          items.push({ name: a.textContent.trim().split('\n')[0].trim(), url: `https://www.studentbeans.com${href}` });
        }
      }
      return items.slice(0, 5);
    }, query);

    await page.close();
    console.log('[SB] Brands listing results:', results.length);
    return results;
  } catch (err) {
    console.error('[SB] searchRetailers error:', err.message);
    await page.close().catch(() => {});
    throw new Error(`Search failed: ${err.message}`);
  }
}

async function getCode(retailerUrl) {
  console.log('[SB] getCode:', retailerUrl);

  // Parse and strip the __deal index from the URL before navigating
  const urlObj = new URL(retailerUrl);
  const dealIndex = urlObj.searchParams.has('__deal')
    ? parseInt(urlObj.searchParams.get('__deal'), 10)
    : 0;
  urlObj.searchParams.delete('__deal');
  const cleanUrl = urlObj.toString();
  console.log('[SB] dealIndex:', dealIndex, 'cleanUrl:', cleanUrl);

  const loginResult = await login();
  if (!loginResult.success) throw new Error(loginResult.message);

  const { context } = await getBrowser();
  const page = await context.newPage();

  try {
    await page.goto(cleanUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for at least one deal button to be rendered (SB is JS-rendered)
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some(b => {
        const t = b.textContent.toLowerCase();
        return t.includes('get code') || t.includes('get discount') || t.includes('reveal');
      });
    }, { timeout: 15000 }).catch(() => console.log('[SB] waitForFunction timed out, proceeding anyway'));

    // Student Beans opens a NEW TAB when "Get code & open site" is clicked.
    // Set up a listener BEFORE clicking so we don't miss it.
    const newPagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);

    // Click the Nth deal button (dealIndex), not always the first one.
    const clicked = await page.evaluate((idx) => {
      const btns = Array.from(document.querySelectorAll('button')).filter((b) => {
        const t = b.textContent.toLowerCase();
        return t.includes('get code') || t.includes('get discount') || t.includes('reveal');
      });
      console.log('[SB-eval] deal buttons found:', btns.length, 'clicking index:', idx);
      const target = btns[idx] || btns[0];
      if (target) { target.click(); return true; }
      return false;
    }, dealIndex);

    console.log('[SB] Click result:', clicked, '(dealIndex', dealIndex + ')');

    // Wait for the new tab that Student Beans opens with the actual code
    const newPage = await newPagePromise;

    let code = null;
    let cooldown = null;

    if (newPage) {
      console.log('[SB] New tab opened:', newPage.url());
      await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await newPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      const result = await newPage.evaluate(() => {
        // Primary target: the dashed-border animated button containing the code
        const offerBtn = document.querySelector('button[class*="animate-offerPop"] p') ||
                         document.querySelector('button[class*="border-dashed"] p') ||
                         document.querySelector('button[class*="offerPop"]');
        let code = null;
        if (offerBtn) {
          const val = offerBtn.textContent.trim();
          if (val && val.length >= 4 && val.length <= 40 && !/\s/.test(val)) code = val;
        }
        if (!code) {
          const fallbackSelectors = [
            '[data-testid*="code"]',
            '[class*="coupon-code"]',
            '[class*="promo-code"]',
            '[class*="discount-code"]',
            '[class*="voucher-code"]',
            'input[readonly]',
            '[data-code]',
            '[class*="code-box"]',
            '[class*="codebox"]',
          ];
          for (const sel of fallbackSelectors) {
            const el = document.querySelector(sel);
            if (el) {
              const val = el.value || el.getAttribute('data-code') || el.textContent.trim();
              if (val && val.length >= 4 && val.length <= 40 && !/\s/.test(val)) { code = val; break; }
            }
          }
        }
        if (!code && document.body) {
          const match = document.body.innerText.match(/([A-Z0-9]{6,20})/g);
          if (match) {
            const skip = new Set(['STUDENT', 'BEANS', 'DISCOUNT', 'OFFER', 'SAVE', 'FREE', 'SHOP', 'ONLINE', 'GRANTED', 'VERIFIED']);
            code = match.find((m) => !skip.has(m)) || null;
          }
        }
        // Grab cooldown: "Your next code will be available at X:XXpm"
        let cooldown = null;
        if (document.body) {
          const bodyText = document.body.innerText;
          const cdMatch = bodyText.match(/next code will be available at ([\d:]+\s*[apm]{2})/i) ||
                          bodyText.match(/available at ([\d:]+\s*[apm]{2})/i);
          if (cdMatch) cooldown = cdMatch[1].trim();
        }
        return { code, cooldown };
      });

      code = result.code;
      cooldown = result.cooldown;
      console.log('[SB] Code from new tab:', code, 'cooldown:', cooldown);
      await newPage.close().catch(() => {});
    } else {
      // No new tab — try reading the code from the current page
      console.log('[SB] No new tab, reading from current page');
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() =>
        page.waitForTimeout(2500)
      );
      code = await page.evaluate(() => {
        const offerBtn = document.querySelector('button[class*="animate-offerPop"] p') ||
                         document.querySelector('button[class*="border-dashed"] p');
        if (offerBtn) {
          const val = offerBtn.textContent.trim();
          if (val && val.length >= 4 && val.length <= 40 && !/\s/.test(val)) return val;
        }
        if (!document.body) return null;
        const match = document.body.innerText.match(/\b([A-Z0-9]{6,20})\b/g);
        if (match) {
          const skip = new Set(['STUDENT', 'BEANS', 'DISCOUNT', 'OFFER', 'SAVE', 'FREE', 'SHOP', 'ONLINE', 'GRANTED', 'VERIFIED']);
          return match.find((m) => !skip.has(m)) || null;
        }
        return null;
      });
    }

    console.log('[SB] Code found:', code);
    const finalUrl = page.url();
    const wasRedirected = !finalUrl.includes('studentbeans.com');
    await page.close().catch(() => {});

    if (code) {
      return { code, type: 'code', url: retailerUrl, cooldown };
    } else if (wasRedirected) {
      return { code: null, type: 'redirect', url: finalUrl };
    } else {
      return { code: null, type: 'unknown', url: retailerUrl };
    }
  } catch (err) {
    console.error('[SB] getCode error:', err.message);
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

// ── Test cookies (used by account manager) ────────────────────────────────────
// Reuses the warm browser rather than spinning up a fresh one
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

module.exports = { login, searchRetailers, getDeals, getCode, closeBrowser, resetSession, setCookies, testCookies };

// Returns array of { label, url, dealIndex, brandUrl } for each deal card on a brand page.
// url has ?__deal=N appended so getCode knows which button to click.
async function getDeals(brandUrl) {
  console.log('[SB] getDeals:', brandUrl);
  const { context } = await getBrowser();
  const page = await context.newPage();
  try {
    // networkidle gives React time to render deal cards (domcontentloaded fires too early)
    await page.goto(brandUrl, { waitUntil: 'networkidle', timeout: 25000 });
    const deals = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const dealBtns = buttons.filter(b => {
        const t = b.textContent.toLowerCase();
        return t.includes('get code') || t.includes('get discount') || t.includes('reveal');
      });

      return dealBtns.map((btn, i) => {
        // Walk up to the nearest <article> (Student Beans deal card container)
        let card = btn.parentElement;
        while (card && card.tagName !== 'ARTICLE') card = card.parentElement;
        // Fallback: walk up to smallest container with exactly one deal button
        if (!card) {
          card = btn.parentElement;
          for (let depth = 0; depth < 10 && card; depth++) {
            const btnsInCard = Array.from(card.querySelectorAll('button')).filter(b => {
              const t = b.textContent.toLowerCase();
              return t.includes('get code') || t.includes('get discount') || t.includes('reveal');
            });
            if (btnsInCard.length === 1) break;
            card = card.parentElement;
          }
        }
        let label = null;
        if (card) {
          // Student Beans uses data-testid="offer-issuance-tile-v2-title" on the h3
          const titleEl = card.querySelector('[data-testid="offer-issuance-tile-v2-title"]') ||
                          card.querySelector('h1, h2, h3, h4, h5');
          if (titleEl) label = titleEl.textContent.trim();
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
