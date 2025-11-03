(function() {
  // API base URL (configurable via frontend/config.js)
  // Note: API_BASE already includes '/api' from config.js
  const API_BASE = (typeof window !== 'undefined' && window.APP_CONFIG && window.APP_CONFIG.apiBase)
    ? window.APP_CONFIG.apiBase
    : '/api';

  // State
  let hasWallets = false;
  let selectedWalletIds = new Set(); // Track selected wallet IDs
  let allWallets = []; // Cache of all wallets

  // Initialize function called by auth.js after authentication
  function initializeApp() {
    checkWalletsAndInitialize();
  }

  // Expose to global scope
  window.initializeApp = initializeApp;

// Helper function to consume SSE stream and handle discovery events
async function consumeDiscoveryStream(response, statusText, positionsContainer) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const event = JSON.parse(line.slice(6));
        handleDiscoveryEvent(event, statusText, positionsContainer);
      }
    }
  }
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '';
  const head = addr.slice(0, 5); // e.g., 0xffa
  const tail = addr.slice(-3);   // e.g., 432
  return `${head}...${tail}`;
}

// Wallet selection management
function loadSelectedWallets() {
  try {
    const saved = localStorage.getItem('selectedWallets');
    if (saved) {
      selectedWalletIds = new Set(JSON.parse(saved));
    }
  } catch (error) {
    console.error('Failed to load selected wallets from localStorage:', error);
    selectedWalletIds = new Set();
  }
}

function saveSelectedWallets() {
  try {
    localStorage.setItem('selectedWallets', JSON.stringify([...selectedWalletIds]));
  } catch (error) {
    console.error('Failed to save selected wallets to localStorage:', error);
  }
}

function toggleWalletSelection(walletId) {
  if (selectedWalletIds.has(walletId)) {
    selectedWalletIds.delete(walletId);
  } else {
    selectedWalletIds.add(walletId);
  }
  saveSelectedWallets();

  // Refresh positions and portfolio summary
  loadPositions();
  loadPortfolioSummary();
}

function initializeSelectedWallets(wallets) {
  // Load from localStorage first
  loadSelectedWallets();

  // If nothing in localStorage or saved wallets don't match current wallets, select all
  const walletIds = wallets.map(w => w.id);
  const hasValidSelection = [...selectedWalletIds].some(id => walletIds.includes(id));

  if (!hasValidSelection || selectedWalletIds.size === 0) {
    selectedWalletIds = new Set(walletIds);
    saveSelectedWallets();
  }
}

// Check if wallets exist and show appropriate UI
async function checkWalletsAndInitialize() {
  try {
    const response = await fetch(`${API_BASE}/wallets`, {
      credentials: 'include',
    });
    const data = await response.json();
    const wallets = data.wallets || [];

    hasWallets = wallets.length > 0;

    if (hasWallets) {
      // Show full dashboard
      showDashboard();
      loadWallets();
      loadPositions();
      loadPortfolioSummary();
    } else {
      // Show get started screen
      showGetStartedScreen();
    }
  } catch (error) {
    console.error('Failed to check wallets:', error);
    showGetStartedScreen();
  }
}

// Show full dashboard
function showDashboard() {
  document.getElementById('portfolioSummary').style.display = 'block';
  document.getElementById('walletsSection').style.display = 'block';
  document.getElementById('positionsSection').style.display = 'block';
  document.getElementById('getStartedScreen').style.display = 'none';
}

// Show get started screen
function showGetStartedScreen() {
  document.getElementById('portfolioSummary').style.display = 'none';
  document.getElementById('walletsSection').style.display = 'none';
  document.getElementById('positionsSection').style.display = 'none';
  document.getElementById('getStartedScreen').style.display = 'block';

  // Reset form state
  document.getElementById('walletAddress').value = '';
  document.getElementById('addWalletStatus').style.display = 'none';
  document.getElementById('getStartedForm').style.display = 'block';
  document.getElementById('discoveryProgress').style.display = 'none';
}

// Show add wallet form (from dashboard)
function showAddWalletForm() {
  // Just show the get started screen (it will reset the form state)
  showGetStartedScreen();
}

