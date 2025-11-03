// Landing page functionality

// Load auth forms component
async function loadAuthForms() {
  const placeholder = document.getElementById('auth-forms-placeholder');
  if (!placeholder) return;

  try {
    const response = await fetch('/components/auth-forms.html');
    const html = await response.text();
    placeholder.innerHTML = html;

    // Add "or view as guest" link to login form
    const extraSpan = placeholder.querySelector('.auth-footer-extra');
    if (extraSpan) {
      extraSpan.innerHTML = ' or <a href="/guest.html">View as guest</a>';
    }
  } catch (error) {
    console.error('Failed to load auth forms:', error);
  }
}

// Load auth forms on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadAuthForms);
} else {
  loadAuthForms();
}

// Show/hide auth modal
window.showAuthModal = function(mode = 'login') {
  const modal = document.getElementById('authModal');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');

  if (mode === 'login') {
    loginForm.style.display = 'block';
    registerForm.style.display = 'none';
  } else {
    loginForm.style.display = 'none';
    registerForm.style.display = 'block';
  }

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

window.closeAuthModal = function() {
  const modal = document.getElementById('authModal');
  modal.style.display = 'none';
  document.body.style.overflow = 'auto';
}

window.switchToLogin = function() {
  window.showAuthModal('login');
}

window.switchToRegister = function() {
  window.showAuthModal('register');
}

// Handle guest view - fetch default wallet and redirect
window.handleGuestView = async function(event) {
  if (event) event.preventDefault();

  const API_BASE = window.APP_CONFIG?.apiBase || '/api';

  try {
    const response = await fetch(`${API_BASE}/guest/default-wallet`);
    if (!response.ok) {
      throw new Error('Failed to fetch guest wallet');
    }

    const data = await response.json();
    if (data && data.id) {
      window.location.href = `/guest.html?wallet=${encodeURIComponent(data.id)}`;
    } else {
      throw new Error('No guest wallet configured');
    }
  } catch (error) {
    console.error('Failed to load guest view:', error);
    alert('Guest view is not available at the moment. Please try again later.');
  }
}

// Close modal with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.closeAuthModal();
  }
});

// Check auth status and redirect if already logged in
async function checkAuthAndRedirect() {
  // Get API base from config or auth.js
  const API_BASE = window.APP_CONFIG?.apiBase || '/api';

  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include'
    });

    if (response.ok) {
      // User is already logged in, redirect to dashboard
      window.location.href = '/dashboard.html';
    } else {
      // Not logged in, check if we should show auth modal from URL
      const urlParams = new URLSearchParams(window.location.search);
      const mode = urlParams.get('mode');
      if (mode === 'login' || mode === 'register') {
        window.showAuthModal(mode);
      }
    }
  } catch (error) {
    console.log('Not logged in, showing landing page');
    // Still check for URL mode
    const urlParams = new URLSearchParams(window.location.search);
    const mode = urlParams.get('mode');
    if (mode === 'login' || mode === 'register') {
      window.showAuthModal(mode);
    }
  }
}

// Only run auth check if not already done by auth.js
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // Small delay to let auth.js run first
    setTimeout(checkAuthAndRedirect, 100);
  });
} else {
  setTimeout(checkAuthAndRedirect, 100);
}
