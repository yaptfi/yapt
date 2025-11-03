// Notification Settings Page JavaScript

// Get API base URL from config
const API_BASE = (typeof window !== 'undefined' && window.APP_CONFIG && window.APP_CONFIG.apiBase)
  ? window.APP_CONFIG.apiBase
  : '/api';

// Check authentication on page load
window.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  await loadSettings();
  await loadHistory();
});

// Check if user is authenticated
async function checkAuth() {
  try {
    console.log('Checking auth...', API_BASE);
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
    });

    console.log('Auth response:', response.status, response.ok);

    if (!response.ok) {
      // Not authenticated, redirect to login
      console.error('Not authenticated, redirecting to home');
      setTimeout(() => {
        window.location.href = '/';
      }, 2000); // Wait 2 seconds so user can see error
      return;
    }

    const data = await response.json();
    console.log('User authenticated:', data.user.username);
    // Username is now displayed by the header component, no need to set it here
  } catch (error) {
    console.error('Auth check failed:', error);
    alert('Authentication failed: ' + error.message);
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  }
}

// Load current notification settings
async function loadSettings() {
  const loadingScreen = document.getElementById('loadingScreen');
  const settingsForm = document.getElementById('settingsForm');
  const historySection = document.getElementById('historySection');

  try {
    const response = await fetch(`${API_BASE}/notifications/settings`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to load settings');
    }

    const settings = await response.json();

    // Load supported stablecoins for dynamic selector
    let stablecoins = [];
    try {
      const scRes = await fetch(`${API_BASE}/stablecoins`, { credentials: 'include' });
      if (scRes.ok) {
        const data = await scRes.json();
        stablecoins = Array.isArray(data.stablecoins) ? data.stablecoins : [];
      }
    } catch (e) {
      console.warn('Failed to load stablecoins list:', e);
    }

    // Populate form with current settings
    document.getElementById('depegEnabled').checked = settings.depegEnabled;
    document.getElementById('depegSeverity').value = settings.depegSeverity || 'default';
    document.getElementById('depegLowerThreshold').value = settings.depegLowerThreshold || '0.99';
    document.getElementById('depegUpperThreshold').value = settings.depegUpperThreshold || '';

    document.getElementById('apyEnabled').checked = settings.apyEnabled;
    document.getElementById('apySeverity').value = settings.apySeverity || 'default';
    document.getElementById('apyThreshold').value = (parseFloat(settings.apyThreshold || '0.01') * 100).toFixed(2);

    // Populate depeg stablecoin checkboxes
    renderStablecoinSelector(stablecoins, settings.depegSymbols);

    // Show ntfy topic if available
    if (settings.ntfyTopic) {
      document.getElementById('ntfyTopic').textContent = settings.ntfyTopic;
      document.getElementById('topicDisplay').style.display = 'block';
    }

    // Setup event listeners for checkboxes
    document.getElementById('depegEnabled').addEventListener('change', (e) => {
      document.getElementById('depegSettings').style.display = e.target.checked ? 'block' : 'none';
    });

    document.getElementById('apyEnabled').addEventListener('change', (e) => {
      document.getElementById('apySettings').style.display = e.target.checked ? 'block' : 'none';
    });

    // Trigger initial state
    document.getElementById('depegSettings').style.display = settings.depegEnabled ? 'block' : 'none';
    document.getElementById('apySettings').style.display = settings.apyEnabled ? 'block' : 'none';

    // Show form
    loadingScreen.style.display = 'none';
    settingsForm.style.display = 'block';
    historySection.style.display = 'block';
  } catch (error) {
    console.error('Failed to load settings:', error);
    loadingScreen.innerHTML = '<p style="color: var(--error);">Failed to load settings. Please try again.</p>';
  }
}

// Render the stablecoin multi-select checkboxes
function renderStablecoinSelector(stablecoins, selectedSymbols) {
  const container = document.getElementById('depegCoins');
  if (!container) return;
  container.innerHTML = '';

  const selectedSet = new Set(
    Array.isArray(selectedSymbols) ? selectedSymbols.map((s) => String(s).toUpperCase()) : []
  );

  stablecoins.forEach((sc) => {
    const symbol = (sc.symbol || '').toUpperCase();
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    label.style.padding = '0.25rem 0.5rem';
    label.style.border = '1px solid var(--border)';
    label.style.borderRadius = '6px';
    label.style.background = 'var(--bg)';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'depegSymbols';
    input.value = symbol;
    input.checked = selectedSet.size > 0 ? selectedSet.has(symbol) : false;

    const span = document.createElement('span');
    span.textContent = `${symbol}`;

    label.appendChild(input);
    label.appendChild(span);
    container.appendChild(label);
  });
}

