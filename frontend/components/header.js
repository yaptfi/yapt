// Reusable header component functionality

// Initialize header based on auth state
async function initHeader() {
  // Get API base URL from config
  const API_BASE = window.APP_CONFIG?.apiBase || '/api';

  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      // API returns { user: { username, ... } }
      const username = data.user ? data.user.username : data.username;

      // Wait for elements to be available before updating
      const maxRetries = 10;
      let retries = 0;
      while (retries < maxRetries) {
        if (document.getElementById('headerUsername')) {
          showLoggedInHeader(username);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        retries++;
      }

      if (retries === maxRetries) {
        console.warn('Header elements not found after retries, attempting to show logged in state anyway');
        showLoggedInHeader(username);
      }
    } else {
      showLoggedOutHeader();
    }
  } catch (error) {
    console.error('Failed to check auth status:', error);
    showLoggedOutHeader();
  }
}

function showLoggedInHeader(username) {
  const loginBtn = document.getElementById('headerLoginBtn');
  const getStartedBtn = document.getElementById('headerGetStartedBtn');
  const userMenu = document.getElementById('headerUserMenu');
  const usernameEl = document.getElementById('headerUsername');

  if (loginBtn) loginBtn.style.display = 'none';
  if (getStartedBtn) getStartedBtn.style.display = 'none';
  if (userMenu) userMenu.style.display = 'flex';
  if (usernameEl) {
    usernameEl.textContent = username;
  } else {
    console.warn('Header username element not found');
  }
}

function showLoggedOutHeader() {
  const loginBtn = document.getElementById('headerLoginBtn');
  const getStartedBtn = document.getElementById('headerGetStartedBtn');
  const userMenu = document.getElementById('headerUserMenu');

  if (loginBtn) loginBtn.style.display = 'inline-block';
  if (getStartedBtn) getStartedBtn.style.display = 'inline-block';
  if (userMenu) userMenu.style.display = 'none';
}

// Handle login button click
function handleHeaderLogin() {
  // If we're on the landing page with modal, show it
  if (typeof window.showAuthModal === 'function') {
    window.showAuthModal('login');
  } else {
    // Otherwise redirect to landing page
    window.location.href = '/?mode=login';
  }
}

// Handle register button click
function handleHeaderRegister() {
  // If we're on the landing page with modal, show it
  if (typeof window.showAuthModal === 'function') {
    window.showAuthModal('register');
  } else {
    // Otherwise redirect to landing page
    window.location.href = '/?mode=register';
  }
}

// Handle logout button click
async function handleLogout() {
  const API_BASE = window.APP_CONFIG?.apiBase || '/api';

  try {
    const response = await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });

    if (response.ok) {
      // Redirect to home page after successful logout
      window.location.href = '/';
    } else {
      console.error('Logout failed:', response.statusText);
      alert('Logout failed. Please try again.');
    }
  } catch (error) {
    console.error('Logout error:', error);
    alert('Logout failed. Please try again.');
  }
}

// Load header HTML dynamically
async function loadHeader() {
  const headerPlaceholder = document.getElementById('header-placeholder');
  if (!headerPlaceholder) {
    console.warn('Header placeholder not found');
    return;
  }

  try {
    const response = await fetch('/components/header.html');
    const html = await response.text();
    headerPlaceholder.innerHTML = html;

    // Wait a tick for DOM to update before initializing
    await new Promise(resolve => setTimeout(resolve, 0));
    await initHeader();
  } catch (error) {
    console.error('Failed to load header:', error);
  }
}

// Expose functions globally
window.handleHeaderLogin = handleHeaderLogin;
window.handleHeaderRegister = handleHeaderRegister;
window.handleLogout = handleLogout;

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadHeader);
} else {
  loadHeader();
}
