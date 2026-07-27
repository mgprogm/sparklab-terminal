# Browser Use Tool Setup

เอกสารนี้อธิบายการเปิดใช้งาน Virtual Browser สำหรับ Agent Chat โดย Agent
จะสร้าง Chromium ที่แยกตามแชตเมื่อมีการเรียกใช้ Browser tool ครั้งแรก

## 1. เตรียม Browser Use

ต้องมี Node.js 24+, pnpm 11, `uv` และ Chromium dependencies ก่อน จากนั้นติดตั้ง
Browser Use ใน checkout ที่เชื่อถือได้:

```bash
cd /home/sparklab/workspaces/sparklab/browser-use
uv sync
uvx browser-use install
```

บน Ubuntu คำสั่ง `browser-use install` อาจขอ `sudo` เพื่อติดตั้ง system
dependencies หากไม่มี interactive sudo แต่เครื่องมี Snap Chromium อยู่แล้ว
ให้ใช้ทางเลือกนี้และกำหนด `BROWSER_USE_EXECUTABLE_PATH` ตามหัวข้อถัดไป:

```bash
uvx playwright install chromium --no-shell
command -v chromium
```

ตรวจสอบว่า `uv` พร้อมใช้งาน:

```bash
uv --version
```

Repository นี้ใช้ Browser Use checkout เป็น runtime dependency และจะไม่แก้ไข
source code ภายใน checkout ดังกล่าว

## 2. ตั้งค่า Agent Service

แก้ไฟล์ `apps/agent-service/.env` ซึ่งถูก gitignore และห้าม commit จากนั้นเพิ่ม:

```env
BROWSER_USE_PROJECT=/home/sparklab/workspaces/sparklab/browser-use
BROWSER_USE_HEADLESS=true
BROWSER_USE_EXECUTABLE_PATH=/snap/bin/chromium
BROWSER_HANDOFF_TRANSPORT=jpeg
AGENT_ALLOW_MISSING_ORIGIN=false
MAX_BROWSER_SESSIONS=4
MAX_BROWSER_LAUNCHES=2
MAX_HANDOFF_CONNECTIONS=16
```

- `BROWSER_USE_PROJECT` ต้องเป็น absolute path ของ Browser Use checkout
- `BROWSER_USE_HEADLESS=true` เหมาะสำหรับ production
- ใช้ `BROWSER_USE_HEADLESS=false` เมื่อต้องการเปิดหน้าต่าง Chromium เพื่อ debug
- `BROWSER_USE_EXECUTABLE_PATH` ระบุ Chromium ที่ระบบจัดการและมี sandbox profile
  โดยตรง เหมาะกับ Ubuntu ที่บล็อก sandbox ของ Playwright Chromium ผ่าน AppArmor
- หากไม่กำหนด `BROWSER_USE_PROJECT` ระบบจะไม่เปิด Browser tools ให้ Agent
- ใช้ `BROWSER_HANDOFF_TRANSPORT=jpeg` จนกว่า health จะรายงาน
  `mediaProviderAvailable: true`; ยังไม่ต้องตั้ง STUN/TURN สำหรับ JPEG

## 3. Restart Agent Service

### Production (PM2)

Environment ปัจจุบันใช้ process ชื่อ `prod-agent`:

```bash
pm2 restart prod-agent
pm2 save
```

ตรวจสอบสถานะและ startup log:

```bash
pm2 status prod-agent
pm2 logs prod-agent --lines 50 --nostream
```

ตรวจสอบ health endpoint:

```bash
curl http://127.0.0.1:3109/health
```

ผลต้องมี `"ready": true`, `"configuredTransport": "jpeg"` และ
`"mediaProviderAvailable": false` ใน revision ปัจจุบัน

### Development

```bash
pnpm --filter @sparklab/agent-service dev
```

ค่าเริ่มต้นของ development health endpoint คือ
`http://127.0.0.1:3009/health`

### Docker browser runtime

Docker target แยกติดตั้ง Chromium sandbox, Xvfb, FFmpeg, pinned `uv`,
GStreamer WebRTC/VP8 และ libnice โดยไม่เพิ่มขนาด default image:

