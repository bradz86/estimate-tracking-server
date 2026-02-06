require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
  return {
    estimates: {},
    views: [],
    devices: [],
    notifications: [],
    contractor: null
  };
}

let writeInProgress = false;
let writePending = false;

async function saveDB() {
  if (writeInProgress) {
    writePending = true;
    return;
  }
  writeInProgress = true;
  try {
    await fs.promises.writeFile(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('Failed to save database:', err.message);
  }
  writeInProgress = false;
  if (writePending) {
    writePending = false;
    await saveDB();
  }
}

let db = loadDB();

// Ensure db has all required fields
if (!db.devices) db.devices = [];
if (!db.notifications) db.notifications = [];
if (!db.contractor) db.contractor = null;

// ============================================
// APNs Setup (Apple Push Notifications)
// ============================================

let apnProvider = null;

function setupAPNs() {
  const keyPath = path.join(__dirname, 'apns-key.p8');

  // Check for required env vars
  if (!process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
    console.log('⚠ APNs not configured (missing APNS_KEY_ID or APNS_TEAM_ID)');
    return;
  }

  // Get key from base64 env var OR file
  let keyContent = null;

  if (process.env.APNS_KEY_BASE64) {
    // Decode from base64 environment variable
    try {
      keyContent = Buffer.from(process.env.APNS_KEY_BASE64, 'base64').toString('utf8');
      console.log('✓ APNs key loaded from APNS_KEY_BASE64');
    } catch (err) {
      console.log('⚠ Failed to decode APNS_KEY_BASE64:', err.message);
      return;
    }
  } else if (fs.existsSync(keyPath)) {
    // Load from file
    keyContent = fs.readFileSync(keyPath, 'utf8');
    console.log('✓ APNs key loaded from file');
  } else {
    console.log('⚠ APNs not configured (no key file or APNS_KEY_BASE64)');
    return;
  }

  try {
    const apn = require('@parse/node-apn');
    apnProvider = new apn.Provider({
      token: {
        key: keyContent,
        keyId: process.env.APNS_KEY_ID,
        teamId: process.env.APNS_TEAM_ID
      },
      production: process.env.NODE_ENV === 'production'
    });
    console.log('✓ APNs configured');
  } catch (err) {
    console.log('⚠ APNs not configured:', err.message);
  }
}

setupAPNs();

// ============================================
// Email Setup
// ============================================

let emailTransporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  console.log('✓ Email configured');
} else {
  console.log('⚠ Email not configured (missing SMTP env vars)');
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many requests' } });
const viewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: { error: 'Too many requests' } });
app.use('/api/', apiLimiter);
app.use('/view/', viewLimiter);
app.use('/pixel/', viewLimiter);

// API Authentication middleware
const authenticateAPI = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== process.env.API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
};
app.use('/api', authenticateAPI);

// Helper to get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.ip;
}

// ============================================
// NOTIFICATION FUNCTIONS
// ============================================

async function sendPushNotification(trackingId, estimate) {
  if (!apnProvider || db.devices.length === 0) return;

  const apn = require('@parse/node-apn');
  const notification = new apn.Notification();

  notification.alert = {
    title: 'Estimate Viewed!',
    body: `${estimate.customerName || 'A customer'} viewed "${estimate.title || 'your estimate'}"`
  };
  notification.badge = db.notifications.filter(n => !n.isRead).length + 1;
  notification.sound = 'default';
  notification.topic = process.env.APP_BUNDLE_ID || 'com.estimatepro.app';
  notification.payload = {
    trackingId: trackingId,
    estimateTitle: estimate.title,
    customerName: estimate.customerName
  };

  for (const device of db.devices) {
    try {
      const result = await apnProvider.send(notification, device.token);
      if (result.failed.length > 0) {
        console.log('Push failed:', result.failed[0].response);
      } else {
        console.log('Push sent successfully');
      }
    } catch (err) {
      console.error('Push error:', err);
    }
  }
}

