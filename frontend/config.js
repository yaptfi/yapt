// Frontend configuration
// Picks a sensible default API base depending on how the UI is served.
// - If not overridden, it will target the backend on the same host.
// - You can still override via `window.APP_CONFIG.apiBase` before this file loads.
(function () {
  if (!window.APP_CONFIG || !window.APP_CONFIG.apiBase) {
    try {
      const { hostname, protocol, port } = window.location;

      // If accessed through standard ports (80/443), use relative path
      // This works with reverse proxies (Caddy, nginx) that proxy /api/*
      const isStandardPort = port === '' || port === '80' || port === '443';

      if (isStandardPort) {
        // Use relative path - works with reverse proxy
        window.APP_CONFIG = Object.assign({}, window.APP_CONFIG, { apiBase: '/api' });
      } else {
        // Direct access with non-standard port (e.g., :8080)
        // Auto-detect API port: HTTP -> 3000, HTTPS -> 3443
        const apiProtocol = protocol === 'https:' ? 'https' : 'http';
        const apiPort = protocol === 'https:' ? 3443 : 3000;
        const defaultApi = `${apiProtocol}://${hostname}:${apiPort}/api`;
        window.APP_CONFIG = Object.assign({}, window.APP_CONFIG, { apiBase: defaultApi });
      }
    } catch (_e) {
      // Safe fallback to relative path if window/location not available
      window.APP_CONFIG = Object.assign({}, window.APP_CONFIG, { apiBase: '/api' });
    }
  }
})();
