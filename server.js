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

// JSON file-based storage.
//
// DB_PATH must point at a mounted persistent disk in production. The default
// lives inside the deploy directory, which on Render's free tier is ephemeral —
// every restart and redeploy wipes it, taking device tokens, contractor
// registrations and view history with it.
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'tracking-data.json');

if (process.env.NODE_ENV === 'production' && !process.env.DB_PATH) {
  console.warn(
    '⚠ DB_PATH is not set. Storage is ephemeral and WILL be lost on restart.\n' +
    '  Attach a persistent disk and set DB_PATH=/var/data/tracking-data.json'
  );
}

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
    contractors: {},
    nextViewId: 1
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
if (!db.estimates) db.estimates = {};
if (!db.views) db.views = [];
if (!db.devices) db.devices = [];
if (!db.notifications) db.notifications = [];
if (!db.contractors) db.contractors = {};

// Migrate legacy single-tenant shape. Records from before multi-tenancy have no
// owner, so they are parked under a reserved id that no client can present and
// are therefore invisible to every contractor.
const LEGACY_OWNER = '__legacy__';
if (db.contractor) {
  db.contractors[LEGACY_OWNER] = db.contractor;
  delete db.contractor;
}
for (const estimate of Object.values(db.estimates)) {
  if (!estimate.contractor_id) estimate.contractor_id = LEGACY_OWNER;
}
for (const device of db.devices) {
  if (!device.contractorId) device.contractorId = LEGACY_OWNER;
}
for (const notification of db.notifications) {
  if (!notification.contractorId) notification.contractorId = LEGACY_OWNER;
}
if (typeof db.nextViewId !== 'number') {
  db.nextViewId = db.views.reduce((max, v) => Math.max(max, v.id || 0), 0) + 1;
}

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

// Contractor scoping.
//
// The API key is shared by every install (it ships inside the app bundle), so it
// only proves "this is the app" — never "this is a particular user". Every /api
// route that touches stored data must additionally scope by contractor id, which
// each install generates locally and sends on every request.
const CONTRACTOR_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

const resolveContractor = (req, res, next) => {
  const raw = req.headers['x-contractor-id'] || req.body?.contractorId;
  if (!raw || !CONTRACTOR_ID_PATTERN.test(raw)) {
    return res.status(400).json({ error: 'Missing or malformed contractor id' });
  }
  if (raw === LEGACY_OWNER) {
    return res.status(400).json({ error: 'Reserved contractor id' });
  }
  req.contractorId = raw;
  next();
};

// Applies to every /api route except the QuickBooks OAuth proxy, which brokers a
// token exchange and stores nothing.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/quickbooks/')) return next();
  return resolveContractor(req, res, next);
});

