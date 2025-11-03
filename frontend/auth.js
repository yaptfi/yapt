/**
 * Authentication Module
 * Handles passkey (WebAuthn) registration and login
 */

(function() {
  // SimpleWebAuthn browser library is loaded from CDN as window.SimpleWebAuthnBrowser
  const { startRegistration, startAuthentication } = (window.SimpleWebAuthnBrowser || {});

  // API base URL (same as app.js - already includes '/api')
  const API_BASE = (typeof window !== 'undefined' && window.APP_CONFIG && window.APP_CONFIG.apiBase)
    ? window.APP_CONFIG.apiBase
    : '/api';

  let currentUser = null;

/**
 * Check if user is already authenticated on page load
 */
async function checkAuthStatus() {
  // Check if we're on the landing page (has authModal instead of authScreen)
  const isLandingPage = !!document.getElementById('authModal');

  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include', // Include cookies for session
    });

    if (response.ok) {
      const data = await response.json();
      currentUser = data.user;
      // If logged in and on landing page, redirect to dashboard
      if (isLandingPage) {
        window.location.href = '/dashboard.html';
        return true;
      }
      // If we're on the dashboard, show the app
      const hasMainApp = !!document.getElementById('mainApp');
      if (!hasMainApp) {
        window.location.href = '/dashboard.html';
        return true;
      }
      showMainApp();
      return true;
    } else {
      // User not authenticated
      // If on landing page, stay there (do nothing)
      if (isLandingPage) {
        return false;
      }
      // If we're on the dashboard (no auth screen), redirect to landing
      const hasAuthScreen = !!document.getElementById('authScreen');
      if (!hasAuthScreen) {
        window.location.href = '/';
        return false;
      }
      showAuthScreen();
      return false;
    }
  } catch (error) {
    console.error('Auth check failed:', error);
    // If on landing page, stay there
    if (isLandingPage) {
      return false;
    }
    const hasAuthScreen = !!document.getElementById('authScreen');
    if (!hasAuthScreen) {
      window.location.href = '/';
      return false;
    }
    showAuthScreen();
    return false;
  }
}

/**
 * Handle user registration with passkey
 */
async function handleRegister(event) {
  event.preventDefault();

  const username = document.getElementById('registerUsername').value.trim();
  const messageEl = document.getElementById('registerMessage');
  const submitBtn = event.target.querySelector('button[type="submit"]');

  // Clear previous messages
  messageEl.className = 'auth-message';
  messageEl.textContent = '';

  // Disable button during registration
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account...';

  try {
    // Step 1: Get registration options from server
    messageEl.className = 'auth-message info';
    messageEl.textContent = 'Requesting registration options...';

    const optionsResponse = await fetch(`${API_BASE}/auth/register/generate-options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username }),
    });

    if (!optionsResponse.ok) {
      const error = await optionsResponse.json();
      throw new Error(error.error || 'Failed to generate registration options');
    }

    const options = await optionsResponse.json();

    // Step 2: Start WebAuthn registration (browser prompts for passkey)
    messageEl.textContent = 'Please create your passkey...';

    let attResp;
    try {
      attResp = await startRegistration(options);
    } catch (error) {
      // User likely cancelled the passkey creation
      throw new Error('Passkey creation cancelled or failed. Please try again.');
    }

    // Step 3: Send registration response to server for verification
    messageEl.textContent = 'Verifying registration...';

    const verificationResponse = await fetch(`${API_BASE}/auth/register/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(attResp),
    });

    if (!verificationResponse.ok) {
      const error = await verificationResponse.json();
      throw new Error(error.error || 'Registration verification failed');
    }

    const verification = await verificationResponse.json();

    if (verification.verified) {
      currentUser = verification.user;
      messageEl.className = 'auth-message success';
      messageEl.textContent = 'Account created successfully! Loading your dashboard...';

      // Redirect to dashboard
      setTimeout(() => { window.location.href = '/dashboard.html'; }, 500);
    } else {
      throw new Error('Registration verification failed');
    }

  } catch (error) {
    console.error('Registration error:', error);
    messageEl.className = 'auth-message error';
    messageEl.textContent = error.message || 'Registration failed. Please try again.';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account with Passkey';
  }
}

/**
 * Handle user login with passkey
 */
