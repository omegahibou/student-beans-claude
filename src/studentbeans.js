const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SB_BASE = 'https://www.studentbeans.com';

let browserInstance = null;
let contextInstance = null;
let isLoggedIn = false;

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
    await contextInstance.addCookies([{
      name: 'CookieConsent',
      value: '{stamp:%27-1%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true}',
      domain: '.studentbeans.com',
      path: '/',
    }]);
    isLoggedIn = false;
  }
  return { browser: browserInstance, context: contextInstance };
}

async function login() {
  const { context } = await getBrowser();
  if (isLoggedIn) return { success: true, message: 'Already logged in' };
  const page = await context.newPage();
  try {
    console.log('[SB] Navigating to login page...');
    await page.goto('https://www.studentbeans.com/login', { waitUntil: 'networkidle', timeout: 45000 });
    console.log('[SB] Page URL after load:', page.url());

    // Log full page HTML to see what we're dealing with
    const html = await page.content();
    console.log('[SB] Page HTML (first 2000 chars):', html.substring(0, 2000));

    // Check for iframes
    const frames = page.frames();
    console.log('[SB] Frames on page:', frames.map(f => f.url()));

    // Try consent buttons
    for (const sel of ['button:has-text("Accept all")', 'button:has-text("Accept")', '#onetrust-accept-btn-handler']) {
      try { await page.click(sel, { timeout: 2000 }); console.log('[SB] Clicked consent:', sel); break; } catch (_) {}
    }

    // Wait a bit after potential consent click
    await page.waitForTimeout(2000);

    // Log HTML again after consent
    const html2 = await page.content();
    console.log('[SB] HTML after consent (first 2000 chars):', html2.substring(0, 2000));

    // Try to find email input across all frames
    let emailInput = null;
    for (const frame of page.frames()) {
      try {
        emailInput = await frame.waitForSelector('input[type="email"], input[name="email"], input[id*="email"], input[placeholder*="email" i]', { timeout: 5000 });
        if (emailInput) { console.log('[SB] Found email input in frame:', frame.url()); break; }
      } catch (_) {}
    }

    if (!emailInput) {
      // Last resort: dump all inputs
      const inputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, className: i.className
        }));
      });
      console.log('[SB] All inputs found:', JSON.stringify(inputs));
      throw new Error('Email input not found after full page inspection');
    }

    await emailInput.fill(process.env.SB_EMAIL);
    const pwInput = await page.waitForSelector('input[type="password"]', { timeout: 5000 });
    await pwInput.fill(process.env.SB_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.includes('/login'), { timeout: 15000 });
    isLoggedIn = true;
    await page.close();
    return { success: true, message: 'Logged in successfully' };
  } catch (err) {
    console.log('[SB] Login error:', err.message);
    await page.close();
    isLoggedIn = false;
    return { success: false, message: `Login failed: ${err.message.substring(0, 300)}` };
  }
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
    for (const sel of ['button:has-text("Get Discount")', 'button:has-text("Reveal Code")', 'button:has-text("Get Code")', 'button:has-text("Reveal")', '[data-testid*="reveal"]', 'button[class*="reveal"]', 'button[class*="discount"]']) {
      try { await page.click(sel, { timeout: 4000 }); break; } catch (_) {}
    }
    await page.waitForTimeout(2000);
    const code = await page.evaluate(() => {
      for (const sel of ['[data-testid*="code"]', '[class*="coupon-code"]', '[class*="promo-code"]', '[class*="discount-code"]', 'input[readonly]', '[data-code]', 'p[class*="code"]', 'span[class*="code"]']) {
        const el = document.querySelector(sel);
        if (el) { const val = el.value || el.getAttribute('data-code') || el.textContent.trim(); if (val && val.length >= 3 && val.length <= 40 && !val.includes(' ')) return val; }
      }
      const match = document.body.innerText.match(/\b([A-Z0-9]{4,20})\b/g);
      if (match) { const skip = new Set(['STUDENT','BEANS','DISCOUNT','OFFER','SAVE','FREE','SHOP']); return match.find(m => !skip.has(m)) || null; }
      return null;
    });
    const finalUrl = page.url();
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