async function sendEmailNotification(trackingId, estimate, viewInfo) {
  if (!emailTransporter || !db.contractor?.email) return;

  const mailOptions = {
    from: process.env.SMTP_FROM || 'EstimatePro <notifications@estimatepro.app>',
    to: db.contractor.email,
    subject: `Estimate Viewed: ${estimate.title || trackingId}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: -apple-system, Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 500px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px 12px 0 0; text-align: center; }
          .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 12px 12px; }
          .detail { margin: 12px 0; }
          .label { color: #666; font-size: 12px; text-transform: uppercase; }
          .value { font-size: 16px; font-weight: 500; }
          .footer { text-align: center; margin-top: 20px; color: #999; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin:0;">Estimate Viewed!</h2>
          </div>
          <div class="content">
            <div class="detail">
              <div class="label">Estimate</div>
              <div class="value">${escapeHtml(estimate.title) || 'Untitled'}</div>
            </div>
            ${estimate.customerName ? `
            <div class="detail">
              <div class="label">Customer</div>
              <div class="value">${escapeHtml(estimate.customerName)}</div>
            </div>
            ` : ''}
            <div class="detail">
              <div class="label">Viewed At</div>
              <div class="value">${new Date().toLocaleString()}</div>
            </div>
            <div class="detail">
              <div class="label">Reference</div>
              <div class="value">${escapeHtml(trackingId)}</div>
            </div>
          </div>
          <div class="footer">
            Powered by EstimatePro
          </div>
        </div>
      </body>
      </html>
    `
  };

  try {
    await emailTransporter.sendMail(mailOptions);
    console.log('Email notification sent');
  } catch (err) {
    console.error('Email error:', err);
  }
}

async function storeInAppNotification(trackingId, estimate) {
  const notification = {
    id: `notif_${Date.now()}`,
    trackingId: trackingId,
    estimateTitle: estimate.title || 'Untitled Estimate',
    customerName: estimate.customerName || null,
    message: 'Your estimate was viewed',
    viewedAt: new Date().toISOString(),
    isRead: false
  };

  db.notifications.unshift(notification);

  // Keep only last 100 notifications
  if (db.notifications.length > 100) {
    db.notifications = db.notifications.slice(0, 100);
  }

  await saveDB();
  return notification;
}

// Helper to record a view and send notifications
async function recordView(trackingId, req) {
  // Ensure estimate exists
  if (!db.estimates[trackingId]) {
    db.estimates[trackingId] = {
      tracking_id: trackingId,
      created_at: new Date().toISOString()
    };
  }

  const estimate = db.estimates[trackingId];
  const isFirstView = !db.views.some(v => v.tracking_id === trackingId);

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

  // Cap views array to prevent unbounded growth
  const MAX_VIEWS = 10000;
  if (db.views.length > MAX_VIEWS) {
    db.views = db.views.slice(-MAX_VIEWS);
  }

  await saveDB();

  // Send notifications (only on first view to avoid spam)
  if (isFirstView) {
    await storeInAppNotification(trackingId, estimate);
    await sendPushNotification(trackingId, estimate);
    await sendEmailNotification(trackingId, estimate, view);
  }
}

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    push: apnProvider ? 'configured' : 'not configured',
    email: emailTransporter ? 'configured' : 'not configured'
  });
});