// Save notification settings
async function saveSettings(event) {
  event.preventDefault();

  const statusMessage = document.getElementById('statusMessage');
  const saveBtn = document.getElementById('saveBtn');

  // Disable button while saving
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  statusMessage.textContent = '';
  statusMessage.className = 'status-message';

  // Collect form data
  const settings = {
    depegEnabled: document.getElementById('depegEnabled').checked,
    depegSeverity: document.getElementById('depegSeverity').value,
    depegLowerThreshold: document.getElementById('depegLowerThreshold').value,
    depegUpperThreshold: document.getElementById('depegUpperThreshold').value || null,
    depegSymbols: (() => {
      if (!document.getElementById('depegEnabled').checked) return null;
      const checked = Array.from(document.querySelectorAll('input[name="depegSymbols"]:checked'))
        .map((el) => el.value.toUpperCase());
      return checked.length > 0 ? checked : null; // null => all coins
    })(),
    apyEnabled: document.getElementById('apyEnabled').checked,
    apySeverity: document.getElementById('apySeverity').value,
    apyThreshold: (parseFloat(document.getElementById('apyThreshold').value) / 100).toString(), // Convert % to decimal
  };

  try {
    const response = await fetch(`${API_BASE}/notifications/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(settings),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to save settings');
    }

    const data = await response.json();

    // If the server returned a topic, show it and detect if this is the first time
    const topicDisplayEl = document.getElementById('topicDisplay');
    const topicBoxEl = document.getElementById('ntfyTopicBox') || topicDisplayEl;
    const wasHidden = window.getComputedStyle(topicDisplayEl).display === 'none';

    if (data.ntfyTopic) {
      document.getElementById('ntfyTopic').textContent = data.ntfyTopic;
      topicDisplayEl.style.display = 'block';
    }

    if (data.ntfyTopic && wasHidden) {
      // Highlight and scroll the topic into view to make it obvious
      topicBoxEl.classList.add('topic-flash');
      topicDisplayEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => topicBoxEl.classList.remove('topic-flash'), 4000);

      // Show clear instruction to update ntfy app with the new topic
      statusMessage.innerHTML = `New notification topic created. Open the ntfy app on your phone and subscribe/update to: <code>${escapeHtml(data.ntfyTopic)}</code>`;
      statusMessage.className = 'status-message info';
    } else {
      statusMessage.textContent = 'Settings saved successfully!';
      statusMessage.className = 'status-message success';
    }

    // Reload history to see any test notifications
    setTimeout(() => loadHistory(), 1000);
  } catch (error) {
    console.error('Failed to save settings:', error);
    statusMessage.textContent = `Error: ${error.message}`;
    statusMessage.className = 'status-message error';
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
  }
}

// Load notification history
async function loadHistory() {
  const historyContainer = document.getElementById('notificationHistory');

  try {
    const response = await fetch(`${API_BASE}/notifications/history?limit=20`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to load history');
    }

    const data = await response.json();

    if (!data.notifications || data.notifications.length === 0) {
      historyContainer.innerHTML = '<p class="empty-state">No notifications sent yet</p>';
      return;
    }

    // Build history table
    const table = document.createElement('table');
    table.className = 'notifications-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Type</th>
          <th>Severity</th>
          <th>Message</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        ${data.notifications.map(notif => `
          <tr>
            <td><span class="badge badge-${notif.notificationType}">${formatType(notif.notificationType)}</span></td>
            <td><span class="severity severity-${notif.severity}">${notif.severity}</span></td>
            <td>
              <strong>${escapeHtml(notif.title)}</strong><br>
              <span style="color: var(--text-secondary); font-size: 0.9em;">${escapeHtml(notif.message)}</span>
            </td>
            <td style="white-space: nowrap;">${formatTime(notif.sentAt)}</td>
          </tr>
        `).join('')}
      </tbody>
    `;

    historyContainer.innerHTML = '';
    historyContainer.appendChild(table);
  } catch (error) {
    console.error('Failed to load history:', error);
    historyContainer.innerHTML = '<p style="color: var(--error);">Failed to load notification history</p>';
  }
}

// Helper function to format notification type
function formatType(type) {
  const types = {
    'depeg': 'Depeg',
    'apy_drop': 'APY Drop',
  };
  return types[type] || type;
}

// Helper function to format time
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  // If less than 1 hour ago, show relative time
  if (diff < 60 * 60 * 1000) {
    const minutes = Math.floor(diff / (60 * 1000));
    return `${minutes}m ago`;
  }

  // If less than 24 hours ago, show hours
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    return `${hours}h ago`;
  }

  // Otherwise show date
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Helper function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
