# Backend API Requirements for Yapt iOS Notifications (Phase 3 + 3b)

## Overview
The iOS app has **fully implemented** notification settings, history feed, and APNs push notification support. Backend needs to provide 5 API endpoints:

**Phase 3 (Core)** - required for notifications to work:
1. `GET /api/notifications/settings` - Fetch user preferences
2. `PUT /api/notifications/settings` - Update user preferences
3. `GET /api/notifications/history` - Paginated notification history

**Phase 3b (Push)** - required for push notifications:
4. `POST /api/notifications/devices` - Register APNs device token
5. `DELETE /api/notifications/devices/:deviceId` - Unregister device

---

## Required Endpoints

### 1. GET /api/notifications/settings
**Purpose**: Retrieve user's current notification preferences

**Response** (200 OK):
```json
{
  "settings": {
    "depegEnabled": true,
    "depegSeverity": "high",
    "depegLowerThreshold": 0.95,
    "depegUpperThreshold": 1.05,
    "depegSymbols": ["USDC", "USDT", "DAI"],  // null or omit for all stablecoins
    "apyEnabled": true,
    "apySeverity": "default",
    "apyThreshold": 0.05,
    "ntfyTopic": "yapt_username_userid"  // Read-only, for transparency
  }
}
```

**Authentication**: Required (yapt.sid cookie)

**Notes**:
- `depegSymbols`: null/empty array = monitor all stablecoins
- Thresholds are absolute values (0.95 = $0.95, 1.05 = $1.05)
- `apyThreshold`: decimal (0.05 = 5% change)
- Severity levels: `"min"`, `"low"`, `"default"`, `"high"`, `"urgent"`

---

### 2. PUT /api/notifications/settings
**Purpose**: Update user's notification preferences

**Request Body**:
```json
{
  "depegEnabled": true,
  "depegSeverity": "high",
  "depegLowerThreshold": 0.95,
  "depegUpperThreshold": 1.05,
  "depegSymbols": ["USDC", "USDT"],  // Optional, null = all
  "apyEnabled": false,
  "apySeverity": "default",
  "apyThreshold": 0.10,
  "ntfyTopic": "yapt_username_userid"  // Should be ignored/preserved
}
```

**Response** (200 OK): Same as GET response with updated values

**Validation**:
- `depegLowerThreshold`: 0 < value < 1
- `depegUpperThreshold`: 1 < value < 2
- `apyThreshold`: 0 < value < 1
- `depegSeverity`, `apySeverity`: Must be one of: `min`, `low`, `default`, `high`, `urgent`

**Error Response** (400 Bad Request):
```json
{
  "error": "Invalid threshold: depegLowerThreshold must be between 0 and 1"
}
```

**Authentication**: Required

**Notes**:
- Settings should be created on first access if not exists (default all disabled)
- `ntfyTopic` should not be modifiable by user (server-controlled)

---

### 3. GET /api/notifications/history
**Purpose**: Retrieve paginated notification history for the user

**Query Parameters**:
- `limit` (optional, default: 50, max: 100): Number of notifications to return
- `offset` (optional, default: 0): Pagination offset
- `type` (optional): Filter by type (`"depeg"` or `"apy"`), omit for all

**Example**: `/api/notifications/history?limit=20&offset=40&type=depeg`

**Response** (200 OK):
```json
{
  "notifications": [
    {
      "id": "notif-uuid-001",
      "type": "depeg",
      "severity": "urgent",
      "title": "USDC Depeg Alert",
      "message": "USDC has depegged to $0.94 (-6.0% from target)",
      "metadata": {
        "positionId": "550e8400-e29b-41d4-a716-446655440001",
        "walletId": "650e8400-e29b-41d4-a716-446655440001",
        "symbol": "USDC",
        "price": 0.94,
        "deviation": -0.06,
        "oldApy": null,
        "newApy": null,
        "change": null
      },
      "createdAt": "2025-01-15T08:30:00.000Z"
    },
    {
      "id": "notif-uuid-002",
      "type": "apy",
      "severity": "high",
      "title": "Aave APY Increased",
      "message": "Aave USDC APY increased from 4.25% to 5.80% (+36.5%)",
      "metadata": {
        "positionId": "550e8400-e29b-41d4-a716-446655440001",
        "walletId": "650e8400-e29b-41d4-a716-446655440001",
        "symbol": null,
        "price": null,
        "deviation": null,
        "oldApy": 0.0425,
        "newApy": 0.058,
        "change": 0.0155
      },
      "createdAt": "2025-01-15T07:15:00.000Z"
    }
  ],
  "total": 156,
  "hasMore": true
}
```