// View estimate page (public link)
app.get('/view/:trackingId', async (req, res) => {
  const { trackingId } = req.params;

  // Record the view
  await recordView(trackingId, req);

  const estimate = db.estimates[trackingId] || {};

  // Serve a nice confirmation page
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Estimate - ${escapeHtml(estimate.title) || 'View'}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
        h1 { color: #1a1a2e; font-size: 24px; margin-bottom: 12px; }
        .subtitle { color: #666; line-height: 1.6; margin-bottom: 24px; }
        .info-box {
          background: #f8f9fa;
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 24px;
          text-align: left;
        }
        .info-box h3 { color: #333; font-size: 14px; font-weight: 600; margin-bottom: 12px; }
        .info-box p { color: #666; font-size: 14px; line-height: 1.5; margin: 0; }
        .badge {
          display: inline-block;
          background: #e8f5e9;
          color: #2e7d32;
          padding: 10px 20px;
          border-radius: 25px;
          font-size: 15px;
          font-weight: 500;
        }
        .footer { margin-top: 32px; padding-top: 24px; border-top: 1px solid #eee; color: #999; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="white">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
        </div>
        <h1>Receipt Confirmed!</h1>
        <p class="subtitle">Your contractor has been notified.</p>
        <div class="info-box">
          <h3>Check Your Email</h3>
          <p>The full estimate PDF has been sent to your email. You can save, print, or review the complete details there.</p>
        </div>
        <div class="badge">✓ View Confirmed</div>
        <div class="footer">Powered by EstimatePro</div>
      </div>
    </body>
    </html>
  `);
});

// Tracking pixel
app.get('/pixel/:trackingId.gif', async (req, res) => {
  const trackingId = req.params.trackingId;
  await recordView(trackingId, req);

  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.send(pixel);
});

// ============================================
// DEVICE & CONTRACTOR REGISTRATION
// ============================================

// Register device for push notifications
app.post('/api/device/register', async (req, res) => {
  const { deviceToken, platform, bundleId } = req.body;

  if (!deviceToken) {
    return res.status(400).json({ error: 'deviceToken required' });
  }

  // Remove existing entry for this token
  db.devices = db.devices.filter(d => d.token !== deviceToken);

  // Add new entry
  db.devices.push({
    token: deviceToken,
    platform: platform || 'ios',
    bundleId: bundleId,
    registeredAt: new Date().toISOString()
  });

  await saveDB();
  res.json({ success: true, message: 'Device registered for push notifications' });
});

// Register contractor info (email for notifications)
app.post('/api/contractor/register', async (req, res) => {
  const { email, name, companyName } = req.body;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }

  db.contractor = {
    email,
    name: name || null,
    companyName: companyName || null,
    registeredAt: new Date().toISOString()
  };

  await saveDB();
  res.json({ success: true, message: 'Contractor registered for email notifications' });
});

// ============================================
// ESTIMATE REGISTRATION
// ============================================

// Register estimate with metadata (for better notifications)
app.post('/api/register/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const { title, customerName, customerEmail, total } = req.body;

  db.estimates[trackingId] = {
    tracking_id: trackingId,
    title: title || null,
    customerName: customerName || null,
    customerEmail: customerEmail || null,
    total: total || null,
    created_at: new Date().toISOString()
  };

  await saveDB();
  res.json({ success: true, trackingId });
});

// ============================================
// NOTIFICATIONS API
// ============================================

// Get notifications for contractor
app.get('/api/notifications', (req, res) => {
  res.json(db.notifications || []);
});

// Mark notification as read
app.post('/api/notifications/:notificationId/read', async (req, res) => {
  const { notificationId } = req.params;
  const notification = db.notifications.find(n => n.id === notificationId);

  if (notification) {
    notification.isRead = true;
    await saveDB();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Notification not found' });
  }
});

// Mark all as read
app.post('/api/notifications/read-all', async (req, res) => {
  db.notifications.forEach(n => n.isRead = true);
  await saveDB();
  res.json({ success: true });
});

// ============================================
// VIEW STATISTICS
// ============================================

app.get('/api/views/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  const trackingViews = db.views.filter(v => v.tracking_id === trackingId);
  const sortedViews = [...trackingViews].sort((a, b) => new Date(b.viewed_at) - new Date(a.viewed_at));

  res.json({
    trackingId,
    viewCount: trackingViews.length,
    lastViewedAt: sortedViews[0]?.viewed_at || null,
    views: sortedViews.slice(0, 50).map(v => ({
      timestamp: v.viewed_at,
      ip_hash: crypto.createHash('sha256').update(v.ip_address || '').digest('hex').substring(0, 8),
      userAgent: v.user_agent,
    }))
  });
});

app.get('/api/estimates', (req, res) => {
  const estimates = Object.values(db.estimates).map(estimate => {
    const views = db.views.filter(v => v.tracking_id === estimate.tracking_id);
    const sortedViews = [...views].sort((a, b) => new Date(b.viewed_at) - new Date(a.viewed_at));
    return {
      ...estimate,
      view_count: views.length,
      last_viewed_at: sortedViews[0]?.viewed_at || null
    };
  });
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
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   EstimatePro Tracking Server                              ║
║   Running on http://localhost:${PORT}                         ║
║                                                            ║
║   Features:                                                ║
║   • View tracking with notifications                       ║
║   • Push notifications: ${apnProvider ? 'ON' : 'OFF'}                              ║
║   • Email notifications: ${emailTransporter ? 'ON' : 'OFF'}                             ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (apnProvider) apnProvider.shutdown();
  await saveDB();
  process.exit(0);
});