// Add Wallet with live progress
async function addWallet(event) {
  event.preventDefault();

  const input = document.getElementById('walletAddress');
  const button = document.getElementById('addWalletBtn');
  const status = document.getElementById('addWalletStatus');
  const form = document.getElementById('getStartedForm');
  const progressContainer = document.getElementById('discoveryProgress');
  const statusText = document.getElementById('discoveryStatus');
  const positionsContainer = document.getElementById('discoveredPositions');
  const address = input.value.trim();

  // Accept either 0x-prefixed address or ENS name ending with .eth
  const isHexAddress = /^0x[a-fA-F0-9]{40}$/.test(address);
  const isEnsName = address.toLowerCase().endsWith('.eth');

  if (!address || (!isHexAddress && !isEnsName)) {
    showStatus(status, 'Please enter a valid address or ENS', 'error');
    return;
  }

  // Hide form and show progress
  form.style.display = 'none';
  status.style.display = 'none';
  progressContainer.style.display = 'block';
  positionsContainer.innerHTML = '';

  try {
    const response = await fetch(`${API_BASE}/wallets/discover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ address }),
    });

    if (response.status === 409) {
      const data = await response.json();
      form.style.display = 'block';
      progressContainer.style.display = 'none';

      // If user has wallets, show link back to dashboard
      if (hasWallets) {
        status.innerHTML = 'This wallet has already been added. <a href="#" onclick="returnToDashboard(); return false;" style="color: var(--primary); text-decoration: underline;">Back to dashboard</a>';
        status.className = 'status-message error';
        status.style.display = 'block';
      } else {
        showStatus(status, 'This wallet has already been added', 'error');
      }
      return;
    }

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to add wallet');
    }

    // Handle SSE stream
    await consumeDiscoveryStream(response, statusText, positionsContainer);

    // Discovery complete - switch to dashboard
    input.value = '';
    hasWallets = true;

    setTimeout(async () => {
      showDashboard();
      await loadWallets(); // Wait for wallets to load and selection to initialize
      await loadPositions();
      await loadPortfolioSummary();
    }, 1500);

  } catch (error) {
    form.style.display = 'block';
    progressContainer.style.display = 'none';

    // If user has wallets, show link back to dashboard
    if (hasWallets) {
      status.innerHTML = `${error.message || 'Failed to add wallet'}. <a href="#" onclick="returnToDashboard(); return false;" style="color: var(--primary); text-decoration: underline;">Back to dashboard</a>`;
      status.className = 'status-message error';
      status.style.display = 'block';
    } else {
      showStatus(status, error.message || 'Failed to add wallet', 'error');
    }
  }
}

function handleDiscoveryEvent(event, statusText, positionsContainer) {
  switch (event.type) {
    case 'start':
      statusText.textContent = `Scanning ${event.data.totalProtocols} protocols...`;
      break;

    case 'protocol_start':
      statusText.textContent = `Checking ${event.data.protocol} (${event.data.index}/${event.data.total})...`;
      break;

    case 'position_found':
      // Add position to list with animation
      const posItem = document.createElement('div');
      posItem.className = 'position-discovery-item';
      posItem.innerHTML = `
        <div class="check-icon">✓</div>
        <div class="position-discovery-details">
          <div class="position-discovery-name">${event.data.displayName}</div>
          <div class="position-discovery-meta">${event.data.protocol} · ${event.data.baseAsset}</div>
        </div>
        <div class="position-discovery-value">
          $${event.data.valueUsd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
        </div>
      `;
      positionsContainer.appendChild(posItem);
      break;

    case 'protocol_complete':
      // Just continue to next protocol
      break;

    case 'complete':
      statusText.textContent = `Discovery complete! Found ${event.data.totalPositions} position${event.data.totalPositions !== 1 ? 's' : ''}`;
      break;

    case 'error':
      statusText.textContent = `Error: ${event.data.message}`;
      break;
  }
}

// Delete Wallet
async function deleteWallet(walletId, walletAddress) {
  if (!confirm(`Are you sure you want to remove wallet ${walletAddress} and its positions from your account?\n\nNote: The wallet data remains in the system and can be re-added later.`)) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/wallets/${walletId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to delete wallet');
    }

    // Reload data
    await loadWallets();
    await loadPositions();
    await loadPortfolioSummary();

    // If no wallets left, show get started screen
    const walletsResponse = await fetch(`${API_BASE}/wallets`, {
      credentials: 'include',
    });
    const walletsData = await walletsResponse.json();
    if (walletsData.wallets.length === 0) {
      hasWallets = false;
      showGetStartedScreen();
    }
  } catch (error) {
    alert(`Failed to delete wallet: ${error.message}`);
  }
}

// Load Wallets
async function loadWallets() {
  const container = document.getElementById('walletsList');

  try {
    const response = await fetch(`${API_BASE}/wallets`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to load wallets');
    }

    const data = await response.json();
    const wallets = data.wallets || [];

    if (wallets.length === 0) {
      container.innerHTML = '<p class="empty-state">No wallets added yet</p>';
      return;
    }

    // Store wallets and initialize selection
    allWallets = wallets;
    initializeSelectedWallets(wallets);

    container.innerHTML = wallets.map(wallet => {
      const hasEns = !!(wallet.ensName && wallet.ensName.length > 0);
      const display = hasEns ? wallet.ensName : wallet.address;
      const created = new Date(wallet.createdAt).toISOString().slice(0, 10);
      const truncated = shortAddr(wallet.address);
      const isChecked = selectedWalletIds.has(wallet.id);
      const addrSuffix = hasEns ? `<span class="wallet-address" title="${wallet.address}">(${truncated})</span>` : '';
      return `
      <div class="wallet-item">
        <div class="wallet-line">
          <input
            type="checkbox"
            class="wallet-checkbox"
            id="wallet-${wallet.id}"
            ${isChecked ? 'checked' : ''}
            onchange="toggleWalletSelection('${wallet.id}')"
          >
          <label for="wallet-${wallet.id}" class="wallet-label">
            <span class="wallet-name">${display}</span>
            ${addrSuffix}
            <span class="wallet-meta"> • created: ${created}</span>
          </label>
        </div>
        <div class="wallet-actions">
          <button class="btn btn-secondary btn-small" onclick="scanWallet('${wallet.id}', '${display}', this)" title="Scan the wallet for any new positions">Re-scan</button>
          <button class="btn btn-danger btn-small" onclick="deleteWallet('${wallet.id}', '${display}')">Delete</button>
        </div>
      </div>`;
    }).join('');

  } catch (error) {
    container.innerHTML = `<p class="empty-state" style="color: var(--danger)">Error loading wallets: ${error.message}</p>`;
  }
}

// Trigger discovery for an existing wallet
async function scanWallet(walletId, walletAddress, btnEl) {
  const modal = document.getElementById('rescanModal');
  const statusText = document.getElementById('rescanStatus');
  const positionsContainer = document.getElementById('rescanPositions');

  try {
    // Show modal with progress UI
    modal.style.display = 'flex';
    positionsContainer.innerHTML = '';
    statusText.textContent = 'Starting discovery...';

    const response = await fetch(`${API_BASE}/wallets/${walletId}/scan`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to start scan');
    }

    // Handle SSE stream
    await consumeDiscoveryStream(response, statusText, positionsContainer);

    // Discovery complete - refresh data and close modal
    setTimeout(async () => {
      await loadPositions();
      await loadPortfolioSummary();
      closeRescanModal();
    }, 1500);

  } catch (error) {
    alert(`Failed to scan ${walletAddress}: ${error.message}`);
    closeRescanModal();
  }
}

function closeRescanModal() {
  const modal = document.getElementById('rescanModal');
  modal.style.display = 'none';
}

// Load Positions
async function loadPositions() {
  const container = document.getElementById('positionsTable');

  try {
    const response = await fetch(`${API_BASE}/positions`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to load positions');
    }

    const data = await response.json();
    let positions = data.positions || [];

    // Filter positions based on selected wallets
    // When no wallets are selected, filter returns empty array (correct behavior)
    positions = positions.filter(pos => selectedWalletIds.has(pos.walletId));

    if (positions.length === 0) {
      container.innerHTML = '<p class="empty-state">No positions found for selected wallets.</p>';
      return;
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Position</th>
            <th>Value (USD)</th>
            <th>APY</th>
            <th>7d APY</th>
            <th>30d APY</th>
            <th>Est. Daily</th>
            <th>Est. Monthly</th>
            <th>Last Updated</th>
          </tr>
        </thead>
        <tbody>
          ${positions.map(pos => `
            <tr class="${getApyWarningClass(pos.apy)}" data-apy="${pos.apy !== null && pos.apy !== undefined ? pos.apy : ''}">
              <td>
                <div class="position-name">${pos.displayName}</div>
                <div class="position-asset">${pos.baseAsset}</div>
              </td>
              <td class="amount">${formatCurrency(pos.valueUsd)}</td>
              <td class="${getApyClass(pos.apy)}">${formatApy(pos.apy, 'apy', pos)}</td>
              <td class="${getApyClass(pos.apy7d)}">${formatApy(pos.apy7d, 'apy7d', pos)}</td>
              <td class="${getApyClass(pos.apy30d)}">${formatApy(pos.apy30d, 'apy30d', pos)}</td>
              <td class="amount">${formatCurrency(pos.estDailyUsd)}</td>
              <td class="amount">${formatCurrency(pos.estMonthlyUsd)}</td>
              <td>${pos.lastUpdated ? formatDate(pos.lastUpdated) : 'Never'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

  } catch (error) {
    container.innerHTML = `<p class="empty-state" style="color: var(--danger)">Error loading positions: ${error.message}</p>`;
  }
}

// Load Portfolio Summary
async function loadPortfolioSummary() {
  try {
    // Fetch all positions
    const response = await fetch(`${API_BASE}/positions`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to load positions for summary');
    }

    const data = await response.json();
    let positions = data.positions || [];

    // Filter positions based on selected wallets
    // When no wallets are selected, filter returns empty array (correct behavior)
    positions = positions.filter(pos => selectedWalletIds.has(pos.walletId));

    // Calculate totals from filtered positions
    const totalValueUsd = positions.reduce((sum, pos) => sum + (pos.valueUsd || 0), 0);
    const estDailyUsd = positions.reduce((sum, pos) => sum + (pos.estDailyUsd || 0), 0);
    const estMonthlyUsd = positions.reduce((sum, pos) => sum + (pos.estMonthlyUsd || 0), 0);
    const estYearlyUsd = positions.reduce((sum, pos) => sum + (pos.estYearlyUsd || 0), 0);

    // Find most recent update time
    const lastUpdated = positions.reduce((latest, pos) => {
      if (!pos.lastUpdated) return latest;
      const posDate = new Date(pos.lastUpdated);
      return !latest || posDate > latest ? posDate : latest;
    }, null);

    document.getElementById('totalValue').textContent = formatCurrency(totalValueUsd);
    document.getElementById('dailyIncome').textContent = formatCurrency(estDailyUsd);
    document.getElementById('monthlyIncome').textContent = formatCurrency(estMonthlyUsd);
    document.getElementById('yearlyIncome').textContent = formatCurrency(estYearlyUsd);
    // Render income context based on estimated annual income
    renderIncomeContext(estYearlyUsd);
    document.getElementById('lastUpdated').textContent = `Last updated: ${lastUpdated ? formatDate(lastUpdated.toISOString()) : 'Never'}`;

    // Load stablecoin prices
    loadStablecoinPrices();

  } catch (error) {
    console.error('Failed to load portfolio summary:', error);
  }
}

// Load Stablecoin Prices
async function loadStablecoinPrices() {
  const container = document.getElementById('stablecoinPrices');

  try {
    // Fetch stablecoin list from database
    const stablecoinsResponse = await fetch(`${API_BASE}/stablecoins`, {
      credentials: 'include',
    });

    if (!stablecoinsResponse.ok) {
      throw new Error('Failed to load stablecoin list');
    }

    const stablecoinsData = await stablecoinsResponse.json();
    const stablecoins = stablecoinsData.stablecoins || [];

    // Fetch current prices
    const pricesResponse = await fetch(`${API_BASE}/prices/stablecoins`, {
      credentials: 'include',
    });

    if (!pricesResponse.ok) {
      throw new Error('Failed to load stablecoin prices');
    }

    const pricesData = await pricesResponse.json();
    const prices = pricesData.prices || {};

    // Build price elements using data from database
    const priceElements = stablecoins
      .filter(coin => prices[coin.symbol] !== undefined && coin.coingeckoId)
      .map(coin => {
        const price = prices[coin.symbol];
        const url = `https://www.coingecko.com/en/coins/${coin.coingeckoId}`;
        return `
          <div class="stablecoin-price">
            <span class="stablecoin-symbol">${coin.symbol}:</span>
            <a href="${url}" target="_blank" rel="noopener noreferrer" class="stablecoin-value">
              $${price.toFixed(4)}
            </a>
          </div>
        `;
      });

    if (priceElements.length > 0) {
      // Add "Rates from Coingecko" at the end
      priceElements.push(`
        <span style="color: var(--text-dim); font-size: 0.875rem; margin-left: 0.5rem;">
          Rates from Coingecko
        </span>
      `);
      container.innerHTML = priceElements.join('');
    } else {
      container.innerHTML = '<span style="color: var(--text-dim); font-size: 0.875rem;">Stablecoin prices unavailable</span>';
    }
  } catch (error) {
    console.error('Failed to load stablecoin prices:', error);
    container.innerHTML = '';
  }
}

// Utility Functions
// Income context lookup (cached across calls)
let _nycSalaryBands = null;
let _locationBands = null;

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
    // Best-effort: silently ignore; UI will skip context
    console.warn('Failed to load income context tables:', e);
  }
}

function pickBand(bands, value) {
  if (!Array.isArray(bands)) return null;
  for (const band of bands) {
    const min = Number(band.min) || 0;
    const max = band.max === null || band.max === undefined ? Infinity : Number(band.max);
    if (value >= min && value <= max) return band;
  }
  return null;
}

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

function showStatus(element, message, type) {
  element.textContent = message;
  element.className = `status-message ${type}`;
  element.style.display = 'block';

  if (type === 'success') {
    setTimeout(() => {
      element.className = 'status-message';
      element.style.display = 'none';
    }, 5000);
  }
}

function formatCurrency(value) {
  if (value === null || value === undefined) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

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

function getApyClass(value) {
  if (value === null || value === undefined) return 'apy-neutral';
  return value > 0 ? 'apy-value' : 'apy-neutral';
}

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

// Historical chart
let historyChartInstance = null;

async function showHistoryChart() {
  const modal = document.getElementById('historyModal');
  modal.style.display = 'flex';

  try {
    // Build query string with selected wallet IDs
    const walletIdsParam = selectedWalletIds.size > 0
      ? `?walletIds=${[...selectedWalletIds].join(',')}`
      : '';

    const response = await fetch(`${API_BASE}/portfolio/history${walletIdsParam}`, {
      credentials: 'include',
    });
    const data = await response.json();

    if (!data.history || data.history.length === 0) {
      alert('No historical data available yet for selected wallets. Data points are collected daily.');
      closeHistoryModal();
      return;
    }

    renderHistoryChart(data.history);
  } catch (error) {
    console.error('Failed to fetch history:', error);
    alert('Failed to load historical data');
    closeHistoryModal();
  }
}

function closeHistoryModal() {
  const modal = document.getElementById('historyModal');
  modal.style.display = 'none';

  if (historyChartInstance) {
    historyChartInstance.destroy();
    historyChartInstance = null;
  }
}

function renderHistoryChart(history) {
  const canvas = document.getElementById('historyChart');
  const ctx = canvas.getContext('2d');

  if (historyChartInstance) {
    historyChartInstance.destroy();
  }

  const dates = history.map(h => h.date);
  const values = history.map(h => h.totalValueUsd);

  historyChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        label: 'Portfolio Value (USD)',
        data: values,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#10b981',
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: '#f1f5f9',
          bodyColor: '#cbd5e1',
          borderColor: '#475569',
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            label: function(context) {
              return '$' + context.parsed.y.toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
              });
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: '#334155',
            drawBorder: false
          },
          ticks: {
            color: '#94a3b8',
            maxRotation: 45,
            minRotation: 45
          }
        },
        y: {
          grid: {
            color: '#334155',
            drawBorder: false
          },
          ticks: {
            color: '#94a3b8',
            callback: function(value) {
              return '$' + value.toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
              });
            }
          }
        }
      }
    }
  });
}

// Close modal when clicking outside
document.addEventListener('click', function(event) {
  const historyModal = document.getElementById('historyModal');
  const rescanModal = document.getElementById('rescanModal');

  if (event.target === historyModal) {
    closeHistoryModal();
  }
  if (event.target === rescanModal) {
    closeRescanModal();
  }
});

// Return to dashboard (from add wallet screen)
async function returnToDashboard() {
  showDashboard();
  await loadWallets();
  await loadPositions();
  await loadPortfolioSummary();
}

// Expose functions to global scope for HTML inline handlers
window.addWallet = addWallet;
window.deleteWallet = deleteWallet;
window.scanWallet = scanWallet;
window.showAddWalletForm = showAddWalletForm;
window.toggleWalletSelection = toggleWalletSelection;
window.showHistoryChart = showHistoryChart;
window.closeHistoryModal = closeHistoryModal;
window.closeRescanModal = closeRescanModal;
window.returnToDashboard = returnToDashboard;

})(); // End of IIFE
