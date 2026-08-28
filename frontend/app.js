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
  if (!response.body) {
    throw new Error('The server returned an empty discovery response');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let completionData = null;
  let streamError = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch (_error) {
          throw new Error('The server sent an invalid discovery progress update');
        }
        handleDiscoveryEvent(event, statusText, positionsContainer);
        if (event.type === 'complete') {
          completed = true;
          completionData = event.data;
        }
        if (event.type === 'error') streamError = event.data?.message || 'Discovery failed';
      }
    }
  }

  if (streamError) {
    throw new Error(streamError);
  }
  if (!completed) {
    throw new Error('The discovery connection closed before the scan completed');
  }

  return completionData;
}

// Wallet selection management
// Note: shortAddr and other utility functions now loaded from /utils.js
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

    // Existing shared wallets return JSON; newly created wallets stream SSE.
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      await consumeDiscoveryStream(response, statusText, positionsContainer);
    } else {
      const data = await response.json();
      statusText.textContent = data.message || 'Wallet added';
    }

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
    case 'status':
      statusText.textContent = event.data.message;
      break;

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

    case 'protocol_error': {
      const errorItem = document.createElement('div');
      errorItem.className = 'position-discovery-item';
      errorItem.style.borderColor = 'var(--danger)';

      const errorIcon = document.createElement('div');
      errorIcon.className = 'check-icon';
      errorIcon.style.background = 'var(--danger)';
      errorIcon.textContent = '!';

      const details = document.createElement('div');
      details.className = 'position-discovery-details';
      const name = document.createElement('div');
      name.className = 'position-discovery-name';
      name.textContent = `${event.data.protocol} failed`;
      const message = document.createElement('div');
      message.className = 'position-discovery-meta';
      message.textContent = event.data.message;
      details.append(name, message);

      errorItem.append(errorIcon, details);
      positionsContainer.appendChild(errorItem);
      statusText.textContent = `${event.data.protocol} failed; continuing with other protocols…`;
      break;
    }

    case 'protocol_complete':
      // Just continue to next protocol
      break;

    case 'complete':
      const failedCount = event.data.failedProtocols?.length || 0;
      statusText.textContent = failedCount > 0
        ? `Discovery finished with ${failedCount} protocol failure${failedCount !== 1 ? 's' : ''}; found ${event.data.totalPositions} position${event.data.totalPositions !== 1 ? 's' : ''}`
        : `Discovery complete! Found ${event.data.totalPositions} position${event.data.totalPositions !== 1 ? 's' : ''}`;
      if (failedCount > 0) statusText.style.color = 'var(--danger)';
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

  if (btnEl?.dataset.scanning === 'true') return;

  const originalButtonText = btnEl?.textContent || 'Re-scan';
  if (btnEl) {
    btnEl.dataset.scanning = 'true';
    btnEl.disabled = true;
    btnEl.textContent = 'Scanning…';
  }

  try {
    // Show modal with progress UI
    modal.style.display = 'flex';
    positionsContainer.innerHTML = '';
    statusText.style.removeProperty('color');
    statusText.textContent = 'Contacting the server…';

    const controller = new AbortController();
    const connectionTimeout = setTimeout(() => controller.abort(), 15_000);

    let response;
    try {
      response = await fetch(`${API_BASE}/wallets/${walletId}/scan`, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(connectionTimeout);
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to start scan');
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      throw new Error('The server did not start a discovery progress stream');
    }

    // Handle SSE stream
    const completion = await consumeDiscoveryStream(response, statusText, positionsContainer);

    // Keep protocol failures visible until the user closes the modal. Successful
    // scans retain the existing brief completion message before closing.
    if ((completion?.failedProtocols?.length || 0) > 0) {
      await loadPositions();
      await loadPortfolioSummary();
    } else {
      setTimeout(async () => {
        await loadPositions();
        await loadPortfolioSummary();
        closeRescanModal();
      }, 1500);
    }

  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'The server did not acknowledge the scan within 15 seconds'
      : (error.message || 'Unknown error');
    statusText.style.color = 'var(--danger)';
    statusText.textContent = `Scan failed for ${walletAddress}: ${message}`;
    console.error(`Failed to scan ${walletAddress}:`, error);
  } finally {
    if (btnEl) {
      delete btnEl.dataset.scanning;
      btnEl.disabled = false;
      btnEl.textContent = originalButtonText;
    }
  }
}

function closeRescanModal() {
  const modal = document.getElementById('rescanModal');
  modal.style.display = 'none';
}

// Global variables to store actual yields
let actual24hYield = 0;
let actual7dYield = 0;
let actual30dYield = 0;

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

    // Store actual yields from summary for use in portfolio summary
    if (data.summary) {
      actual24hYield = data.summary.actual24hYield || 0;
      actual7dYield = data.summary.actual7dYield || 0;
      actual30dYield = data.summary.actual30dYield || 0;
    }

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
            <th>4h APY</th>
            <th>7d APY*</th>
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
                ${getPositionTypeBadge(pos.positionType)}
              </td>
              <td class="amount">${formatCurrency(pos.valueUsd)}</td>
              <td class="${getApyClass(pos.apy)}">${formatApy(pos.apy, 'apy', pos)}</td>
              <td class="${getApyClass(pos.apy7d)}">${formatApy(pos.apy7d, 'apy7d', pos)}</td>
              <td class="${getApyClass(pos.apy30d)}">${formatApy(pos.apy30d, 'apy30d', pos)}</td>
              <td class="amount">${formatIncomeEstimate(pos, 'estDailyUsd')}</td>
              <td class="amount">${formatIncomeEstimate(pos, 'estMonthlyUsd')}</td>
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
    const onlyCollecting = positions.length > 0 && positions.every(pos =>
      pos.projection && pos.projection.maturity === 'collecting'
    );

    // Find most recent update time
    const lastUpdated = positions.reduce((latest, pos) => {
      if (!pos.lastUpdated) return latest;
      const posDate = new Date(pos.lastUpdated);
      return !latest || posDate > latest ? posDate : latest;
    }, null);

    document.getElementById('totalValue').textContent = formatCurrency(totalValueUsd);
    document.getElementById('annualIncome').textContent = onlyCollecting ? 'Collecting data' : formatCurrency(estYearlyUsd);

    // Update income estimates with actual yields displayed below
    const estWeeklyUsd = estDailyUsd * 7;

    document.getElementById('dailyIncome').textContent = onlyCollecting ? 'Collecting data' : formatCurrency(estDailyUsd);
    document.getElementById('dailyActual').textContent = `+${formatCurrency(actual24hYield)}`;

    document.getElementById('weeklyIncome').textContent = onlyCollecting ? 'Collecting data' : formatCurrency(estWeeklyUsd);
    document.getElementById('weeklyActual').textContent = `+${formatCurrency(actual7dYield)}`;

    document.getElementById('monthlyIncome').textContent = onlyCollecting ? 'Collecting data' : formatCurrency(estMonthlyUsd);
    document.getElementById('monthlyActual').textContent = `+${formatCurrency(actual30dYield)}`;
    // Render income context based on estimated annual income
    renderIncomeContext(estYearlyUsd);
    renderProjectionMaturityNote(positions);
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
// All shared utility functions (formatCurrency, formatApy, formatDate, shortAddr, etc.)
// are now loaded from /utils.js

// App-specific functions that are NOT in utils.js
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
