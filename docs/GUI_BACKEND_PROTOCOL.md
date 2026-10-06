# AI Bridge GUI Backend V1 — Entegrasyon ve İletişim Protokolü

Bu doküman, **AI Bridge** CLI backend'i (`ai_bridge.sh`) ile **Electron GUI** arasındaki IPC (Inter-Process Communication), komut satırı arayüzü, JSON olay akışı (NDJSON), durum dosyaları ve güvenlik kontrollerini eksiksiz olarak tanımlar.

---

## 1. Mimarî Genel Bakış

AI Bridge backend'i, bağımsız bir Bash scripti (`ai_bridge.sh`) olarak çalışır ve Windows üzerinde **Git Bash** (`C:\Program Files\Git\bin\bash.exe`) veya POSIX ortamlarında doğrudan Bash ile çalıştırılır.

```
+-------------------------------------------------------------+
|                     Electron GUI (Main/Renderer)            |
+-------------------------------------------------------------+
       |                                              ^
  child_process.spawn()                      stdout: NDJSON Events
  (run, accept, rollback,                    stderr: Diagnostic Logs
   status, report, doctor)                            |
       v                                              |
+-------------------------------------------------------------+
|                  ai_bridge.sh Backend CLI                   |
+-------------------------------------------------------------+
       |                         |                    |
       v                         v                    v
  OpenAI Codex             Claude Code           Antigravity
  (Developer)              (Reviewer)            (Verifier & Fixer)
       |                         |                    |
       +-------------------------+--------------------+
                                 |
                     .git/ai_bridge/run_<RUN_ID>/
                     ├── events.ndjson
                     ├── state.json (Atomic updates)
                     ├── final_report.json
                     └── fingerprint.json
```

---

## 2. CLI Komutları ve Parametreleri

`ai_bridge.sh` alt komut (subcommand) yapısıyla çalışır:

### 2.1 `run` — Görevi Başlat

Çok ajanlı geliştirme döngüsünü başlatır.

```bash
ai_bridge.sh run [OPTIONS]
```

| Argüman | Tip | Varsayılan | Açıklama |
|---|---|---|---|
| `--project <path>` | string | Mevcut dizin | Hedef Git deposunun kök dizini veya alt dizini. |
| `--task <text>` | string | `""` | Uygulanacak görevin metni. |
| `--task-file <path>` | string | `""` | Görev metnini dosyadan okur (uzun görevler için). |
| `--context-file <path>`| string | `""` | ChatGPT / Web context dosyası. `MAX_CONTEXT_CHARS` (100k) aşılırsa son kısım korunarak kırpılır. |
| `--turns <n>` | int | `3` | Maksimum döngü turu sayısı (1 - 10). |
| `--agents <list>` | string | `codex,claude,agy` | Çalıştırılacak ajanlar (virgülle ayrılmış). Örn: `codex,claude,agy`, `claude,agy`, `agy`. |
| `--verify-cmd <cmd>` | string | `""` | Bağımsız test doğrulama komutu (örn: `npm test`, `pytest -q`). |
| `--auto-branch` | flag | true | `ai-bridge/<TIMESTAMP>` adında izole bir branch açar. |
| `--no-auto-branch` | flag | false | Mevcut branch üzerinde çalışır. |
| `--auto-approve` | flag | false | Doğrulama başarılı olunca otomatik commit/merge yapar. |
| `--no-auto-approve` | flag | true | Otomatik birleştirme yapmaz; kullanıcı onayı bekler. |
| `--agy-sandbox` | flag | true | Antigravity ajanını izole sandbox ile çalıştırır. |
| `--no-agy-sandbox` | flag | false | Antigravity sandbox'ını devre dışı bırakır. |
| `--json-events` | flag | false | **(GUI için zorunlu)** Standart çıktıya (stdout) yalnızca geçerli NDJSON satırları basar. İnsan okunabilir tüm loglar stderr ve log dosyasına yönlendirilir. |

#### Geriye Dönük Uyumluluk (Legacy Syntax)
Eğer ilk parametre bir alt komut (`run`, `status`, `accept`, vb.) değilse, eski sözdizimi otomatik olarak `run` komutuna dönüştürülür:
```bash
ai_bridge.sh "Görevi yap" 2 "/path/to/repo"
# Otomatik olarak: ai_bridge.sh run --task "Görevi yap" --turns 2 --project "/path/to/repo"
```

