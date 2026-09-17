# Browser CLI Control + Session Profiles — Plan

## Status

ยังไม่ implement — เอกสารออกแบบ/decision record. ต่อยอดจาก
[`VIRTUAL-BROWSER.md`](./VIRTUAL-BROWSER.md) / [`VIRTUAL-BROWSER-PLAN.md`](./VIRTUAL-BROWSER-PLAN.md)
(browser tool v1) และ [`BROWSER-HANDOFF-DESIGN.md`](./BROWSER-HANDOFF-DESIGN.md) (handoff).

### Revision r1 — Codex design review (2026-09-03)

รีวิวโดย Codex (session `01a0658c-fac9-7a41-a707-05bae9a2e2eb`) พบ 5 blocking +
7 should-fix ปรับตามทั้งหมด: แยก control/data plane ตาม auth, ตัด `capture` ออกจาก
CLI surface, CLI ริเริ่ม handoff ไม่ได้, profile lock + fencing + boot sweep,
`GET /manage/sessions` (cookie-only) เห็นทุก owner, เพิ่ม D6–D9

### Revision r2 — แบ่ง 2 เฟส + ปิด TBD (2026-09-03)

- **แบ่งเป็น 2 เฟส** (ดู [Phasing](#phasing)): เฟส 1 = persistent profile +
  Browser Manager UI ใช้ผ่าน **cookie ทั้งหมด** (ไม่มี bearer) + chat agent
  เลือกโปรไฟล์ได้; เฟส 2 = เพิ่ม bearer / data plane / MCP / CLI-owned session
- persistent profile สำหรับ **chat agent** เลื่อนขึ้นมาเป็น **core ของเฟส 1**
  (เดิมอยู่ v2)
- `owner.kind` เพิ่มค่า `"manager"` — session ที่เปิดจาก Browser Manager UI
  ตรง ๆ (cookie-authed) สำหรับ sign-in / ตรวจดู
- ปิด TBD ทั้งหมด — ดู [สรุป TBD ที่ปิดแล้ว](#สรุป-tbd-ที่ปิดแล้ว-2026-09-03)

## Goal

สองอย่างที่เป็น **หนึ่งดีไซน์เดียวกัน** (แยกไม่ได้ในระดับ decision — แต่ ship
แยกเฟสได้):

1. **Session profiles** — browser ที่มี **โปรไฟล์ที่คงอยู่ถาวร** (persistent
   `--user-data-dir`): cookie / localStorage / login state อยู่ข้ามการปิด
   session, ข้าม agent-service restart ใช้ได้ทั้ง chat agent และ (เฟส 2) CLI
2. **External CLI control** — ให้ MCP-capable CLI (Claude Code, Codex, …) เปิด/สั่ง
   isolated browser ของระบบนี้ได้จากที่ไหนก็ตามที่ gateway/proxy เข้าถึงได้ —
   pattern เดียวกับ `tools/notes-mcp/`

ทำไมมาคู่กัน: CLI จะมีประโยชน์ก็ต่อเมื่อ session ที่มัน attach **login ไว้แล้ว** —
persistent profile นั่นเองที่ทำให้เกิดปัญหา concurrency ที่ต้องออกแบบให้ครบ

Session identity model เดียวที่ใช้ทั้งดีไซน์:

```
BrowserSession = {
  sessionId,                 // "bs_<uuid>" — ออกโดย agent-service
  profileId,                 // "prof_<rand>" หรือ null (= ephemeral)
  owner: {
    kind: "chat" | "manager" | "cli",   // "cli" มีเฉพาะเฟส 2
    principal,               // ชื่อ user (จาก cookie) หรือ "cli"
    initiatedBy,             // "chat:<chatId>" | "manager:<user>" | "cli"
  },
  ephemeral: boolean,
  alive: boolean,
}
```

`owner` เป็น **immutable** ตั้งแต่สร้าง และถูกบันทึกในทุก audit record (D9)

---

## Phasing

### เฟส 1 — Persistent profiles + Browser Manager (cookie-only, ไม่มี bearer)

ครึ่งที่ความเสี่ยงต่ำกว่า: ทุกอย่าง auth ด้วย cookie ของแอป ไม่มี token ใหม่ ไม่มี
external surface ทำให้ machinery ที่ยากที่สุด (profile lock/fencing, persistent
`--user-data-dir`, boot orphan-sweep, single dispose path, Manager-initiated
handoff) **พิสูจน์ผ่าน UI ก่อน** แล้วเฟส 2 ค่อยเปิดทางเข้าที่สอง

รวม:

- `browser-profiles.ts` store + lock CAS + `lockEpoch` fencing (D4/D7)
- `browser-session-manager.ts` + `disposeSession()` (D9) + boot `recover()`
- `browser-session-host.ts` — `profileDir?` + dispose asymmetry (D5)
- **chat agent เลือก persistent profile ได้** — tool `browser_use_profile
{profile_id}` (chat-only, one-time approved) หรือ chat setting; ไม่ระบุ =
  ephemeral เหมือน v1
- Browser Manager dialog — แท็บ **Profiles** + **Sessions** เต็มรูปแบบ; แท็บ
  **CLI access** แสดง "เฟส 2 — ยังไม่เปิด"
- control-plane + manage-plane REST routes (cookie-only) ผ่าน gateway
- Manager-initiated handoff (D3) สำหรับ `chat`- และ `manager`-owned session

**ไม่มี**ในเฟส 1: `AGENT_BROWSER_API_TOKEN`, data-plane routes, `tools/browser-mcp/`,
`owner.kind === "cli"`, `allowCliWrite` (field มีใน store แต่ inert),
`BROWSER_CHAT_RESERVED` (ยังไม่มี CLI มาแย่ง slot)

### เฟส 2 — CLI / MCP / bearer

เพิ่มทางเข้าที่สองบน machinery ที่เฟส 1 พิสูจน์แล้ว:

- `AGENT_BROWSER_API_TOKEN` + `AGENT_BROWSER_PROXY_SECRET` (D2/D6)
- data-plane REST routes + `tools/browser-mcp/server.mjs` (D1)
- `owner.kind === "cli"` + CLI-owned session lifecycle
- write gate 3 ชั้น: `BROWSER_CLI_ENABLED` + `allowCliWrite` (มีผลจริงตอนนี้) +
  schema-valid action
- `BROWSER_CHAT_RESERVED` sub-cap (D8)
- audit log สำหรับ bearer-initiated call (D1)
- **ship dark** — `BROWSER_CLI_ENABLED=false`; flip หลัง register browser-mcp
  บน 1 เครื่อง + manual e2e จริง (ระมัดระวังแบบ codex-cli provider)

---

## สิ่งที่ดีไซน์นี้ตั้งใจ "หัก" จาก v1

`VIRTUAL-BROWSER-PLAN.md` ระบุชัด: _"Browser state and cookies are never shared
between chat connections"_ + _"process, profile และ snapshot จะถูกปิดเมื่อกด
Stop / disconnect / shutdown"_ — v1 เป็น **ephemeral per loop** โดยตั้งใจ

ดีไซน์นี้เพิ่มทางเลือก **persistent profile** — _deliberate departure from the
original trust model_ แบบเดียวกับ per-server SSH password auth:

- โปรไฟล์ = **ชุด credential ที่ใช้ซ้ำได้** ของเว็บจริงที่ login แล้ว เก็บ
  **plaintext บนดิสก์** ที่ `apps/agent-service/data/browser-profiles/<profileId>/`
  (mode `0700`, gitignored) — ครอบคลุม cookies, localStorage/sessionStorage,
  IndexedDB, service-worker cache, HTTP cache, saved form data
- **ผลของ profile leak**: อ่านไดเรกทอรีนี้ได้ = สวมรอย session ที่ login ไว้ทุกอัน
  จนกว่า cookie หมดอายุ — กว้างกว่า `servers.json` (password เดียวต่อ host) มาก;
  ยอมรับ plaintext เพราะ single-user host (เหมือน `servers.json` /
  `push-subscriptions.json`) แต่ D7 กำหนด containment เพิ่ม
- โปรไฟล์ ephemeral (ไม่ระบุ `profileId`) = พฤติกรรม v1 เป๊ะ ๆ (`mkdtemp` +
  `rm -rf` ตอน dispose) — **default ยังเป็น ephemeral**
- **ข้อดี**: `prepareAgentReturn()` เก็บ cookie ไว้แต่ล้างค่าในฟอร์ม → persistent
  profile ทำให้ handoff _มีค่าขึ้น_: มนุษย์ login ด้วยมือครั้งเดียวผ่าน "Take
  control" แล้ว chat agent (เฟส 1) และ CLI (เฟส 2) ใช้ session นั้นซ้ำได้

---

## สรุป TBD ที่ปิดแล้ว (2026-09-03)

| เรื่อง                              | ตัดสิน                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| สร้างเลยไหม                         | **park เป็น doc** เหมือน pm-tool / agent-creator-v2; สร้างเมื่อมี need จริง — ถ้าสร้าง ทำ **เฟส 1 ก่อน**                                                                                                                |
| CLI capture ลงไฟล์                  | **ตัดถาวรใน v1** (ทั้ง 2 เฟส) — base64 read ครอบ use case; เพิ่มทีหลังได้ถ้าจำเป็น                                                                                                                                      |
| bearer token model                  | **1 global token, read-only by default; write ยัง gate ต่อโปรไฟล์**; ไม่แยก per-profile token; **อย่าติด browser-mcp บนเครื่อง shared/less-trusted** แบบ pm-mcp (live authenticated session sensitive กว่า pm data มาก) |
| Manager take-control ของ chat-owned | **อนุญาต + notify แชท** (D3.4) — lease เป็น arbiter; ห้ามไว้ = failure mode แย่กว่า                                                                                                                                     |
| "New profile & sign in" owner       | session sign-in เป็น **`manager`-owned + short-lived** (dispose ตอน Done); โปรไฟล์เก็บ cookie ไว้ ใครเปิด session บนโปรไฟล์นั้นทีหลัง (chat/CLI) ก็ได้ state ที่ login แล้ว — เหมือนกันทั้ง 2 เฟส                       |
| เปิด local-prod ตอน merge           | เฟส 1 เปิดได้; **เฟส 2 ship dark** จน manual e2e ผ่าน                                                                                                                                                                   |
| persistent profile สำหรับ chat      | **ใช่ — core ของเฟส 1**                                                                                                                                                                                                 |
| cross-instance force-steal button   | **ไม่มีใน v1** — fail-closed + error ชัดพอ (single-host คือ target)                                                                                                                                                     |
| dead CLI session TTL                | **ไม่มี TTL** — เหมือน dead terminal, อยู่จนลบเอง, แสดง dimmed                                                                                                                                                          |
| header icon                         | lucide **`Chrome`** (fallback `PanelTop`) — เลี่ยง `Globe` ที่ชนของเดิม                                                                                                                                                 |
| audit log                           | v1 ใช้ `console.log("[agent-browser-audit]", …)` ให้ PM2 เก็บ — ไม่เขียน rotation code                                                                                                                                  |
| build pipeline                      | **SA→(BE‖FE)** แบบ notes / multi-window; SA pass ออก shared-types + store slice + **contract ของ profile-store/lock** ก่อน                                                                                              |

---

## การตัดสินใจหลัก (D1–D9)

### D1 — Approval / authz [เฟส 2 สำหรับ bearer; เฟส 1 cookie-only]

**ปัญหา**: ในแชท ทุก `browser_act` อยู่ใน `ONE_TIME_TOOLS` — มนุษย์อนุมัติทีละครั้ง
External CLI **ไม่มี** ช่องอนุมัติ; token ที่พิมพ์อะไรก็ได้ลงเว็บที่ login แล้ว =
สิทธิ์ใหญ่กว่า `HOOK_NOTIFY_TOKEN` มาก

**ตัดสิน**: แบ่ง surface เป็น 2 ชั้นตาม auth + gate 3 ชั้นบน write

**Control plane + Manage plane — cookie/human-only** (bearer → `403`; ทั้งหมดเป็น
เฟส 1):

- profile CRUD: `POST/PATCH/DELETE /profiles/*` (รวม toggle `allowCliWrite`)
- enumerate / คุม session ของ _ทุก_ owner: `/manage/sessions/*` (D5)
- initiate / cancel handoff: `/manage/sessions/:id/handoff` (D3)

→ ผู้ถือ `AGENT_BROWSER_API_TOKEN` **แต่งตั้ง `allowCliWrite` ให้ตัวเองไม่ได้**;
MCP surface **ไม่มี** `browser_profile_*` write tool

**Data plane — bearer หรือ cookie, เฉพาะ CLI-owned session** (เฟส 2):

- read: `observe` / `list_tabs` / `screenshot` (คืน base64 bounded)
- lifecycle: `POST /sessions` (เปิด CLI-owned) / `DELETE /sessions/:id`
- write: `act` — ผ่านได้ต่อเมื่อ **ทั้ง 3 gate**:
  1. `BROWSER_CLI_ENABLED=true` (ไม่ตั้ง → data-plane route ตอบ `503`, MCP ไม่
     โฆษณา write tool)
  2. `profileId != null` และ `profile.allowCliWrite === true` — ephemeral /
     โปรไฟล์ที่ไม่ opt-in → `403`
  3. action ผ่าน schema validation (D6) — ไม่รู้จัก → `400`, ไม่ passthrough
- **ไม่มี `capture`** — CLI เขียน filesystem ของ terminal ไม่ได้เลย (blocking #2)
- **ไม่มี** `request_handoff` — handoff เป็น human action ผ่าน manage plane (D3)

**ขอบเขต bearer ที่ต้องยอมรับ + บันทึกไว้ชัด**: bearer อ่าน snapshot / URL /
title / state / screenshot ของ **ทุก CLI-owned session ทุกโปรไฟล์** และเปิด/ปิด
CLI session ได้ — ไม่ใช่แค่โปรไฟล์ที่ opt-in ดังนั้น:

- deploy **TLS-only** — gateway ปฏิเสธ bearer บน request ที่ไม่ใช่ `https` /
  loopback (mirror `isSecureHandoff`)
- rotation: เปลี่ยน `AGENT_BROWSER_API_TOKEN` + restart = เพิกถอนทันที (ตัวเดียว,
  ไม่มี store)
- **ไม่แยก read/write token** (single-user) — write ถูก gate ต่อโปรไฟล์อยู่แล้ว
- **deployment guidance**: อย่าติด `tools/browser-mcp/` บนเครื่อง shared /
  less-trusted แบบที่ทำกับ `tools/pm-mcp/` — live authenticated browser session
  sensitive กว่า PM data มาก
- audit: log ทุก bearer-initiated call เป็น `{ts, route, sessionId, profileId,
action, ok}` — **ไม่มี** typed text / URL query / screenshot bytes; v1 =
  `console.log("[agent-browser-audit]", …)` ให้ PM2 เก็บ

### D2 — Inbound auth topology [เฟส 1 cookie; เฟส 2 เพิ่ม bearer]

**ข้อเท็จจริง**: `apps/agent-service` วันนี้ **cookie-only** (`gateway.verifyCookie`)
bind `127.0.0.1`; `isArtifactBearerAuthorized` อยู่ที่ **gateway**

**precedent**: Munder Difflin viewer — loopback service ไม่มี auth ของตัวเอง
front ด้วย gateway proxy; แต่เป็น GET/HEAD target คงที่ ส่วนนี่เป็น mutation proxy
จึงต้องเข้มกว่า (D6)

**ตัดสิน**: gateway proxy ไม่เพิ่ม auth surface เต็มที่ agent-service

```
เฟส 1:
  FE  ──HTTPS + Cookie──►  gateway  /api/agent-browser/{profiles,manage}/*  ──loopback──►  agent-service :3009
                           (cookie-only)                                     + x-agent-browser-proxy: <secret>

เฟส 2 เพิ่ม:
  CLI ──HTTPS + Bearer──►  gateway  /api/agent-browser/sessions/*  ──loopback──►  agent-service :3009
                           (bearer TLS-only, data plane, CLI-owned เท่านั้น)
```

- `AGENT_BROWSER_API_TOKEN` (เฟส 2) — **เฉพาะ**, predicate
  `isAgentBrowserBearerAuthorized` scope route family เดียว
- `AGENT_BROWSER_PROXY_SECRET` (เฟส 1 ขึ้นไป — จำเป็นแม้ยังไม่มี bearer) — shared
  header gateway ↔ agent-service (D6)
- `pnpm --filter @sparklab/terminal-gateway generate-agent-browser-token` —
  ออกทั้ง proxy secret (เฟส 1) และ api token (เฟส 2)
- Origin/CSRF guard บน POST/PATCH/DELETE (GET exempt) — เหมือน fs routes

### D3 — Handoff (ไม่มี role ที่สามใน lease) [เฟส 1]

**ข้อเท็จจริง**: `BrowserControlLease` = `agent_active | pending | human_active
| closed` broker เดิมเริ่ม handoff ด้วย `{user, chatId, browser, sendAgent}` +
ส่ง one-time token ผ่าน `/agent` stream ของแชท — `manager`/`cli`-owned session
ไม่มี stream นั้น (blocking #3)

**ตัดสิน**:

1. **lease ไม่เพิ่ม role** — owner แต่ละ kind แยกขาดเชิงโครงสร้าง (D5);
   `agent_active` = "เจ้าของกำลังคุม"
2. **`cli` ริเริ่ม handoff ไม่ได้**; `manager`/`chat` ริเริ่มผ่าน cookie เท่านั้น
3. **handoff เริ่มผ่าน** `POST /api/agent-browser/manage/sessions/:id/handoff`
   (cookie):
   - authz = cookie user ใด ๆ ที่ผ่าน `gateway.verifyCookie` (single-user;
     บันทึก `principal`)
   - agent-service สร้าง handoff record ใน broker ด้วย `{user, chatId: null,
browser, sendAgent: <lifecycle sink>}` — sink push `browser_view` +
     `handoff_state` ให้ manager subscriber list; **ไม่เคย** push token ที่นั่น
   - **one-time token + resumeToken ส่งกลับใน HTTP response ของ call นี้**
     (authenticated ด้วย cookie + TLS) → frontend เอาไปเปิด `/browser-handoff`
     WS เดิม; broker `accept()` ตรวจ token เหมือนเดิม
   - idempotent: มี handoff pending/active อยู่แล้ว → คืน state เดิม ไม่สร้าง
     ที่สอง (mirror `AGENT-PROTOCOL.md`)
   - cancel: `DELETE …/manage/sessions/:id/handoff` → `broker.cancel()`
   - timeout: TTL เดิม (60s token / 120s idle / 600s hard)
4. **handoff ของ `chat`-owned session จาก Manager**: ผ่าน route เดียวกัน แต่
   agent-service **ต้อง** notify แชทนั้นด้วย `sendAgent` จริง → lease/history
   ของ chat agent coherent; `requestHuman()` throw ถ้าไม่ใช่ `agent_active` →
   Manager ได้ `409`
5. Done เดิม: `prepareAgentReturn()` → `returnToAgent()`
6. ผู้เริ่ม handoff **ไม่**เห็น typed input / frame ถ้าไม่ได้เปิด socket เอง

### D4 — Profile lock (fencing, ไม่ split-brain) [เฟส 1]

Chromium/Browser Use spawn **detached** → agent-service crash แล้วลืม holder ที่
ยังรันอยู่ได้ สอง process บน `--user-data-dir` เดียวกัน = โปรไฟล์พัง

**ตัดสิน**: lock ใน profile store พร้อม fencing + durable owner + boot sweep

```jsonc
// data/browser-profiles.json  (atomic write, synchronous mutators — เหมือน registry.js)
{
  "profiles": [
    {
      "id": "prof_ab12cd34ef56",
      "rev": 7, // bump ทุก mutation — CAS
      "name": "github-bot",
      "createdAt": "…",
      "lastUsedAt": "…",
      "allowCliWrite": false, // inert ในเฟส 1
      "lockEpoch": 12, // fencing token — bump ทุกครั้งที่ acquire สำเร็จ
      "lock": {
        // หรือ null
        "sessionId": "bs_…",
        "ownerInstanceId": "agent-a1b2", // เสถียรต่อ instance
        "holderPid": 12345, // pid ของ agent-service
        "chromiumPid": 12360, // pid ของ Chromium (ให้ boot sweep ฆ่า orphan)
        "acquiredAt": "…",
        "heartbeatAt": "…",
      },
    },
  ],
}
```

- **`ownerInstanceId`** — `AGENT_BROWSER_INSTANCE_ID` (env) หรือ derive จาก
  hostname เหมือน `CUA_INSTANCE_ID`; **ต้องเสถียรข้าม restart**
- **acquire** = CAS บน `rev`; สำเร็จ → `lockEpoch++`, host ถือ epoch ไว้
- **heartbeat** 30s เขียน `heartbeatAt` + ตรวจ `lockEpoch` ยังตรง — ไม่ตรง =
  ถูก steal → **self-terminate ทันที** (fencing)
- **`PROFILE_LOCK_TTL_MS` = 120s** (60s ตึงเกินภายใต้ approval stall)
- **steal** อนุญาตเฉพาะเมื่อ:
  - _same instance_: `sessionId` ไม่อยู่ใน live manager **และ**
    `process.kill(chromiumPid, 0)` throw → reclaim orphan
  - _different instance_: ตรวจ process อีกฝั่งไม่ได้ → `heartbeatAt` เก่ากว่า
    TTL **และ** (same host) `chromiumPid` ตาย; ไม่งั้น **`409
profile_locked_elsewhere`** + resolve เอง (fail closed; **ไม่มีปุ่ม
    force-steal ใน v1**)
- **boot sweep** (`BrowserSessionManager.recover()` ก่อน `server.listen` เหมือน
  `ComputerRuntime.sweepOrphans()`): ทุก `lock` ที่ `ownerInstanceId === this`
  → **kill `chromiumPid` + process group**, clear `lock`, `lockEpoch++`
- **release** ตอน dispose = CAS clear (ตรวจ `lockEpoch`)
- ephemeral ไม่ต้อง lock; `DELETE /profiles/:id` → `409` ถ้า locked-not-stale,
  stale → steal-then-delete atomic

### D5 — Session enumeration: data plane vs manage plane

**ปัญหา** (blocking #5): `GET /sessions` เดิมคืนแค่ CLI-owned แต่ Manager ต้อง
list / view / handoff / close **ทุก owner**

**ตัดสิน**: 2 endpoint แยก auth

| endpoint                                 | auth               | คืนอะไร                                                               | เฟส |
| ---------------------------------------- | ------------------ | --------------------------------------------------------------------- | --- |
| `GET /api/agent-browser/manage/sessions` | **cookie-only**    | **ทุก session** + `owner` + `leaseState` + `alive` + `lastSnapshotId` | 1   |
| `GET /api/agent-browser/sessions`        | bearer หรือ cookie | **เฉพาะ CLI-owned**                                                   | 2   |

- `browser_view` ของ session ที่ไม่ใช่ของแชทปัจจุบัน: Manager อ่านผ่าน
  `GET /api/agent-browser/manage/sessions/:id/screenshot?snapshotId=`
  (**cookie-only**) — snapshot เดียวกับที่ `BrowserRuntime` สร้าง, อ่านด้วย
  `sessionId`
- bearer **ไม่มีทาง** แตะ `manage/*`

### D6 — Internal proxy boundary [เฟส 1]

- **`AGENT_BROWSER_PROXY_SECRET`**: gen โดย script; ≥ 32 bytes; agent-service +
  gateway **fail startup** ถ้า route family เปิดแต่ secret ไม่ตั้ง/สั้น;
  เทียบด้วย `crypto.timingSafeEqual`
- **gateway strip** `x-agent-browser-proxy` + `x-agent-browser-*` ทุกตัวที่
  client ส่งมา ก่อนเติมของตัวเอง
- **method + path allowlist** (ตาราง regex ของ route ใน "REST surface"; อื่น →
  `404`)
- **bounded**: request body JSON ≤ 64 KiB (ไม่มี upload route); response
  streaming cap; **upstream timeout 30s** → `504`
- **strip hop-by-hop headers** สองทิศ; **ไม่ forward** `Authorization` / `Cookie`
  ไป upstream — agent-service เชื่อเฉพาะ `x-agent-browser-proxy`
- agent-service ยัง bind loopback; route module ปฏิเสธ request ที่ header ไม่ตรง

### D7 — Persistent profile: path safety + at-rest [เฟส 1]

- **profileId ออกโดย server เท่านั้น** — `prof_` + 12 rand [a-z0-9]; ปฏิเสธ input
  ที่ไม่ match `^prof_[a-z0-9]{12}$` **ก่อน** ประกอบ path
- path = `join(PROFILES_DIR, profileId)` แล้ว **assert** `realpath` ยังอยู่ใต้
  `PROFILES_DIR` (กัน `..` / symlink escape); ปฏิเสธถ้า target เป็น symlink
- **delete** = resolve + assert + `rm -rf` (ไม่ตาม symlink); refuse ระหว่าง
  locked-not-stale
- mode: `PROFILES_DIR` + ทุก `<profileId>/` = `0700`; `umask 0077` ก่อน spawn
- **downloads/config dir ยัง ephemeral เสมอ** (reaffirm)
- **ไม่เคยคืน path บนดิสก์** ผ่าน API ใด ๆ (mirror `servers.json` password)
- threat warning ครอบ: cookies, local/session storage, IndexedDB, SW cache,
  HTTP cache, saved form data
- (optional) size cap ต่อโปรไฟล์ + รวม → warn ใน `/manage` + `/health`

### D8 — Resource fairness [เฟส 2]

**ข้อเท็จจริง**: `browser-resource-limiter.ts` = process-wide FCFS, hard-fail ที่
`MAX_BROWSER_SESSIONS` (default **4**) เฟส 1 มีแต่ chat + manager session — ยังไม่
ต้องกันใครแย่ง

**ตัดสิน (เฟส 2)**:

- `reserveSession(owner)` รับ owner kind
- `BROWSER_CHAT_RESERVED` (default **1**) — `cli`-owned รวมกันได้ไม่เกิน
  `MAX_BROWSER_SESSIONS - BROWSER_CHAT_RESERVED`
- CLI reservation ล้ม → `503 cli_capacity`
- `acquireLaunch()` waiter รองรับ `AbortSignal`
- `browserResources.snapshot()` แยกนับ `chat` / `manager` / `cli` → `/health`

### D9 — Single dispose path [เฟส 1]

`BrowserSessionManager.disposeSession(sessionId, reason)` เป็น **ทางเดียว** ที่
teardown เกิด:

1. kill Browser Use + Chromium **process group**
2. release profile lock (CAS บน `lockEpoch`)
3. emit lifecycle: `chat`-owned → `sendAgent` ของแชท (`browser_closed`); ทุก
   owner → manager subscriber list; บันทึก close tombstone (revision เดิม)
4. `cli`/`manager`-owned → mark `alive:false`, อ่านได้จาก `GET …/sessions/:id`
   **จน explicit `DELETE` — ไม่มี TTL** (mirror dead-session persistence)
5. guard ด้วย per-session `disposing` promise → **idempotent**

trigger ทั้งหมด funnel เข้า: Browser Use `exit`, Chromium `exit`
(`onUnexpectedExit`), `child "error"`, broker idle/hard timeout, MCP line-cap
breach, `SIGINT/SIGTERM` (`runs.disposeAll()` + `manager.disposeAll()`), boot
`recover()`

gateway restart: gateway ไม่ถือ browser state — frontend re-query
`/manage/sessions` ตอน reconnect

---

## Seam ที่ต้องแตะ

### ใหม่ — agent-service

| ไฟล์                         | เฟส                           | หน้าที่                                                                                                                                |
| ---------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-session-manager.ts` | 1                             | ถือ N `BrowserSession`, `disposeSession` (D9), `recover()` boot sweep (D4), subscriber list, owner metadata; `AgentLoop` เป็น consumer |
| `browser-profiles.ts`        | 1                             | profile store + lock CAS + `lockEpoch` fencing (D4/D7), shape ตาม `registry.js`                                                        |
| `agent-browser-routes.ts`    | 1 (control+manage) / 2 (data) | handler แยก plane; ทุก request ต้องมี `x-agent-browser-proxy` ตรง (D6); audit log (D1, เฟส 2)                                          |

### แก้ของเดิม — agent-service

| ไฟล์                          | เฟส | แก้อะไร                                                                                                                                                                                         |
| ----------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-session-host.ts`     | 1   | `start({ profileDir?, lockEpoch? })`; `dispose()` **ไม่ `rm -rf`** persistent dir (load-bearing); บันทึก `chromiumPid`; `umask` (D7)                                                            |
| `browser-runtime.ts`          | 1   | response ที่คืนทาง REST = ตัวเดิม → `sanitizePublicUrl` ฟรี; redirect revalidation + dispose-on-unsafe เหมือนเดิม (SSRF parity)                                                                 |
| `browser-handoff-broker.ts`   | 1   | mode "manager-initiated": `chatId: null`, `sendAgent` = lifecycle sink, **คืน token/resumeToken เป็น return value** แทน push (D3)                                                               |
| `agent-loop.ts`               | 1   | Manager-initiated handoff ของ chat-owned ต้อง reflect ใน chat lease/history (D3.4); เพิ่ม tool `browser_use_profile` (chat-only, one-time)                                                      |
| `browser-resource-limiter.ts` | 2   | `reserveSession(owner)` + `BROWSER_CHAT_RESERVED` + abortable waiter + split metrics (D8)                                                                                                       |
| `config.ts` / `index.ts`      | 1/2 | `agentBrowser.{proxySecret(1), apiToken(2), instanceId}`, `browser.{cliEnabled(2), chatReserved(2)}` + fail-fast (D6); mount routes; `manager.disposeAll()` ใน SIGTERM; `recover()` ก่อน listen |

### ใหม่ — gateway (`src/server.js`) [เฟส 1 control+manage; เฟส 2 data]

- route family `/api/agent-browser/*` — reverse-proxy ไป
  `AGENT_BROWSER_INTERNAL_URL` (default `http://127.0.0.1:3009`)
- method+path allowlist, strip client `x-agent-browser-*`, เติม
  `x-agent-browser-proxy`, ไม่ forward `Authorization`/`Cookie`, bounded
  body/response, 30s timeout (D6)
- auth: `profiles/*` + `manage/*` = **cookie-only**; `sessions/*` (data, เฟส 2)
  = cookie **หรือ** `isAgentBrowserBearerAuthorized` **และ** TLS/loopback (D1)
- fail startup ถ้า route เปิดแต่ `AGENT_BROWSER_PROXY_SECRET` ไม่ตั้ง
- `generate-agent-browser-token` (ออก proxy secret + api token)

### ใหม่ — `tools/browser-mcp/server.mjs` [เฟส 2]

สำเนา shape จาก `notes-mcp` — dependency-free stdio JSON-RPC, thin REST client
ไป `BASE/api/agent-browser/sessions/*` ด้วย `Authorization: Bearer` (data plane
เท่านั้น)

### ใหม่ — frontend [เฟส 1]

- `features/browser-view/` — parametrize `browserId` (อ่าน frame ผ่าน
  `/manage/sessions/:id/screenshot`); honor close tombstone จาก poll
- **Browser Manager dialog** — ดู [UI](#ui--browser-manager-ใน-sparklab-terminal)

---

## REST surface (ผ่าน gateway)

### Control plane — **cookie/human-only** (bearer → `403`) [เฟส 1]

| Method + Path                                                     | ทำอะไร                                       |
| ----------------------------------------------------------------- | -------------------------------------------- |
| `GET  /api/agent-browser/profiles`                                | list โปรไฟล์ (ไม่มี path บนดิสก์)            |
| `POST /api/agent-browser/profiles` `{name}`                       | สร้าง (profileId ออกโดย server, D7)          |
| `PATCH /api/agent-browser/profiles/:id` `{name?, allowCliWrite?}` | แก้ (`allowCliWrite` inert จนเฟส 2)          |
| `DELETE /api/agent-browser/profiles/:id`                          | ลบไดเรกทอรี (D7; `409` ถ้า locked-not-stale) |

### Manage plane — **cookie-only**; ทุก owner [เฟส 1]

| Method + Path                                                                        | ทำอะไร                                                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET  /api/agent-browser/manage/sessions`                                            | **ทุก session** + `owner` + `leaseState` + `alive` + `lastSnapshotId`                                           |
| `POST /api/agent-browser/manage/sessions` `{profileId, purpose:"signin"\|"inspect"}` | เปิด **`manager`-owned** session (acquire lock)                                                                 |
| `GET  /api/agent-browser/manage/sessions/:id/screenshot?snapshotId=`                 | raw bytes; `Cache-Control: no-store`; `410`                                                                     |
| `POST /api/agent-browser/manage/sessions/:id/handoff`                                | เริ่ม/คืน handoff — **คืน `{handoffId, token, resumeToken}` ใน response** (D3); idempotent                      |
| `DELETE /api/agent-browser/manage/sessions/:id/handoff`                              | cancel handoff                                                                                                  |
| `DELETE /api/agent-browser/manage/sessions/:id`                                      | dispose (chat-owned → เตือน; D9)                                                                                |
| `GET  /api/agent-browser/manage/access`                                              | `{cliEnabled, apiTokenConfigured:bool, baseUrl, profiles:[{id,name,allowCliWrite}]}` — **ไม่เคยมี token value** |

### Data plane — bearer หรือ cookie; **CLI-owned เท่านั้น** [เฟส 2]

| Method + Path                                                 | ทำอะไร                                                                          | gate                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `GET  /api/agent-browser/sessions`                            | list **เฉพาะ CLI-owned**                                                        | –                                                   |
| `POST /api/agent-browser/sessions` `{profileId?}`             | เปิด CLI-owned (acquire lock); ไม่ส่ง profileId = ephemeral                     | `503` ถ้า CLI ไม่ enabled / `503 cli_capacity` (D8) |
| `GET  /api/agent-browser/sessions/:id`                        | `alive`, `leaseState`, `lastSnapshotId`, `url`, `title`                         | –                                                   |
| `DELETE /api/agent-browser/sessions/:id`                      | dispose (D9)                                                                    | –                                                   |
| `POST /api/agent-browser/sessions/:id/observe`                | → `{snapshotId, url, title, viewport, elements[], state}` **ไม่มี image bytes** | –                                                   |
| `GET  /api/agent-browser/sessions/:id/screenshot?snapshotId=` | raw bytes ≤2 MiB; `Cache-Control: no-store`; `410`                              | –                                                   |
| `POST /api/agent-browser/sessions/:id/list-tabs`              | → tab list (text)                                                               | –                                                   |
| `POST /api/agent-browser/sessions/:id/act` `{action,…}`       | หนึ่ง action; schema-validated                                                  | **ทั้ง 3 gate ของ D1** (`503`/`403`/`400`)          |

**ไม่มี `capture`** ใน data plane (blocking #2)

## MCP tools (`tools/browser-mcp/server.mjs`) — data plane เท่านั้น [เฟส 2]

- `browser_session_open {profile_id?}` → `{session_id, profile_id, ephemeral}`
- `browser_session_close {session_id}`, `browser_sessions_list`
- `browser_session_status {session_id}`
- `browser_observe {session_id}` → text state + `snapshot_id`
- `browser_list_tabs {session_id}`
- `browser_screenshot {session_id, snapshot_id}` → base64 bounded (explicit
  opt-in, เตือนขนาด) — **ไม่มี** filesystem write
- `browser_act {session_id, action, …}` — โฆษณาเฉพาะเมื่อ gateway ตอบ
  `cliEnabled:true`; `403` ถ้า `allowCliWrite=false`; `400` ถ้า action นอก schema

**ไม่มี** (ตั้งใจ): `browser_profile_*` (control plane, human-only),
`browser_capture` (blocking #2), `browser_request_handoff` (D3)

---

## UI — Browser Manager ใน Sparklab Terminal [เฟส 1]

native React modal ยิงเฉพาะ `profiles/*` + `manage/*` (cookie ของแอป — **ไม่เคย**
ใช้ bearer)

### แนวทาง: native modal ไม่ใช่ pluggable iframe artifact

Kanban/PM/Notes/… เป็น sandboxed iframe เพราะ store gateway เป็นเจ้าของ + self-
contained; Browser Manager ต้องใช้ cookie stack ของแอป + ต่อกับ
`features/browser-view/` + `features/browser-handoff/` โดยตรง → native modal
แบบ `file-explorer-dialog.tsx`

### Entry point

- **Header button** always-enabled ไอคอน lucide **`Chrome`** (fallback
  `PanelTop`) — ไม่ใช้ `Globe` ที่ชนของเดิม
- **`?browser` URL flag** ผ่าน `useUrlFlagSync` (`?browser=sessions|profiles|access`)
- **store slice** `browserManagerOpen` + `browserManagerTab` (ephemeral,
  persist-excluded)
- ปุ่ม "Manage browsers" ใน settings section "Agent chat"

### Layout — 3 แท็บ

**แท็บ 1 · Profiles** (control plane)

| คอลัมน์             | หมายเหตุ                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Name                | rename inline                                                                                                            |
| Created / Last used | relative time                                                                                                            |
| CLI write           | `Switch` → `PATCH /profiles/:id {allowCliWrite}` — **เฟส 1: disabled + tooltip "เฟส 2"**; เฟส 2: เปิดใช้ + confirm เตือน |
| Lock                | badge "in use by <owner principal>" / "free" / "stale — reclaimable"                                                     |
| —                   | Delete (ownership-aware destructive confirm; disabled ขณะ locked-not-stale)                                              |

- **New profile** → prompt ชื่อ → `POST /profiles`
- **New profile & sign in** (happy path): `POST /profiles` →
  `POST /manage/sessions {profileId, purpose:"signin"}` (**`manager`-owned,
  short-lived**) → `POST /manage/sessions/:id/handoff` → เปิด Browser View +
  handoff → มนุษย์ login → Done → session ถูก dispose, **โปรไฟล์เก็บ cookie ไว้**
- **empty state** เมื่อ `BROWSER_USE_PROJECT` ไม่ตั้ง → "browser tools ปิดอยู่" +
  ชี้ `docs/VIRTUAL-BROWSER.md`

**แท็บ 2 · Sessions** (`GET /manage/sessions`, poll 3–5s)

- owner badge — `chat:<name>` / `manager:<user>` / `CLI` (เฟส 2)
- profile name หรือ `ephemeral`
- thumbnail = snapshot ล่าสุด (`Cache-Control: no-store`; **drop `<img>` ทันที
  เมื่อ poll คืน `alive:false`**)
- URL + title (`sanitizePublicUrl` แล้ว)
- lease badge `agent` / `pending` / `human` / `closed` (มาจาก poll —
  authoritative)
- ปุ่ม: **Take control** (re-check `GET /manage/sessions/:id` ก่อน → `handoff` →
  เอา token ใน response เปิด `/browser-handoff` เดิม; `409` → refetch) ·
  **Open in Browser View** (`browserId` param) · **Close** (chat-owned →
  confirm "จะปิด browser ของแชทนั้น")
- error / loading / re-auth (401 → prompt login) states
- **empty state**: "ยังไม่มี browser session ที่ทำงานอยู่"

**แท็บ 3 · CLI access** (`GET /manage/access`, read-only)

- **เฟส 1**: แสดง "เฟส 2 — ยังไม่เปิด" + ลิงก์เอกสาร
- **เฟส 2**: `BROWSER_CLI_ENABLED` badge · API token "configured / not"
  (**ไม่เคยแสดงค่า**) · base URL (`PUBLIC_ORIGIN`) · snippet คัดลอกได้
  `claude mcp add browser -- node …/tools/browser-mcp/server.mjs -e
AGENT_BROWSER_API_TOKEN=… -e BROWSER_BASE_URL=…` · ตารางโปรไฟล์ +
  `allowCliWrite` (read-only) · ข้อความเตือนขอบเขต token (D1)

### Data wiring — `hooks/use-browser-agent.ts`

TanStack Query, cookie:

- queries: `useBrowserProfiles()`, `useManagedSessions({ refetchInterval: 4000 })`,
  `useBrowserAccessInfo()`
- mutations: `createProfile`, `renameProfile`, `deleteProfile`,
  `setProfileCliWrite`, `openManagerSession`, `closeSession`, `requestHandoff`,
  `cancelHandoff`
- thumbnail: `managedSnapshotUrl(sessionId, snapshotId)` → `<img>` src; `410` /
  `alive:false` → placeholder, **ห้าม cache/retain**
- **ไม่มี WebSocket ใหม่** — poll พอสำหรับ inventory (แนว `use-git-status.ts`);
  authoritative transition (`leaseState`/`alive`) มาจาก poll; real-time เฉพาะ
  ตอน Take control ผ่าน `/browser-handoff` เดิม

### Interaction กับ feature เดิม

- `features/browser-view/` — `browserId` param; honor close tombstone (revision
  - `alive:false`) จาก poll
- `features/browser-handoff/` — ไม่แก้; Manager แค่ trigger + ส่ง token จาก
  response ให้ flow เดิม
- settings dialog — เพิ่มปุ่มลิงก์เดียว

### Mobile

Desktop-first; มือถือแสดงแท็บ Sessions read-only (ไม่มี Take control), ซ่อน
Profiles / CLI access

### Design

DESIGN.md palette + theme tokens, lucide (`size-3.5`/`size-4`), primitives จาก
`@sparklab/ui` (`Dialog`, `Button`, `Switch`, `Tooltip`, `Badge`, `Separator`)
— ห้าม hardcode hex

### ไฟล์ frontend

- **เพิ่ม** `apps/terminal/src/features/browser-manager/` —
  `components/browser-manager-dialog.tsx`, `hooks/use-browser-agent.ts`,
  `components/{profiles-tab,sessions-tab,cli-access-tab,session-row}.tsx`
- **แก้** store slice, header button, `use-url-flag-sync` (`?browser`),
  `settings-dialog.tsx` (ปุ่มลิงก์), `features/browser-view/` (`browserId` param)
- **schemas** `packages/shared-types/src/agent.ts` — `AgentBrowserProfile`,
  `AgentBrowserManagedSession` (+ `owner`), `AgentBrowserSession` (เฟส 2),
  `AgentBrowserAccessInfo`, handoff-request/response + `/api/agent-browser/*`
  request/response

---

## Build

SA→(BE‖FE) role pipeline แบบ `feat/notes-tool` / `feat/multi-window-terminal`:

- **SA pass** ออกก่อน: `shared-types` block, store slice, และ **contract ของ
  `browser-profiles.ts` (store + lock CAS + `lockEpoch` fencing) + `disposeSession`
  invariants** — ส่วนที่ยากที่สุดและ review หนักสุด
- **เฟส 1**: BE (profile store, session manager, host asymmetry, broker
  manager-mode, control+manage routes, gateway proxy) ‖ FE (Browser Manager
  dialog, browser-view parametrize)
- **เฟส 2**: BE (bearer + data plane routes, resource sub-cap, audit) +
  `tools/browser-mcp/` — branch แยก, ship dark

---

## Load-bearing tests

gate `test:agent-browser` (+ UI e2e ใน `apps/e2e/`)

### เฟส 1 gate

**A — persistence & lifecycle**

1. **`agent-browser-profile-persist`** (gate หลัก): **fixture HTTP server** (ใน
   test) ที่ set cookie แล้ว echo กลับ — เปิด `manager` session บนโปรไฟล์ `P` →
   navigate ให้ set cookie → `dispose()` → **restart agent-service** → เปิด
   session ใหม่บน `P` → navigate หน้า echo → cookie **ยังอยู่**
2. `dispose()` ปกติ **ไม่ลบ** persistent dir; config/downloads dir ephemeral
   **ถูกลบ**
3. `DELETE /profiles/:id` ลบจริง; `409` ระหว่าง locked-not-stale; profileId ที่
   มี `..` / ไม่ match pattern / เป็น symlink → `400`, path ไม่ถูกแตะ (D7)

**B — lock fencing & crash recovery (D4)**

4. สอง session ขอโปรไฟล์เดียวกันพร้อมกัน → ตัวที่สอง `409` (ไม่ใช่ launch fail /
   โปรไฟล์พัง)
5. `kill -9` holder → **restart** → boot sweep ฆ่า orphan `chromiumPid` + clear
   lock + `lockEpoch++` → session ใหม่ acquire ได้
6. stale holder ที่ "ฟื้น" หลังถูก steal → heartbeat เห็น `lockEpoch` ไม่ตรง →
   self-terminate ไม่เขียนทับ
7. delete-vs-stale-holder race → deterministic (steal-then-delete atomic)

**C — auth boundary (เฟส 1)**

8. Manager routes ต้อง cookie ที่ valid; ไม่มี cookie / cookie เสีย → `401`
9. `x-agent-browser-proxy` ปลอม/หาย → agent-service ปฏิเสธ; client-supplied
   `x-agent-browser-*` ถูก gateway strip (D6)
10. `manage/access` ไม่เคยมี token value ใน response
11. screenshot response มี `Cache-Control: no-store`

**D — SSRF parity (D6)**

12. `act navigate` ไป `http://127.0.0.1`, `http://169.254.169.254`,
    `http://10.0.0.5`, `http://user:pass@host`, `file://…`, `ftp://…` → ปฏิเสธ
    ทั้งหมด (ผ่าน `validateBrowserUrl` เดิม)
13. public→loopback redirect กลางทาง → session ถูก `disposeSession`

**E — dispose & handoff**

14. `disposeSession` idempotent — เรียกซ้ำจากหลาย trigger → teardown ครั้งเดียว,
    lock release ครั้งเดียว, tombstone revision เดียว
15. Manager-initiated handoff: `POST …/handoff` คืน `{token, resumeToken}` ใน
    body (ไม่ push ที่ไหน); เปิด `/browser-handoff` ด้วย token นั้นสำเร็จ; call
    ซ้ำ = idempotent คืน state เดิม
16. handoff ของ chat-owned จาก Manager → แชทนั้นได้รับ notify; `requestHuman()`
    ตอนไม่ใช่ `agent_active` → `409`

**F — UI e2e (Playwright)**

17. login → `?browser` → สร้างโปรไฟล์ → "New profile & sign in" เปิด Browser
    View + handoff overlay เดิม → Done → session หาย, โปรไฟล์ยังอยู่ → เปิด
    session ตรวจดูอีกครั้ง → cookie คงอยู่; header button + `?browser` deep-link
    - settings ปุ่มลิงก์ทำงาน; dialog ปิด/เปิดใหม่ไม่พก state ค้าง (บทเรียน
      file-explorer bugfix 2026-08-02); `<img>` ถูก drop เมื่อ session ปิด

### เฟส 2 gate (เพิ่ม)

18. **bearer ถูกปฏิเสธ `403`** บนทุก control-plane + `manage/*` route
19. **write gate 3 ชั้น**: `POST …/act` → `503` เมื่อ `BROWSER_CLI_ENABLED`
    ไม่ตั้ง; `403` เมื่อ `allowCliWrite=false` / ephemeral; `400` action นอก
    schema; สำเร็จเมื่อครบ — ผ่าน bearer (ไม่มี cookie/Origin)
20. bearer บน non-TLS non-loopback → ปฏิเสธ (D1)
21. **resource fairness (flipped)**: CLI เปิดจนเต็ม sub-cap
    (`MAX_BROWSER_SESSIONS - BROWSER_CHAT_RESERVED`) → **chat ยังเปิด ephemeral
    browser ได้**; CLI ตัวถัดไป → `503 cli_capacity`
22. `GET /sessions` (data plane) ไม่คืน chat-/manager-owned; chat agent
    `observe` ไม่เห็น CLI-owned session
23. audit log มีแต่ metadata — ไม่มี screenshot / typed text / URL query

regression ที่ต้องเขียว: `pnpm --filter @sparklab/agent-service test`
(`tools.test.ts`, `browser-runtime.test.ts`, `browser-security.test.ts`,
`browser-handoff-broker.test.ts`), `pnpm typecheck`, `pnpm build`, E2E
browser-view/handoff เดิม

---

## นอกขอบเขต v1 (ตั้งใจไม่ทำ)

- CLI ริเริ่ม handoff เอง (D3 — human/cookie เท่านั้น)
- CLI เขียน filesystem ผ่าน `capture` (blocking #2 — chat-only tool)
- bearer แตะ control plane / `manage/*` (blocking #1/#5)
- profile sharing ข้าม user / read-only viewer (ระบบยัง single-user)
- profile encryption at rest (ยอมรับ plaintext เหมือน `servers.json` — D7
  กำหนด containment แทน)
- cross-instance profile lock takeover อัตโนมัติ / ปุ่ม force-steal (D4 — fail
  closed; single-host คือ target deployment)
- แยก read/write bearer token (D1 — write gate ต่อโปรไฟล์พอสำหรับ single-user)
- dead session TTL (D9 — อยู่จนลบเอง เหมือน dead terminal)
- multi-tab / window management ที่ลึกกว่า `browser_act` เดิม
- CDP / raw MCP / JS execution ผ่าน CLI — **ห้ามถาวร** (invariant v1)