// Disable caching on all API responses (Intuit security requirement)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Disable TRACE and TRACK HTTP methods (Intuit security requirement)
app.use((req, res, next) => {
  if (req.method === 'TRACE' || req.method === 'TRACK') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  next();
});

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
  if (!apnProvider) return;

  // Only the contractor who registered this estimate may be told about it.
  const ownerId = estimate.contractor_id;
  if (!ownerId) return;

  const ownerDevices = db.devices.filter(d => d.contractorId === ownerId);
  if (ownerDevices.length === 0) return;

  const apn = require('@parse/node-apn');
  const notification = new apn.Notification();

  notification.alert = {
    title: 'Estimate Viewed!',
    body: `${estimate.customerName || 'A customer'} viewed "${estimate.title || 'your estimate'}"`
  };
  notification.badge = db.notifications.filter(n => n.contractorId === ownerId && !n.isRead).length + 1;
  notification.sound = 'default';
  notification.topic = process.env.APP_BUNDLE_ID || 'com.estimatepro.app';
  notification.payload = {
    trackingId: trackingId,
    estimateTitle: estimate.title,
    customerName: estimate.customerName
  };

  for (const device of ownerDevices) {
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
  const owner = estimate.contractor_id ? db.contractors[estimate.contractor_id] : null;
  if (!emailTransporter || !owner?.email) return;

  const mailOptions = {
    from: process.env.SMTP_FROM || 'EstimatePro <notifications@estimatepro.app>',
    to: owner.email,
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
  const ownerId = estimate.contractor_id;
  if (!ownerId) return null;

  const notification = {
    id: `notif_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    contractorId: ownerId,
    trackingId: trackingId,
    estimateTitle: estimate.title || 'Untitled Estimate',
    customerName: estimate.customerName || null,
    message: 'Your estimate was viewed',
    viewedAt: new Date().toISOString(),
    isRead: false
  };

  db.notifications.unshift(notification);

  // Keep the last 100 notifications per contractor, so a busy account cannot
  // evict a quiet one's history.
  const seen = new Map();
  db.notifications = db.notifications.filter(n => {
    const count = (seen.get(n.contractorId) || 0) + 1;
    seen.set(n.contractorId, count);
    return count <= 100;
  });

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

  // Record the view. Ids come from a monotonic counter — deriving them from
  // array length collides once MAX_VIEWS starts trimming from the front.
  const view = {
    id: db.nextViewId++,
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
    email: emailTransporter ? 'configured' : 'not configured',
    appleRevocation: appleRevocationConfigured() ? 'configured' : 'not configured',
    // Booleans only — never the path. Lets a deploy be checked for the two
    // settings whose absence is silent but destructive: without persistent
    // storage every restart drops all data, and without Apple revocation
    // account deletion cannot revoke the Sign in with Apple grant.
    persistentStorage: Boolean(process.env.DB_PATH)
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

  // Remove existing entry for this token. A token belongs to exactly one
  // install, so re-registering it also reassigns ownership.
  db.devices = db.devices.filter(d => d.token !== deviceToken);

  // Add new entry
  db.devices.push({
    token: deviceToken,
    contractorId: req.contractorId,
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

  db.contractors[req.contractorId] = {
    email,
    name: name || null,
    companyName: companyName || null,
    registeredAt: new Date().toISOString()
  };

  await saveDB();
  res.json({ success: true, message: 'Contractor registered for email notifications' });
});

// ============================================
// QUICKBOOKS OAUTH PROXY
// ============================================

// Intuit discovery document for dynamic endpoint resolution
const QB_DISCOVERY_URL = 'https://developer.api.intuit.com/.well-known/openid_configuration';
let qbTokenUrl = null;

async function getQBTokenUrl() {
  if (qbTokenUrl) return qbTokenUrl;
  try {
    const response = await fetch(QB_DISCOVERY_URL, { headers: { 'Accept': 'application/json' } });
    const discovery = await response.json();
    qbTokenUrl = discovery.token_endpoint;
    console.log('✓ QuickBooks token endpoint resolved from discovery document');
    return qbTokenUrl;
  } catch (err) {
    console.error('Failed to fetch QB discovery document, using fallback:', err.message);
    return 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  }
}

// Exchange authorization code for tokens
app.post('/api/quickbooks/token-exchange', async (req, res) => {
  const { code, redirect_uri } = req.body;

  if (!code || !redirect_uri) {
    return res.status(400).json({ error: 'code and redirect_uri are required' });
  }

  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'QuickBooks credentials not configured on server' });
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirect_uri
    });

    const tokenUrl = await getQBTokenUrl();
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Accept': 'application/json'
      },
      body: params.toString()
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('QB token exchange failed: status', response.status);
      return res.status(response.status).json({ error: 'Token exchange failed' });
    }

    res.json(data);
  } catch (err) {
    console.error('QB token exchange error:', err);
    res.status(500).json({ error: 'Token exchange request failed' });
  }
});

// Refresh access token
app.post('/api/quickbooks/token-refresh', async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'refresh_token is required' });
  }

  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'QuickBooks credentials not configured on server' });
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh_token
    });

    const tokenUrl = await getQBTokenUrl();
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Accept': 'application/json'
      },
      body: params.toString()
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('QB token refresh failed: status', response.status);
      return res.status(response.status).json({ error: 'Token refresh failed' });
    }

    res.json(data);
  } catch (err) {
    console.error('QB token refresh error:', err);
    res.status(500).json({ error: 'Token refresh request failed' });
  }
});

// ============================================
// SIGN IN WITH APPLE — TOKEN REVOCATION
// ============================================
//
// Guideline 5.1.1(v) requires that deleting an account also revokes the Sign in
// with Apple grant. Revocation must be authenticated with a client secret: an
// ES256 JWT signed with a Sign in with Apple private key. That key can never
// ship inside the app, so the client cannot do this itself — it previously
// called Apple's revoke endpoint directly with no client credentials at all,
// which always failed silently.
//
// Configure with APPLE_KEY_ID, APPLE_KEY_BASE64 (base64 of the .p8),
// APPLE_TEAM_ID and APPLE_CLIENT_ID. Unconfigured, these routes report 501 and
// the app falls back to deleting local data only.

const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || process.env.APP_BUNDLE_ID;
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || process.env.APNS_TEAM_ID;
const APPLE_KEY_ID = process.env.APPLE_KEY_ID;

function appleSigningKey() {
  if (process.env.APPLE_KEY_BASE64) {
    return Buffer.from(process.env.APPLE_KEY_BASE64, 'base64').toString('utf8');
  }
  const keyPath = path.join(__dirname, 'apple-signin-key.p8');
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf8');
  return null;
}

function appleRevocationConfigured() {
  return Boolean(APPLE_CLIENT_ID && APPLE_TEAM_ID && APPLE_KEY_ID && appleSigningKey());
}

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/// Builds the ES256 client secret Apple requires on /auth/token and /auth/revoke.
function appleClientSecret() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: APPLE_KEY_ID };
  const payload = {
    iss: APPLE_TEAM_ID,
    iat: now,
    exp: now + 3600,
    aud: 'https://appleid.apple.com',
    sub: APPLE_CLIENT_ID
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  // 'ieee-p1363' produces the raw r||s form JOSE expects. The default DER
  // encoding is rejected by Apple.
  const signature = crypto.sign(null, Buffer.from(signingInput), {
    key: appleSigningKey(),
    dsaEncoding: 'ieee-p1363'
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

async function applePost(endpoint, params) {
  const response = await fetch(`https://appleid.apple.com/auth/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

// Exchange the authorization code captured at sign-in for a refresh token, and
// keep it so the account can be revoked later without a second sign-in prompt.
app.post('/api/apple/link', async (req, res) => {
  if (!appleRevocationConfigured()) {
    return res.status(501).json({ error: 'Apple revocation not configured' });
  }

  const { authorizationCode } = req.body;
  if (!authorizationCode) {
    return res.status(400).json({ error: 'authorizationCode required' });
  }

  try {
    const result = await applePost('token', {
      client_id: APPLE_CLIENT_ID,
      client_secret: appleClientSecret(),
      code: authorizationCode,
      grant_type: 'authorization_code'
    });

    if (!result.ok) {
      console.error('Apple code exchange failed:', result.status, result.text);
      return res.status(502).json({ error: 'Apple rejected the authorization code' });
    }

    const { refresh_token: refreshToken } = JSON.parse(result.text);
    if (!refreshToken) {
      return res.status(502).json({ error: 'Apple returned no refresh token' });
    }

    const contractor = db.contractors[req.contractorId] || {};
    contractor.appleRefreshToken = refreshToken;
    db.contractors[req.contractorId] = contractor;
    await saveDB();

    res.json({ success: true });
  } catch (err) {
    console.error('Apple link error:', err.message);
    res.status(500).json({ error: 'Could not link Apple account' });
  }
});

// Revoke the grant and forget everything stored for this contractor.
app.post('/api/apple/revoke', async (req, res) => {
  if (!appleRevocationConfigured()) {
    return res.status(501).json({ error: 'Apple revocation not configured' });
  }

  const contractor = db.contractors[req.contractorId];
  const refreshToken = contractor?.appleRefreshToken;

  if (refreshToken) {
    try {
      const result = await applePost('revoke', {
        client_id: APPLE_CLIENT_ID,
        client_secret: appleClientSecret(),
        token: refreshToken,
        token_type_hint: 'refresh_token'
      });

      if (!result.ok) {
        console.error('Apple revoke failed:', result.status, result.text);
        return res.status(502).json({ error: 'Apple rejected the revocation' });
      }
    } catch (err) {
      console.error('Apple revoke error:', err.message);
      return res.status(500).json({ error: 'Could not reach Apple' });
    }
  }

  // Deletion is unconditional once revocation has succeeded (or there was
  // nothing to revoke), so an account never survives a delete request.
  purgeContractor(req.contractorId);
  await saveDB();

  res.json({ success: true, revoked: Boolean(refreshToken) });
});

/// Removes every record belonging to a contractor.
function purgeContractor(contractorId) {
  delete db.contractors[contractorId];
  db.devices = db.devices.filter(d => d.contractorId !== contractorId);
  db.notifications = db.notifications.filter(n => n.contractorId !== contractorId);

  const owned = Object.values(db.estimates).filter(e => e.contractor_id === contractorId);
  const ownedIds = new Set(owned.map(e => e.tracking_id));
  for (const id of ownedIds) delete db.estimates[id];
  db.views = db.views.filter(v => !ownedIds.has(v.tracking_id));
}

// Account deletion for contractors who never linked Apple — still must erase
// everything the server holds about them.
app.post('/api/account/delete', async (req, res) => {
  purgeContractor(req.contractorId);
  await saveDB();
  res.json({ success: true });
});

// ============================================
// ESTIMATE REGISTRATION
// ============================================

// Register estimate with metadata (for better notifications)
app.post('/api/register/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const { title, customerName, customerEmail, total } = req.body;

  // Tracking ids are unguessable, but a second contractor must still not be able
  // to overwrite metadata for an id someone else already claimed.
  const existing = db.estimates[trackingId];
  if (existing?.contractor_id && existing.contractor_id !== req.contractorId) {
    return res.status(409).json({ error: 'Tracking id already registered' });
  }

  db.estimates[trackingId] = {
    tracking_id: trackingId,
    contractor_id: req.contractorId,
    title: title || null,
    customerName: customerName || null,
    customerEmail: customerEmail || null,
    total: total || null,
    created_at: existing?.created_at || new Date().toISOString()
  };

  await saveDB();
  res.json({ success: true, trackingId });
});

// ============================================
// NOTIFICATIONS API
// ============================================

// Get notifications for the calling contractor.
// Accepts POST as well as GET: the client sends its device token in a body so it
// stays out of access logs, and a GET with a body is not reliably deliverable.
const listNotifications = (req, res) => {
  res.json(db.notifications.filter(n => n.contractorId === req.contractorId));
};
app.get('/api/notifications', listNotifications);
app.post('/api/notifications', listNotifications);

// Mark notification as read
app.post('/api/notifications/:notificationId/read', async (req, res) => {
  const { notificationId } = req.params;
  const notification = db.notifications.find(
    n => n.id === notificationId && n.contractorId === req.contractorId
  );

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
  db.notifications
    .filter(n => n.contractorId === req.contractorId)
    .forEach(n => n.isRead = true);
  await saveDB();
  res.json({ success: true });
});

// ============================================
// VIEW STATISTICS
// ============================================

app.get('/api/views/:trackingId', (req, res) => {
  const { trackingId } = req.params;

  const estimate = db.estimates[trackingId];
  if (!estimate || estimate.contractor_id !== req.contractorId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const trackingViews = db.views.filter(v => v.tracking_id === trackingId);
  const sortedViews = [...trackingViews].sort((a, b) => new Date(b.viewed_at) - new Date(a.viewed_at));

  res.json({
    trackingId,
    viewCount: trackingViews.length,
    lastViewedAt: sortedViews[0]?.viewed_at || null,
    views: sortedViews.slice(0, 50).map(v => ({
      timestamp: v.viewed_at,
      ipHash: crypto.createHash('sha256').update(v.ip_address || '').digest('hex').substring(0, 8),
      userAgent: v.user_agent,
    }))
  });
});

app.get('/api/estimates', (req, res) => {
  const owned = Object.values(db.estimates)
    .filter(e => e.contractor_id === req.contractorId);

  const estimates = owned.map(estimate => {
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
