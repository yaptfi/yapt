import { chromium } from 'playwright';
import path from 'path';

/**
 * Playwright automation script for browsing and capturing the Yapt app
 *
 * Usage:
 *   npx tsx tests/browse-app.ts
 *
 * This script will:
 * - Launch a Chromium browser (headless by default)
 * - Navigate to the guest view page
 * - Take screenshots of the app state
 * - Save screenshots to tests/screenshots/
 */

async function browseApp() {
  const screenshotDir = path.join(__dirname, 'screenshots');
  // Add cache-busting parameter to force fresh load
  const cacheBuster = Date.now();
  const testUrl = `http://localhost:8080/guest.html?wallet=bdbdd2d9-eebc-4940-98c9-b8b999bd3a96&_=${cacheBuster}`;

  console.log('🎭 Launching browser...');
  const browser = await chromium.launch({
    headless: false, // Set to false to see the browser in action
    slowMo: 500, // Slow down operations by 500ms for visibility
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    // Ignore HTTPS certificate errors for self-signed certs
    ignoreHTTPSErrors: true,
    // Disable cache to always get fresh content
    bypassCSP: true,
  });

  const page = await context.newPage();

  try {
    console.log(`🌐 Navigating to ${testUrl}...`);
    await page.goto(testUrl, {
      waitUntil: 'networkidle',
      timeout: 10000
    });

    console.log('📸 Taking screenshot: guest page loaded');
    await page.screenshot({
      path: path.join(screenshotDir, '01-guest-page-loaded.png'),
      fullPage: true
    });

    // Wait for any dynamic content to load
    await page.waitForTimeout(1000);

    // Check for portfolio elements
    const portfolioValue = await page.locator('text=/Total Portfolio/i').first();
    if (await portfolioValue.isVisible()) {
      console.log('💰 Portfolio section visible');
    }

    // Check for positions table
    const positionsTable = await page.locator('table').first();
    if (await positionsTable.isVisible()) {
      console.log('📊 Positions table visible');
      const rowCount = await page.locator('table tbody tr').count();
      console.log(`   Found ${rowCount} position rows`);

      await page.screenshot({
        path: path.join(screenshotDir, '02-positions-table.png'),
        fullPage: true
      });
    }

    // Check for wallet address display
    const walletDisplay = await page.locator('text=/0x[a-fA-F0-9]{40}/').first();
    if (await walletDisplay.isVisible()) {
      const walletText = await walletDisplay.textContent();
      console.log(`👛 Wallet address: ${walletText}`);
    }

    // Check for any charts or visualizations
    const canvas = await page.locator('canvas').first();
    if (await canvas.isVisible()) {
      console.log('📈 Chart canvas detected');
      await page.screenshot({
        path: path.join(screenshotDir, '03-with-charts.png'),
        fullPage: true
      });
    }

    console.log('✅ Screenshots saved to tests/screenshots/');

  } catch (error) {
    console.error('❌ Error during browsing:', error);
    await page.screenshot({
      path: path.join(screenshotDir, '99-error.png'),
      fullPage: true
    });
  } finally {
    console.log('👋 Closing browser...');
    await browser.close();
  }
}

// Run the script
browseApp().catch(console.error);
