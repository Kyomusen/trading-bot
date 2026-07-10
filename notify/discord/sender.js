// notify/discord/sender.js
// หน้าที่เดียว: ยิง HTTP POST ไปที่ Discord webhook
// ห้ามมี logic คำนวณใดๆ ในไฟล์นี้เด็ดขาด — รับ payload ที่พร้อมส่งจาก formatter.js เท่านั้น
// นี่คือจุดที่แก้ปัญหาดีเลย์: ทุกอย่างต้องคำนวณเสร็จก่อนถึงไฟล์นี้

const axios = require('axios');
const FormData = require('form-data');
const config = require('../../config');

async function send(payload, file) {
  if (!config.notify.discord.enabled) return;
  if (!config.notify.discord.webhookUrl) {
    console.warn('[discord] ไม่มี webhookUrl ตั้งค่าไว้ ข้ามการส่ง');
    return;
  }
  try {
    if (file) {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify(payload));
      fd.append('file', file.buffer, { filename: file.name, contentType: file.type });
      await axios.post(config.notify.discord.webhookUrl, fd, { headers: fd.getHeaders() });
    } else {
      await axios.post(config.notify.discord.webhookUrl, payload);
    }
  } catch (err) {
    console.error('[discord] ส่งแจ้งเตือนล้มเหลว:', err.message);
  }
}

module.exports = { send };
