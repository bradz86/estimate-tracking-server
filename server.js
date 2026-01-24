require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// JSON file-based storage
const DB_FILE = path.join(__dirname, 'tracking-data.json');

// Initialize or load database
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading database:', err);
  }
  return { estimates: {}, views: [] };
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving database:', err);
  }
}

let db = loadDB();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline styles for estimate pages
}));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.static('public'));

// Helper to get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.ip;
}

// Helper to record a view
function recordView(trackingId, req) {
  // Ensure estimate exists
  if (!db.estimates[trackingId]) {
    db.estimates[trackingId] = {
      tracking_id: trackingId,
      created_at: new Date().toISOString()
    };
  }

  // Record the view
  const view = {
    id: db.views.length + 1,
    tracking_id: trackingId,
    viewed_at: new Date().toISOString(),
    ip_address: getClientIP(req),
    user_agent: req.headers['user-agent'] || null,
    referer: req.headers['referer'] || null
  };
  db.views.push(view);

  // Save to file
  saveDB(db);
}

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// View estimate page (public link)
app.get('/view/:trackingId', (req, res) => {
  const { trackingId } = req.params;

  // Record the view
  recordView(trackingId, req);

  // Get view count
  const count = db.views.filter(v => v.tracking_id === trackingId).length;

  // Serve the estimate view page
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Estimate Received</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 16px;
          padding: 40px;
          max-width: 500px;
          width: 100%;
          text-align: center;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        .icon {
          width: 80px;
          height: 80px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 24px;
        }
        .icon svg {
          width: 40px;
          height: 40px;
          fill: white;
        }
        h1 {
          color: #1a1a2e;
          font-size: 24px;
          margin-bottom: 12px;
        }
        .subtitle {
          color: #666;
          line-height: 1.6;
          margin-bottom: 24px;
        }
        .info-box {
          background: #f8f9fa;
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 24px;
          text-align: left;
        }
        .info-box h3 {
          color: #333;
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .info-box p {
          color: #666;
          font-size: 14px;
          line-height: 1.5;
          margin: 0;
        }
        .badge {
          display: inline-block;
          background: #e8f5e9;
          color: #2e7d32;
          padding: 10px 20px;
          border-radius: 25px;
          font-size: 15px;
          font-weight: 500;
        }
        .tracking-id {
          margin-top: 20px;
          font-size: 12px;
          color: #999;
        }
        .footer {
          margin-top: 32px;
          padding-top: 24px;
          border-top: 1px solid #eee;
          color: #999;
          font-size: 12px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="white"/>
          </svg>
        </div>
        <h1>Receipt Confirmed!</h1>
        <p class="subtitle">Your contractor has been notified.</p>

        <div class="info-box">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#667eea" stroke-width="2">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
              <polyline points="22,6 12,13 2,6"/>
            </svg>
            Check Your Email
          </h3>
          <p>The full estimate PDF has been sent to your email. You can save, print, or review the complete details there.</p>
        </div>

        <div class="badge">✓ View Confirmed</div>

        <div class="tracking-id">Reference: ${trackingId}</div>

        <div class="footer">
          Powered by EstimatePro
        </div>
      </div>
    </body>
    </html>
  `);
});

// Tracking pixel (1x1 transparent GIF)
app.get('/pixel/:trackingId.gif', (req, res) => {
  const trackingId = req.params.trackingId.replace('.gif', '');

  // Record the view
  recordView(trackingId, req);

  // Send 1x1 transparent GIF
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });

  res.send(pixel);
});

// API: Get view statistics for a tracking ID
app.get('/api/views/:trackingId', (req, res) => {
  const { trackingId } = req.params;

  // Get views for this tracking ID
  const trackingViews = db.views.filter(v => v.tracking_id === trackingId);
  const count = trackingViews.length;

  // Get last view
  const sortedViews = [...trackingViews].sort((a, b) =>
    new Date(b.viewed_at) - new Date(a.viewed_at)
  );
  const lastView = sortedViews[0];

  res.json({
    trackingId,
    viewCount: count,
    lastViewedAt: lastView?.viewed_at || null,
    views: sortedViews.slice(0, 50).map(v => ({
      timestamp: v.viewed_at,
      ipAddress: v.ip_address ? v.ip_address.substring(0, v.ip_address.lastIndexOf('.')) + '.xxx' : null,
      userAgent: v.user_agent,
    }))
  });
});

// API: Register a new tracking ID (optional - auto-created on first view)
app.post('/api/register/:trackingId', (req, res) => {
  const { trackingId } = req.params;

  if (!db.estimates[trackingId]) {
    db.estimates[trackingId] = {
      tracking_id: trackingId,
      created_at: new Date().toISOString()
    };
    saveDB(db);
  }

  res.json({ success: true, trackingId });
});

// API: Get all tracked estimates (for admin/debugging)
app.get('/api/estimates', (req, res) => {
  const estimates = Object.values(db.estimates).map(estimate => {
    const views = db.views.filter(v => v.tracking_id === estimate.tracking_id);
    const sortedViews = [...views].sort((a, b) =>
      new Date(b.viewed_at) - new Date(a.viewed_at)
    );

    return {
      tracking_id: estimate.tracking_id,
      created_at: estimate.created_at,
      view_count: views.length,
      last_viewed_at: sortedViews[0]?.viewed_at || null
    };
  });

  // Sort by created_at descending
  estimates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({ estimates: estimates.slice(0, 100) });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║   EstimatePro Tracking Server                          ║
║   Running on http://localhost:${PORT}                     ║
║                                                        ║
║   Endpoints:                                           ║
║   • GET  /view/:trackingId     - View estimate page    ║
║   • GET  /pixel/:trackingId.gif - Tracking pixel       ║
║   • GET  /api/views/:trackingId - Get view stats       ║
║   • POST /api/register/:trackingId - Register ID       ║
║   • GET  /api/estimates        - List all estimates    ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  saveDB(db);
  process.exit(0);
});