---

### 2.2 `status` — Anlık Durum Sorgulama

```bash
ai_bridge.sh status [--project <path>] [--run-id <id>]
```
- Belirtilen veya en son çalışmanın `state.json` dosyasını stdout'a JSON formatında basar.

---

### 2.3 `accept` — Değişiklikleri Kabul Et ve Birleştir

```bash
ai_bridge.sh accept [--project <path>] [--run-id <id>]
```
- **Güvenlik Kontrolü:** `fingerprint.json` ile çalışma sonrası çalışma ağacının bütünlüğünü doğrular. Harici müdahale varsa işlem reddedilir.
- **İşlem:** İzole çalışma branch'indeki tüm değişiklikleri (yeni oluşturulan untracked dosyalar dahil) `ai-bridge: <run_id> (<decision>)` mesajıyla commit eder, orijinal ana branch'e döner ve merge eder.

---

### 2.4 `rollback` — Değişiklikleri Temizle ve Geri Al

```bash
ai_bridge.sh rollback [--project <path>] [--run-id <id>]
```
- **Güvenlik Kontrolü:** `fingerprint.json` ile çalışma sonrası çalışma ağacını doğrular.
- **İşlem:** İzole branch'teki tüm değişiklikleri orijinal `BASE_HEAD` noktasına sıfırlar (`git reset --hard`), script tarafından eklenen yeni dosyaları siler (`git clean -fd`), çalışma branch'ini siler ve orijinal branch/HEAD'e geri döner.

---

### 2.5 `report` — Nihai Raporu Getir

```bash
ai_bridge.sh report [--project <path>] [--run-id <id>]
```
- Çalışmanın `final_report.json` dosyasını stdout'a basar. Değişen dosya sayıları, ekleme/silme satırları, ajan harcanan süreleri ve karar detaylarını içerir.

---

### 2.6 `history` — Geçmiş Çalışmaları Listele

```bash
ai_bridge.sh history [--project <path>] [--limit <n>]
```
- Depodaki son `n` (varsayılan: 10) çalışmanın özet JSON listesini döndürür.

---

### 2.7 `doctor` — Sistem Gereksinimleri ve Araç Kontrolü

```bash
ai_bridge.sh doctor
```
- `git`, `codex`, `claude`, `agy` ve `jq` araçlarının sistemde bulunup bulunmadığını, versiyonlarını ve yollarını JSON olarak döner.

Örnek Çıktı:
```json
{
  "git": {
    "available": true,
    "version": "git version 2.53.0.windows.2",
    "path": "C:/Program Files/Git/mingw64/bin/git",
    "auth": "unknown"
  },
  "codex": {
    "available": true,
    "version": "codex-cli 0.155.1",
    "path": "C:/Users/Serqan/AppData/Roaming/npm/codex",
    "auth": "unknown"
  },
  "claude": {
    "available": true,
    "version": "2.1.234 (Claude Code)",
    "path": "C:/Users/Serqan/AppData/Roaming/npm/claude",
    "auth": "unknown"
  },
  "agy": {
    "available": true,
    "version": "1.2.7",
    "path": "C:/Users/Serqan/AppData/Local/agy/bin/agy",
    "auth": "unknown"
  },
  "jq": {
    "available": true,
    "version": "jq-1.8.2",
    "path": "C:/Users/Serqan/AppData/Local/Microsoft/WinGet/Links/jq",
    "auth": "unknown"
  },
  "ready": true
}
```

---

## 3. Electron `child_process.spawn` Entegrasyonu

### 3.1 Windows Üzerinde Çalıştırma (Git Bash)

Windows üzerinde Electron'dan `ai_bridge.sh` başlatılırken Git Bash yürütücüsü kullanılmalıdır:

```typescript
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';

export interface BridgeOptions {
  projectPath: string;
  task: string;
  contextFilePath?: string;
  turns?: number;
  agents?: string[]; // e.g. ['codex', 'claude', 'agy']
  verifyCmd?: string;
  autoApprove?: boolean;
}

export function startBridgeRun(options: BridgeOptions, onEvent: (event: any) => void): ChildProcess {
  const gitBashPath = process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\bin\\bash.exe'
    : 'bash';

  const scriptPath = 'F:/AI-Bridge/ai_bridge.sh'; // veya app.getAppPath() + '/ai_bridge.sh'

  const args: string[] = [
    scriptPath,
    'run',
    '--project', options.projectPath,
    '--task', options.task,
    '--turns', String(options.turns || 3),
    '--agents', (options.agents || ['codex', 'claude', 'agy']).join(','),
    '--json-events'
  ];

  if (options.contextFilePath) {
    args.push('--context-file', options.contextFilePath);
  }
  if (options.verifyCmd) {
    args.push('--verify-cmd', options.verifyCmd);
  }
  if (options.autoApprove) {
    args.push('--auto-approve');
  }

  const child = spawn(gitBashPath, args, {
    cwd: options.projectPath,
    windowsHide: true,
    env: { ...process.env }
  });

  // stdout yalnızca NDJSON üretir
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      onEvent(parsed);
    } catch (err) {
      console.error('NDJSON parse hatası:', line, err);
    }
  });

  // stderr logları ve tanı bilgilerini taşır
  child.stderr.on('data', (data: Buffer) => {
    console.warn('[Bridge Log]:', data.toString());
  });

  return child;
}
```

### 3.2 İptal / Durdurma (Stop Butonu)

Kullanıcı arayüzdeki "Stop" butonuna bastığında:

```typescript
export function stopBridgeRun(child: ChildProcess) {
  if (!child.killed) {
    // Windows Git Bash ortamında SIGINT veya SIGTERM gönderilir.
    // Script trap ile 130 koduyla sonlanır, state atomic olarak 'interrupted' yazılır.
    child.kill('SIGINT');
  }
}
```

---

## 4. NDJSON Event Akışı Şeması (stdout)

`--json-events` parametresi aktif olduğunda standart çıktıya (stdout) yalnızca geçerli NDJSON nesneleri yazılır. Her nesnede şu ortak alanlar bulunur:
```json
{
  "event": "string",
  "timestamp": "ISO-8601 string",
  "run_id": "string"
}
```

### 4.1 Olaylar Kataloğu

#### `preflight_failed`
Repo geçersiz, commit yok veya uncommitted kirli değişiklikler var.
```json
{
  "event": "preflight_failed",
  "timestamp": "2026-09-20T13:40:29Z",
  "run_id": "none",
  "reason": "dirty_repository", // "not_a_git_repo" | "no_initial_commit" | "dirty_repository"
  "message": "Repoda kaydedilmemiş değişiklikler var. Önce commit veya stash yapın."
}
```

#### `run_started`
Çalışma başarıyla başlatıldı ve branch hazırlandı.
```json
{
  "event": "run_started",
  "timestamp": "2026-09-20T13:40:30Z",
  "run_id": "20260920_164029",
  "project": "F:/Project",
  "max_turns": 3,
  "agents": ["codex", "claude", "agy"],
  "auto_branch": true,
  "branch": "ai-bridge/20260920_164029"
}
```

#### `turn_started`
Yeni bir geliştirme döngüsü başladı.
```json
{
  "event": "turn_started",
  "timestamp": "2026-09-20T13:40:30Z",
  "run_id": "20260920_164029",
  "turn": 1,
  "max_turns": 3
}
```

#### `agent_started`
Belirli bir ajan yürütülmeye başladı.
```json
{
  "event": "agent_started",
  "timestamp": "2026-09-20T13:40:30Z",
  "run_id": "20260920_164029",
  "agent": "codex", // "codex" | "claude" | "agy"
  "turn": 1
}
```

#### `agent_action`
Ajan tarafından gerçekleştirilen canlı aksiyon (özellikle Antigravity stream-json modundayken canlı araç kullanımı).
```json
{
  "event": "agent_action",
  "timestamp": "2026-09-20T13:40:32Z",
  "run_id": "20260920_164029",
  "agent": "agy",
  "action": "run_command",
  "description": "pytest -q"
}
```

#### `agent_finished`
Ajanın çalışması tamamlandı.
```json
{
  "event": "agent_finished",
  "timestamp": "2026-09-20T13:40:34Z",
  "run_id": "20260920_164029",
  "agent": "codex",
  "turn": 1,
  "duration_sec": 4,
  "status": "success" // "success" | "failed" | "warning"
}
```