async function handleLogin(event) {
  event.preventDefault();

  const username = document.getElementById('loginUsername').value.trim();
  const messageEl = document.getElementById('loginMessage');
  const submitBtn = event.target.querySelector('button[type="submit"]');

  // Clear previous messages
  messageEl.className = 'auth-message';
  messageEl.textContent = '';

  // Disable button during login
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';

  try {
    // Step 1: Get authentication options from server
    messageEl.className = 'auth-message info';
    messageEl.textContent = 'Requesting authentication options...';

    const optionsResponse = await fetch(`${API_BASE}/auth/login/generate-options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username }),
    });

    if (!optionsResponse.ok) {
      const error = await optionsResponse.json();
      throw new Error(error.error || 'Failed to generate login options');
    }

    const options = await optionsResponse.json();

    // Step 2: Start WebAuthn authentication (browser prompts for passkey)
    messageEl.textContent = 'Please authenticate with your passkey...';

    let asseResp;
    try {
      asseResp = await startAuthentication(options);
    } catch (error) {
      // User likely cancelled the authentication
      throw new Error('Authentication cancelled or failed. Please try again.');
    }

    // Step 3: Send authentication response to server for verification
    messageEl.textContent = 'Verifying authentication...';

    const verificationResponse = await fetch(`${API_BASE}/auth/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(asseResp),
    });

    if (!verificationResponse.ok) {
      const error = await verificationResponse.json();
      throw new Error(error.error || 'Authentication verification failed');
    }

    const verification = await verificationResponse.json();

    if (verification.verified) {
      currentUser = verification.user;
      messageEl.className = 'auth-message success';
      messageEl.textContent = 'Signed in successfully! Loading your dashboard...';

      // Redirect to dashboard
      setTimeout(() => { window.location.href = '/dashboard.html'; }, 500);
    } else {
      throw new Error('Authentication verification failed');
    }

  } catch (error) {
    console.error('Login error:', error);
    messageEl.className = 'auth-message error';
    messageEl.textContent = error.message || 'Sign in failed. Please try again.';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in with Passkey';
  }
}

/**
 * Handle user logout
 */
async function handleLogout() {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });

    currentUser = null;
    // Always go back to landing page on logout
    window.location.href = '/';
  } catch (error) {
    console.error('Logout error:', error);
    // Still clear user and show auth screen even if request fails
    currentUser = null;
    window.location.href = '/';
  }
}

/**
 * Show the authentication screen
 */
function showAuthScreen() {
  const authEl = document.getElementById('authScreen');
  const mainEl = document.getElementById('mainApp');
  if (!authEl) {
    window.location.href = '/';
    return;
  }
  authEl.style.display = 'flex';
  if (mainEl) mainEl.style.display = 'none';

  // Reset forms
  showLoginForm();

  // Populate the guest link to point at the desired wallet's guest view
  tryPopulateGuestLink();
}

/**
 * Show the main application
 */
function showMainApp() {
  const authEl = document.getElementById('authScreen');
  const mainEl = document.getElementById('mainApp');
  if (!mainEl) {
    window.location.href = '/dashboard.html';
    return;
  }
  if (authEl) authEl.style.display = 'none';
  mainEl.style.display = 'block';

  // Update username display (for old auth screen, not needed for new header)
  if (currentUser) {
    const usernameEl = document.getElementById('currentUsername');
    if (usernameEl) {
      usernameEl.textContent = currentUser.username;
    }

    // Show admin link if user is an admin
    const adminLink = document.getElementById('adminLink');
    if (adminLink) {
      adminLink.style.display = currentUser.isAdmin ? 'inline' : 'none';
    }
  }

  // Trigger app initialization if function exists (from app.js)
  if (typeof initializeApp === 'function') {
    initializeApp();
  }
}

/**
 * Toggle between login and register forms
 */
function showLoginForm() {
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('registerForm').style.display = 'none';

  // Clear messages and reset buttons
  document.getElementById('loginMessage').className = 'auth-message';
  document.getElementById('loginMessage').textContent = '';
  const loginBtn = document.querySelector('#loginForm button[type="submit"]');
  loginBtn.disabled = false;
  loginBtn.textContent = 'Sign in with Passkey';

  // Clear input
  document.getElementById('loginUsername').value = '';
}

function showRegisterForm() {
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('registerForm').style.display = 'block';

  // Clear messages and reset buttons
  document.getElementById('registerMessage').className = 'auth-message';
  document.getElementById('registerMessage').textContent = '';
  const registerBtn = document.querySelector('#registerForm button[type="submit"]');
  registerBtn.disabled = false;
  registerBtn.textContent = 'Create Account with Passkey';

  // Clear input
  document.getElementById('registerUsername').value = '';
}

/**
 * Get current authenticated user
 */
function getCurrentUser() {
  return currentUser;
}

// Expose functions to global scope for HTML inline handlers
window.handleLogin = handleLogin;
window.handleRegister = handleRegister;
window.handleLogout = handleLogout;
window.showLoginForm = showLoginForm;
window.showRegisterForm = showRegisterForm;
window.getCurrentUser = getCurrentUser;

// Check auth status when page loads
document.addEventListener('DOMContentLoaded', () => {
  checkAuthStatus();
});

/**
 * Populate the "View as guest" link to a specific wallet's guest view.
 * Uses the public admin wallet list to find the wallet ID by address.
 */
async function tryPopulateGuestLink() {
  const guestAnchor = document.getElementById('guestLink');
  if (!guestAnchor) return;

  try {
    const res = await fetch(`${API_BASE}/guest/default-wallet`);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.id) {
      guestAnchor.href = `/guest.html?wallet=${encodeURIComponent(data.id)}`;
    }
  } catch {
    // leave default link in place
  }
}

})(); // End of IIFE
