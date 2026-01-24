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

### Public Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/view/:trackingId` | Customer-facing estimate view page |
| GET | `/pixel/:trackingId.gif` | 1x1 tracking pixel for emails |

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/views/:trackingId` | Get view statistics |
| POST | `/api/register/:trackingId` | Pre-register a tracking ID |
| GET | `/api/estimates` | List all tracked estimates |
| GET | `/health` | Health check |

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

## Production Considerations

1. **Database**: For production, consider PostgreSQL or MongoDB
2. **Rate Limiting**: Add rate limiting for API endpoints
3. **Authentication**: Add API key authentication for sensitive endpoints
4. **HTTPS**: Always use HTTPS in production
5. **Monitoring**: Add error tracking (Sentry) and monitoring

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |

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