#### `agent_skipped`
Ajan `--agents` filtresi nedeniyle devre dışı bırakıldı.
```json
{
  "event": "agent_skipped",
  "timestamp": "2026-09-20T13:40:35Z",
  "run_id": "20260920_164029",
  "agent": "claude",
  "turn": 1,
  "reason": "agent_disabled"
}
```

#### `review_finished`
Claude Reviewer incelemesini bitirdi.
```json
{
  "event": "review_finished",
  "timestamp": "2026-09-20T13:40:35Z",
  "run_id": "20260920_164029",
  "turn": 1,
  "verdict": "APPROVE", // "APPROVE" | "CHANGES_REQUESTED"
  "blockers": 0,
  "majors": 0,
  "minors": 1,
  "duration_sec": 3
}
```

#### `verification_started` / `verification_finished`
`--verify-cmd` komutunun bağımsız çalışma sonuçları.
```json
{
  "event": "verification_started",
  "timestamp": "2026-09-20T13:40:37Z",
  "run_id": "20260920_164029",
  "turn": 1,
  "command": "pytest -q"
}
```
```json
{
  "event": "verification_finished",
  "timestamp": "2026-09-20T13:40:38Z",
  "run_id": "20260920_164029",
  "turn": 1,
  "status": "passed", // "passed" | "failed"
  "duration_sec": 1
}
```

#### `turn_finished`
Döngü turu tamamlandı.
```json
{
  "event": "turn_finished",
  "timestamp": "2026-09-20T13:40:39Z",
  "run_id": "20260920_164029",
  "turn": 1,
  "verification": "passed",
  "early_exit": true
}
```

#### `decision`
Turlar sonunda alınan nihai karar.
```json
{
  "event": "decision",
  "timestamp": "2026-09-20T13:40:40Z",
  "run_id": "20260920_164029",
  "status": "ready_for_approval",
  "reason": "Görev doğrulandı; kullanıcı onayı bekleniyor."
}
```

#### `run_finished`
Tüm süreç tamamlandı ve süreç sonlandı.
```json
{
  "event": "run_finished",
  "timestamp": "2026-09-20T13:40:40Z",
  "run_id": "20260920_164029",
  "status": "ready_for_approval",
  "duration_sec": 10,
  "exit_code": 0
}
```

---

## 5. Durum Dosyaları Yapısı (.git/ai_bridge/)

Her çalıştırmada `.git/ai_bridge/run_<RUN_ID>/` dizini altında durum dosyaları tutulur:

### 5.1 `state.json` (Atomic Updates)
Her aşamada geçici bir `.tmp` dosyasına yazılıp `mv -f` ile atomik olarak güncellenir. GUI, `ai_bridge.sh status` veya dosya izleyici (fs watcher) ile anlık durumu güvenle okuyabilir.

```json
{
  "run_id": "20260920_164029",
  "status": "ready_for_approval",
  "current_turn": 1,
  "max_turns": 3,
  "current_agent": "none",
  "verification": "passed",
  "decision": "ready_for_approval",
  "decision_reason": "Görev doğrulandı; kullanıcı onayı bekleniyor.",
  "branch": "ai-bridge/20260920_164029",
  "base_head": "d544f95daccc59a721b7a9f5dc459b02829a56e7",
  "warnings": 0,
  "updated_at": "2026-09-20T13:40:40Z"
}
```

### 5.2 `final_report.json`
Çalışma tamamlandığında oluşturulan kapsamlı rapor.

