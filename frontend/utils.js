/**
 * Shared utility functions for Yapt frontend
 * Used by both dashboard (app.js) and guest view (guest.html)
 */

// Format address to short form (0xabcd...1234)
function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '';
  const head = addr.slice(0, 5); // e.g., 0xffa
  const tail = addr.slice(-3);   // e.g., 432
  return `${head}...${tail}`;
}

// Format currency value
function formatCurrency(value) {
  if (value === null || value === undefined) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

// Format APY percentage
function formatApy(value, apyType, position) {
  if (value === null || value === undefined) {
    // For 7d and 30d APYs, show "Not yet" unless it's truly not applicable
    if (apyType === 'apy7d' || apyType === 'apy30d') {
      // Check if this is cvxCRV position (where APY is not applicable)
      const isCvxCrv = position && position.displayName &&
                       (position.displayName.toLowerCase().includes('cvxcrv') ||
                        position.displayName.toLowerCase().includes('cvx crv'));
      return isCvxCrv ? 'N/A' : 'Not yet';
    }
    return 'N/A';
  }
  return `${(value * 100).toFixed(2)}%`;
}

// Get CSS class for APY value
function getApyClass(value) {
  if (value === null || value === undefined) return 'apy-neutral';
  return value > 0 ? 'apy-value' : 'apy-neutral';
}

// Get CSS warning class for low APY
function getApyWarningClass(value) {
  // No warning for null/undefined (no data yet)
  if (value === null || value === undefined) return '';

  // Convert to percentage (e.g., 0.04 -> 4%)
  const apyPercent = value * 100;

  // No warning if >= 4%
  if (apyPercent >= 4) return '';

  // Calculate warning intensity: 0% = fully red, 4% = light pink
  // We'll use data attribute for gradient calculation in CSS
  const intensity = Math.max(0, Math.min(1, apyPercent / 4)); // 0 to 1

  return `apy-warning apy-warning-${Math.floor(intensity * 10)}`;
}

// Format date to human-readable relative time
function formatDate(dateString) {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;

  // Less than 1 minute
  if (diff < 60000) {
    return 'Just now';
  }

  // Less than 1 hour
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  }

  // Less than 24 hours
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  }

  // Otherwise show date
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

// Income context lookup (cached across calls)
let _nycSalaryBands = null;
let _locationBands = null;

// Load income context data tables
async function loadIncomeTables() {
  if (_nycSalaryBands && _locationBands) return;
  try {
    const [nycRes, locRes] = await Promise.all([
      fetch('/data/nyc-salary-bands.json', { cache: 'no-cache' }),
      fetch('/data/income-location-bands.json', { cache: 'no-cache' })
    ]);
    if (nycRes.ok) {
      const nycJson = await nycRes.json();
      _nycSalaryBands = Array.isArray(nycJson) ? nycJson : nycJson.bands || [];
    }
    if (locRes.ok) {
      const locJson = await locRes.json();
      _locationBands = Array.isArray(locJson) ? locJson : locJson.bands || [];
    }
  } catch (e) {
    console.warn('Failed to load income context tables:', e);
  }
}

// Pick appropriate band for a given value
function pickBand(bands, value) {
  if (!Array.isArray(bands)) return null;
  for (const band of bands) {
    const min = Number(band.min) || 0;
    const max = band.max === null || band.max === undefined ? Infinity : Number(band.max);
    if (value >= min && value <= max) return band;
  }
  return null;
}

// Render income context message
async function renderIncomeContext(annualIncome) {
  const el = document.getElementById('incomeContext');
  if (!el) return;

  if (!annualIncome || annualIncome <= 0) {
    el.innerHTML = '';
    return;
  }

  await loadIncomeTables();
  if (!_nycSalaryBands || !_locationBands) {
    el.innerHTML = '';
    return;
  }

  const nycBand = pickBand(_nycSalaryBands, annualIncome);
  const locBand = pickBand(_locationBands, annualIncome);

  if (!nycBand || !locBand) {
    el.innerHTML = '';
    return;
  }

  // Choose a random occupation/location from the band
  const occ = Array.isArray(nycBand.occupations) && nycBand.occupations.length > 0
    ? nycBand.occupations[Math.floor(Math.random() * nycBand.occupations.length)]
    : (nycBand.label || 'worker');
  const place = Array.isArray(locBand.examples) && locBand.examples.length > 0
    ? locBand.examples[Math.floor(Math.random() * locBand.examples.length)]
    : (locBand.label || 'many countries');

  el.innerHTML = `
    With this estimated annual income, you make about as much as a <strong>${occ}</strong> in New York.
    You could likely live comfortably-ish in <strong>${place}</strong>.
    <span class="disclaimer">Don't pack your bags yet, take this with a grain of salt. DYOR, NFA, etc.</span>
  `;
}