**Response Fields**:
- `notifications`: Array of notification objects (reverse chronological order)
- `total`: Total number of notifications for this user (with filter applied)
- `hasMore`: Boolean indicating if more notifications exist beyond current offset

**Notification Object**:
- `id`: Unique notification identifier
- `type`: `"depeg"` or `"apy"`
- `severity`: `"min"`, `"low"`, `"default"`, `"high"`, or `"urgent"`
- `title`: Short notification title
- `message`: Full notification message
- `metadata`: Type-specific data (can contain nulls)
- `createdAt`: ISO 8601 timestamp

**Metadata Fields** (include all, use null if not applicable):

**For Depeg Alerts**:
- `symbol`: Stablecoin symbol (e.g., "USDC")
- `price`: Current price in USD
- `deviation`: Deviation from $1.00 (e.g., -0.06 = -6%)
- `positionId`: Related position UUID (if applicable)
- `walletId`: Related wallet UUID (if applicable)

**For APY Alerts**:
- `oldApy`: Previous APY (decimal, e.g., 0.0425 = 4.25%)
- `newApy`: New APY (decimal)
- `change`: APY change (decimal, e.g., 0.0155 = 1.55 percentage points)
- `positionId`: Related position UUID
- `walletId`: Related wallet UUID (if applicable)

**Authentication**: Required

**Notes**:
- Notifications should be sorted newest first (descending `createdAt`)
- Historical notifications should be retained (recommend at least 30 days)
- Pagination uses offset-based approach (not cursor-based)

---

## Notification Generation Logic (Backend)

### Depeg Monitoring
1. Monitor stablecoin prices in real-time
2. Check against user's `depegLowerThreshold` and `depegUpperThreshold`
3. Filter by `depegSymbols` (if specified, otherwise all)
4. Only send if `depegEnabled: true`
5. Send to user's `ntfyTopic` with configured `depegSeverity`
6. Store notification in history

### APY Change Monitoring
1. Track APY changes for user's positions
2. Calculate absolute change (newAPY - oldAPY)
3. Alert if change ≥ `apyThreshold`
4. Only send if `apyEnabled: true`
5. Send to user's `ntfyTopic` with configured `apySeverity`
6. Store notification in history

---

## Phase 3b: APNs Push Notifications

> **iOS Status**: Fully implemented and ready. Backend implementation required.

### 4. POST /api/notifications/devices
**Purpose**: Register an iOS device for push notifications

**Request Body**:
```json
{
  "token": "64-character-hex-string-from-apns",
  "platform": "ios"
}
```

**Response** (201 Created):
```json
{
  "deviceId": "device-uuid-001"
}
```

**Notes**:
- `token`: Hexadecimal string representation of APNs device token (64 chars)
- `platform`: Always "ios" for now (future: could support "android" for FCM)
- Store device tokens per user (one user can have multiple devices)
- If same token already exists for user, return existing deviceId (idempotent)
- If token exists for different user, update to new user (device changed hands)

**Authentication**: Required

---

### 5. DELETE /api/notifications/devices/:deviceId
**Purpose**: Unregister a device from push notifications

**Response**: 204 No Content (empty body)

**Notes**:
- Called on logout or when user disables push notifications
- Should succeed even if deviceId doesn't exist (idempotent)
- No response body expected

**Authentication**: Required

---

### Backend APNs Integration Requirements

1. **Store device tokens**: Table with `userId`, `deviceId`, `token`, `platform`, `createdAt`
2. **Fan-out notifications**: When alerts trigger, send to both:
   - ntfy (existing flow)
   - APNs for all registered iOS devices
3. **APNs payload format**:
```json
{
  "aps": {
    "alert": {
      "title": "USDC Depeg Alert",
      "body": "USDC has depegged to $0.94 (-6.0% from target)"
    },
    "sound": "default",
    "badge": 1
  },
  "notificationId": "notif-uuid-001",
  "type": "depeg"
}
```
4. **Handle APNs errors**: Remove invalid tokens (error code 410 = unregistered)

---

## Testing

**Mock User**: `mockuser` (already exists in mock data)

**Test Data**: Reference `/Yapt/Mocking/MockData/notification-*.json` in iOS repo for expected data structures

**Validation Tests**:
- Settings with invalid thresholds (return 400)
- Settings with invalid severity levels (return 400)
- Pagination boundary conditions (offset > total)
- Type filter with invalid type (ignore or return 400)
- Unauthenticated requests (return 401)

---

## Questions?

Contact iOS team or reference implementation in:
- `/Yapt/Core/Models/NotificationSettings.swift`
- `/Yapt/Core/Models/NotificationLog.swift`
- `/Yapt/Features/Notifications/NotificationService.swift`