```json
{
  "run_id": "20260920_164029",
  "decision": "ready_for_approval",
  "decision_title": "Görev Doğrulandı — Kullanıcı Onayı Bekleniyor",
  "decision_reasons": [
    "Görev başarıyla doğrulandı.",
    "Doğrulama kaynağı: Antigravity verification=passed"
  ],
  "branch": "ai-bridge/20260920_164029",
  "base_head": "d544f95daccc59a721b7a9f5dc459b02829a56e7",
  "turns_executed": 1,
  "max_turns": 3,
  "changes": {
    "files_changed": 1,
    "lines_added": 2,
    "lines_deleted": 0,
    "untracked_files_count": 0,
    "files": [
      "src/index.js"
    ]
  },
  "duration": {
    "total_sec": 14,
    "codex_sec": 4,
    "claude_sec": 3,
    "agy_sec": 5,
    "verify_sec": 1
  },
  "agents": {
    "codex": { "executed": true, "duration_sec": 4, "rc": 0 },
    "claude": { "executed": true, "duration_sec": 3, "rc": 0, "verdict": "APPROVE" },
    "agy": { "executed": true, "duration_sec": 5, "rc": 0, "status": "SUCCESS" }
  },
  "verification": {
    "source": "agy",
    "status": "passed",
    "command": "pytest -q"
  },
  "started_at": "2026-09-20T13:40:26Z",
  "finished_at": "2026-09-20T13:40:40Z"
}
```

### 5.3 `fingerprint.json`
`accept` ve `rollback` komutları için güvenlik doğrulaması sağlar:
```json
{
  "run_id": "20260920_164029",
  "created_at": "2026-09-20T13:40:40Z",
  "branch": "ai-bridge/20260920_164029",
  "head": "d544f95daccc59a721b7a9f5dc459b02829a56e7",
  "files": [
    { "path": "README.md", "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
  ]
}
```

---

## 6. Karar Matrisi ve Çıkış Kodları (Exit Codes)

| Durum (`decision`) | Açıklama | Çıkış Kodu | GUI UI Davranışı |
|---|---|:---:|---|
| `approved` | `--auto-approve` açık ve doğrulama geçti. | `0` | Başarı rozeti gösterilir. Kod zaten birleştirilmiştir. |
| `ready_for_approval` | Doğrulama geçti, kullanıcı onayı bekleniyor. | `0` | "Accept" ve "Rollback" butonları aktif edilir. Diff gösterilir. |
| `needs_manual_verification` | Antigravity kapalı ve `--verify-cmd` yok. | `0` | "Manuel test edin" uyarısı gösterilir; "Accept" ve "Rollback" aktif edilir. |
| `blocked` | Güvenlik kuralı ihlali, izin verilmeyen eylem (`denied_actions`) veya branch tampering. | `1` | Kırmızı hata kutusu açılır, engellenen işlemler listelenir. "Rollback" aktif edilir. |
| `max_turns` | Belirlenen tur sınırına ulaşıldı ancak doğrulanamadı. | `2` | Sarı uyarı; "Tekrar dene" veya "Rollback" seçenekleri sunulur. |
| `interrupted` | Kullanıcı Stop butonuna bastı (SIGINT/SIGTERM). | `130` | "İptal edildi" bildirimi gösterilir. "Rollback" aktif edilir. |
| `failed` | Kritik hata, 2 kez üst üste bozuk JSON veya komut çökmesi. | `1` | Kırmızı hata raporu ve stack trace gösterilir. |

---

## 7. Güvenlik ve Bütünlük Protokolü

1. **Pre-flight Kontrolü:** Çalışma başlamadan önce deponun temiz (`git status --porcelain` boş) olması ve en az 1 commit içermesi zorunludur.
2. **İzole Branching:** Varsayılan olarak tüm ajan çalışmaları `ai-bridge/<TIMESTAMP>` branch'inde yürütülür. Kullanıcının aktif çalıştığı branch doğrudan değiştirilmez.
3. **Branch/HEAD Guard:** Her ajanın yürütülmesinden sonra `git rev-parse HEAD` ve `symbolic-ref` kontrol edilir. Ajan yetkisiz checkout, rebase veya branch değiştirme yaparsa işlem anında durdurulur (`blocked`).
4. **Index Değiştirmeyen Diff Hesaplama:** Yeni eklenen (untracked) dosyalar Git indeksine (`git add`) eklenmeden doğrudan SHA-256 ve satır sayımı ile tespit edilir.
5. **Fingerprint Koruması:** `accept` ve `rollback` çağrıldığında, çalışma bittikten sonra harici bir programın veya kullanıcının dosyaları değiştirip değiştirmediği `fingerprint.json` ile kontrol edilir. Mismatch durumunda dosya kaybını önlemek için işlem derhal reddedilir.
6. **Sıfır `eval` Güvencesi:** Hiçbir kullanıcı girdisi veya log verisi `eval` fonksiyonuyla çalıştırılmaz.