```bash
docker compose --env-file .env.docker \
  -f docker-compose.yml -f deploy/docker/compose.browser.yml \
  up -d --build
```

กำหนด `BROWSER_USE_PROJECT_HOST` เป็น absolute path ของ trusted/pinned
checkout ตัวเดิม Source จะถูก mount แบบ read-only ส่วน virtual environment
และ cache อยู่ใน `/data` ดู hardening และข้อจำกัด seccomp เพิ่มเติมใน
[`DOCKER.md`](./DOCKER.md)

## 4. ทดสอบผ่าน Agent Chat

เปิดหน้า Terminal และ Agent Chat แล้วส่งคำสั่ง เช่น:

```text
เปิด https://example.com และสรุปเนื้อหาของหน้าเว็บ
```

ลำดับที่ควรเกิด:

1. Agent เรียก `browser_observe` เพื่อเริ่ม Browser Runtime และสำรวจหน้าเว็บ
2. Agent ส่งคำขออนุมัติ `browser_act` สำหรับการ navigate
3. ผู้ใช้กด Allow
4. Chromium เปิดเว็บไซต์และส่ง snapshot กลับมายัง UI
5. Agent สำรวจหน้าเว็บอีกครั้งและสรุปผล

การกระทำที่เปลี่ยนสถานะ เช่น navigate, click, type, scroll และจัดการ tab
ต้องได้รับอนุมัติใหม่ทุกครั้ง ระบบไม่รองรับ `allow_always` สำหรับ Browser actions

## 5. Troubleshooting

ตรวจสอบ path และ executable:

```bash
test -d /home/sparklab/workspaces/sparklab/browser-use && echo "browser-use: OK"
command -v uv
pm2 logs prod-agent --lines 100 --nostream
```

หาก Chromium เริ่มทำงานไม่ได้ ให้ติดตั้งใหม่จาก Browser Use checkout:

```bash
cd /home/sparklab/workspaces/sparklab/browser-use
uvx browser-use install
```

หากพบ `No usable sandbox` บน Ubuntu ห้ามแก้ด้วย `--no-sandbox` ใน production
ให้ใช้ Chromium ที่มี AppArmor profile ของระบบแทน:

```env
BROWSER_USE_EXECUTABLE_PATH=/snap/bin/chromium
```

หาก Browser tools ไม่ปรากฏ ให้ตรวจว่า `BROWSER_USE_PROJECT` อยู่ใน
`apps/agent-service/.env` และ restart `prod-agent` หลังแก้ไขทุกครั้ง

หาก canvas แสดงภาพแต่ mouse ใช้งานไม่ได้ ให้ตรวจ bundle version, สถานะ
`Connected`, virtual coordinates, ACK และ frame freshness ตามลำดับใน
[`BROWSER-HANDOFF-OPERATIONS.md`](./BROWSER-HANDOFF-OPERATIONS.md) ระหว่าง
handoff ทั้ง canvas bitmap และ CDP viewport ต้องเป็น 1280×720

## ข้อจำกัดด้านความปลอดภัย

- เปิดได้เฉพาะ public HTTP/HTTPS URL
- บล็อก loopback, private, link-local, reserved และ metadata addresses
- Agent ห้ามกรอกรหัสผ่าน, API key, OTP, payment data หรือข้อมูลลับ; ผู้ใช้
  กรอก password/MFA ได้เฉพาะใน human handoff ที่ active และต้องกด Done/Cancel
- ไม่เปิด raw MCP, CDP, JavaScript execution, filesystem, upload หรือ download
- Screenshot และ browser state เป็นข้อมูลชั่วคราวและไม่บันทึกใน chat history
- Browser process, profile และ snapshot จะถูกปิดเมื่อกด Stop, disconnect หรือ
  Agent Service หยุดทำงาน

ดูรายละเอียดสถาปัตยกรรมและข้อกำหนดเพิ่มเติมได้ที่
[`VIRTUAL-BROWSER.md`](./VIRTUAL-BROWSER.md) และ
[`AGENT-PROTOCOL.md`](./AGENT-PROTOCOL.md)
