# EstimatePro Tracking Server

A simple tracking server for EstimatePro estimate view tracking.

## Features

- **View Tracking**: Records when customers view estimates via shareable links
- **Email Tracking**: 1x1 tracking pixel for email open tracking
- **View Statistics**: API to check view counts and history
- **SQLite Database**: Lightweight, file-based storage (can be upgraded to PostgreSQL)

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or with auto-reload
npm run dev
```

Server runs at `http://localhost:3000`

### Test It

1. Open in browser: `http://localhost:3000/view/TEST123`
2. Check stats: `http://localhost:3000/api/views/TEST123`

## API Endpoints

### Public Endpoints (No auth required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/view/:trackingId` | Customer-facing estimate view page |
| GET | `/pixel/:trackingId.gif` | 1x1 tracking pixel for emails |
| GET | `/health` | Health check |

### Authenticated API Endpoints

All `/api/*` endpoints require a bearer token in the `Authorization` header:

```
Authorization: Bearer YOUR_API_KEY
```

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/views/:trackingId` | Get view statistics |
| POST | `/api/register/:trackingId` | Pre-register a tracking ID |
| POST | `/api/device/register` | Register device for push notifications |
| POST | `/api/contractor/register` | Register contractor info |
| POST | `/api/estimate/register` | Register estimate for tracking |
| GET | `/api/notifications/:deviceToken` | Get notifications for device |
| GET | `/api/estimates` | List all tracked estimates |

### Response Examples

**GET /api/views/:trackingId**
```json
{
  "trackingId": "ABC123DEF456",
  "viewCount": 3,
  "lastViewedAt": "2024-01-23T10:30:00.000Z",
  "views": [
    {
      "timestamp": "2024-01-23T10:30:00.000Z",
      "ipAddress": "192.168.1.xxx",
      "userAgent": "Mozilla/5.0..."
    }
  ]
}
```

## iOS App Configuration

Add the tracking server URL to your `Secrets.plist`:

```xml
<key>TrackingBaseUrl</key>
<string>https://your-tracking-server.com</string>
```

## Deployment Options

### Railway (Recommended - Free Tier)

1. Push to GitHub
2. Connect to [Railway](https://railway.app)
3. Deploy automatically

### Render

1. Push to GitHub
2. Create new Web Service on [Render](https://render.com)
3. Set build command: `npm install`
4. Set start command: `npm start`

### Fly.io

```bash
# Install flyctl
brew install flyctl

# Deploy
fly launch
fly deploy
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

```bash
docker build -t estimate-tracking .
docker run -p 3000:3000 estimate-tracking
```

### Heroku

```bash
heroku create my-estimate-tracker
git push heroku main
```

## Security Features

The server includes the following security measures:

- **API Authentication**: Bearer token authentication on all `/api/*` endpoints
- **CORS Restrictions**: Configurable allowed origins (not open by default)
- **Rate Limiting**: 100 req/15min on API endpoints, 300 req/15min on view/pixel endpoints
- **XSS Prevention**: All user-provided data is HTML-escaped before rendering
- **Security Headers**: Helmet.js with Content Security Policy enabled
- **Async I/O**: Non-blocking file writes with write mutex to prevent race conditions
- **Data Caps**: Views array capped at 10,000 entries, notifications at 100
- **IP Hashing**: Viewer IPs are SHA-256 hashed (not stored in plain text)
- **Email Validation**: Contractor email validated on registration

## Production Considerations

1. **Database**: For production, consider PostgreSQL or MongoDB (currently uses JSON file storage)
2. **HTTPS**: Always use HTTPS in production
3. **Monitoring**: Add error tracking (Sentry) and monitoring
4. **Backups**: Implement database backup strategy
5. **APNs**: Configure `@parse/node-apn` with production certificates

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| API_KEY | (required) | Bearer token for API authentication |
| ALLOWED_ORIGINS | (none) | Comma-separated list of allowed CORS origins |
| SMTP_HOST | - | SMTP server for email notifications |
| SMTP_PORT | - | SMTP port |
| SMTP_USER | - | SMTP username |
| SMTP_PASS | - | SMTP password |
| CONTRACTOR_EMAIL | - | Default contractor email for notifications |
| APNS_KEY_ID | - | Apple Push Notification key ID |
| APNS_TEAM_ID | - | Apple Developer Team ID |
| APNS_KEY_PATH | - | Path to APNs .p8 key file |
| APNS_TOPIC | - | App bundle ID for push notifications |

## File Structure

```
estimate-tracking-server/
├── server.js        # Main server file
├── tracking.db      # SQLite database (auto-created)
├── package.json     # Dependencies
├── .env.example     # Environment template
└── README.md        # This file
```

## License

MIT
