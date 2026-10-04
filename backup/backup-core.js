/* ══════════════════════════════════════════════════════════════════════
   トレカル バックアップコア（backup-core.js）
   ----------------------------------------------------------------------
   JSONデータ引き継ぎ（エクスポート/インポート＋暗号化）の「純粋ロジック」を
   m.html から分離した単一モジュール。DOM・IndexedDB・グローバル状態 S を一切
   触らない（入力 → 変換/検証/計算 → 出力 だけ）＝単体テスト可能。

   ・ブラウザ: <script src> で読み込むと window.TBackup に名前空間として公開。
   ・Node: require('./backup/backup-core.js') で全APIを取得（tests/ から検証）。

   設計書: docs/specs/2026-10-04-data-portability-backup-design.md
   ⚠ ファサード読み書き・DOM・プレビューUI は m.html 側の薄いラッパが担う。
     ここは「normalized data（下記 SECTION_KEYS 形）」だけを扱う。
   ══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; return; } // Node
  root.TBackup = api;                                                                 // ブラウザ
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var APP_ID = 'torecal';
  var SCHEMA_VERSION = '2.0';
  var ENC_FORMAT = 'torecal-enc';
  var PBKDF2_ITER = 210000;
  var MAX_FILE_BYTES = 80 * 1024 * 1024; // 80MB（写真base64同梱を考慮した安全上限）

  // normalized data のセクション（この順で網羅）。
  var SECTION_KEYS = [
    'customers', 'training', 'sessions', 'schedule', 'customEx', 'drafts',
    'photos', 'notes', 'exCustom', 'menus', 'menuUse', 'customCats',
    'karte', 'consent', 'analysis', 'brand', 'settings'
  ];
  // 顧客「氏名」をキー/属性に持つ＝顧客リネーム時に remap が必要なセクション。
  var PER_CLIENT_DICT = ['training', 'sessions', 'drafts', 'photos', 'notes', 'exCustom', 'karte', 'consent', 'analysis'];
  var PER_CLIENT_ARRAY_CLIENTFIELD = ['schedule', 'menus']; // 配列・各要素の .client が氏名

  // 旧フラット形式（schema_version 無し）の特殊キー → normalized セクション
  var LEGACY_MAP = {
    __training_v1: 'training', __sessions_v1: 'sessions', __schedule_v1: 'schedule',
    __custom_ex_v1: 'customEx', __drafts_v1: 'drafts', __photos_v1: 'photos',
    __notes_v1: 'notes', __ex_custom_v1: 'exCustom'
  };

  /* ── 小物 ── */
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function uid() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function emptyData() {
    var d = {};
    SECTION_KEYS.forEach(function (k) {
      d[k] = (k === 'schedule' || k === 'customEx' || k === 'menus' || k === 'customCats') ? [] : {};
    });
    return d;
  }
  // 深いクローン（JSON安全な素データのみ扱う前提）。
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

  /* ════════ エンベロープ生成 ════════ */
  function buildEnvelope(data, meta) {
    meta = meta || {};
    return {
      app: APP_ID,
      schema_version: SCHEMA_VERSION,
      exported_at: meta.exportedAt || new Date().toISOString(),
      data: data
    };
  }

  /* ════════ 形式判定 ════════ */
  // 'enveloped' | 'encrypted' | 'legacy-flat' | 'invalid'
  function detectFormat(parsed) {
    if (!isObj(parsed)) return 'invalid';
    if (parsed.format === ENC_FORMAT && parsed.ct && parsed.salt && parsed.iv) return 'encrypted';
    if (parsed.app === APP_ID && parsed.schema_version && isObj(parsed.data)) return 'enveloped';
    // 旧フラット: 顧客 dict（__キーや素の顧客オブジェクト）
    var keys = Object.keys(parsed);
    if (!keys.length) return 'legacy-flat'; // 空も旧形式として受ける（＝空バックアップ）
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], v = parsed[k];
      if (LEGACY_MAP[k]) return 'legacy-flat';
      if (isObj(v) && ('records' in v || 'goal' in v || 'gender' in v || 'dob' in v || 'name' in v)) return 'legacy-flat';
    }
    return 'invalid';
  }

  /* ════════ マイグレーション → normalized ════════ */
  // enveloped / legacy-flat のどちらからも 2.0 normalized を返す。副作用なし。
  function migrate(parsed) {
    var fmt = detectFormat(parsed);
    if (fmt === 'enveloped') return migrateEnveloped(parsed);
    if (fmt === 'legacy-flat') return migrateLegacyFlat(parsed);
    throw new Error('対応していないファイル形式です');
  }

  function migrateEnveloped(parsed) {
    if (parsed.schema_version && cmpVersion(parsed.schema_version, SCHEMA_VERSION) > 0) {
      throw new Error('このバックアップは新しいバージョンで作られています（アプリを更新してください）');
    }
    var out = emptyData();
    var d = parsed.data || {};
    SECTION_KEYS.forEach(function (k) { if (d[k] != null) out[k] = clone(d[k]); });
    return { schemaVersion: parsed.schema_version || SCHEMA_VERSION, exportedAt: parsed.exported_at || null, data: normalizeShapes(out) };
  }

  function migrateLegacyFlat(parsed) {
    var out = emptyData();
    var customers = {};
    Object.keys(parsed).forEach(function (k) {
      if (k === '__plans_v1') {
        // 旧 plans → schedule 配列へ畳み込み
        var pl = parsed[k];
        if (isObj(pl)) Object.keys(pl).forEach(function (nm) {
          var p = pl[nm];
          if (isObj(p)) out.schedule.push(Object.assign({}, p, { client: nm, date: p.date || '' }));
        });
        return;
      }
      if (LEGACY_MAP[k]) { out[LEGACY_MAP[k]] = clone(parsed[k]); return; }
      // それ以外 = 顧客（氏名キー）
      var v = parsed[k];
      if (isObj(v) && (v.name || 'records' in v || 'goal' in v)) customers[k] = clone(v);
    });
    out.customers = customers;
    return { schemaVersion: '1.0', exportedAt: null, data: normalizeShapes(out) };
  }

  // セクションの型をあるべき形（dict/array）へ寄せる（壊れ値を安全に無視）。
  function normalizeShapes(d) {
    SECTION_KEYS.forEach(function (k) {
      var wantArray = (k === 'schedule' || k === 'customEx' || k === 'menus' || k === 'customCats');
      if (wantArray) { if (!Array.isArray(d[k])) d[k] = []; }
      else { if (!isObj(d[k])) d[k] = {}; }
    });
    // customers: 各 customer の records を配列化・name を補完
    Object.keys(d.customers).forEach(function (nm) {
      var c = d.customers[nm];
      if (!isObj(c)) { delete d.customers[nm]; return; }
      if (!Array.isArray(c.records)) c.records = [];
      if (!c.name) c.name = nm;
    });
    return d;
  }

  function cmpVersion(a, b) {
    var pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /* ════════ 顧客ID backfill ════════ */
  // customers dict の各顧客に id を付与（既存は維持）。副作用なし＝新 dict を返す。
  function ensureIds(customers) {
    var out = {}; if (!isObj(customers)) return out;
    Object.keys(customers).forEach(function (nm) {
      var c = clone(customers[nm]) || {};
      if (!c.id) c.id = uid();
      if (!c.name) c.name = nm;
      out[nm] = c;
    });
    return out;
  }

  /* ════════ 検証 ════════ */
  function validateNormalized(norm) {
    var errors = [];
    if (!norm || !isObj(norm.data)) { return { ok: false, errors: ['データ本体がありません'], counts: zeroCounts() }; }
    var d = norm.data;
    if (!isObj(d.customers)) errors.push('顧客データの形式が不正です');
    // 参照整合（軽量）: per-client dict のキーが customers に存在するか（存在しなくても取込は可＝孤児は無害だが数える）
    var counts = countData(d);
    return { ok: errors.length === 0, errors: errors, counts: counts, exportedAt: norm.exportedAt || null, schemaVersion: norm.schemaVersion || null };
  }

  function zeroCounts() { return { clients: 0, bodyRecords: 0, trainingRecords: 0, sessions: 0, photos: 0, menus: 0, karte: 0, consent: 0 }; }
  function countData(d) {
    var c = zeroCounts();
    var cs = d.customers || {};
    c.clients = Object.keys(cs).length;
    Object.keys(cs).forEach(function (nm) { c.bodyRecords += (Array.isArray(cs[nm].records) ? cs[nm].records.length : 0); });
    c.trainingRecords = sumDictArray(d.training);
    c.sessions = sumDictArray(d.sessions);
    c.photos = sumDictArray(d.photos);
    c.menus = Array.isArray(d.menus) ? d.menus.length : 0;
    c.karte = isObj(d.karte) ? Object.keys(d.karte).length : 0;
    c.consent = isObj(d.consent) ? Object.keys(d.consent).length : 0;
    return c;
  }
  function sumDictArray(dict) {
    if (!isObj(dict)) return 0; var n = 0;
    Object.keys(dict).forEach(function (k) { if (Array.isArray(dict[k])) n += dict[k].length; });
    return n;
  }

  /* ════════ インポート計画（純粋・ID基準） ════════ */
  // existingData / incomingData は normalized.data（customers は id 付き想定）。
  // mode: 'replace' | 'merge'。planLimit: number（Infinity 可）。
  function computeImportPlan(existingData, incomingData, mode, planLimit) {
    if (planLimit == null) planLimit = Infinity;
    var exCust = (existingData && existingData.customers) || {};
    var inCust = (incomingData && incomingData.customers) || {};
    var counts = countData(incomingData || { customers: {} });
    var warnings = [];
    var nameRemap = {};      // incomingName -> finalName（per-client セクション remap 用）
    var mergeTargets = {};   // incomingName -> existingName（同一人物＝マージ先）
    var newNames = [];
    var resultingClientCount;

    if (mode === 'replace') {
      resultingClientCount = counts.clients;
    } else {
      // merge: 既存 id→name、既存 name セット
      var exIdToName = {}, exNames = {};
      Object.keys(exCust).forEach(function (nm) { exNames[nm] = true; var id = exCust[nm] && exCust[nm].id; if (id) exIdToName[id] = nm; });
      var takenNames = Object.assign({}, exNames); // 衝突判定用（既存＋この取込で確定した名前）
      var newCount = 0;
      Object.keys(inCust).forEach(function (nm) {
        var c = inCust[nm] || {};
        var id = c.id;
        var target = null;
        if (id && exIdToName[id]) target = exIdToName[id];       // ① id一致＝同一人物（v2.0）
        else if (!id && exNames[nm]) target = nm;                // ② 旧backup(id無)のみ氏名で一致＝レガシー救済
        if (target) {
          // 同一人物 → 既存名へマージ（既存の氏名キーに寄せる＝参照を壊さない）
          mergeTargets[nm] = target;
          if (target !== nm) nameRemap[nm] = target;
        } else {
          // 新規人物。氏名が既存/確定済みと衝突するなら別名に（同名＝同一人物にしない §7）
          var finalName = nm, suffix = 2;
          while (takenNames[finalName]) {
            if (exNames[nm] && exCust[nm] && exCust[nm].id !== id) warnings.push('同名の別クライアント「' + nm + '」を別人として追加します');
            finalName = nm + ' (' + suffix + ')'; suffix++;
          }
          takenNames[finalName] = true;
          if (finalName !== nm) nameRemap[nm] = finalName;
          newNames.push(finalName);
          newCount++;
        }
      });
      resultingClientCount = Object.keys(exCust).length + newCount;
    }

    var blockedByLimit = isFinite(planLimit) && resultingClientCount > planLimit;
    return {
      mode: mode, resultingClientCount: resultingClientCount, limit: planLimit,
      blockedByLimit: blockedByLimit, nameRemap: nameRemap,
      mergeTargets: mergeTargets, idMatches: mergeTargets,   // idMatches は後方互換エイリアス
      newNames: newNames, counts: counts, warnings: warnings
    };
  }

  /* ════════ インポート適用（純粋変換） ════════ */
  // plan に従い existingData に incomingData を反映した「新 normalized data」を返す。
  // 副作用なし（呼び出し側がファサードへ書き戻す）。失敗時は呼び出し側がスナップショットで復旧。
  function applyImport(existingData, incomingData, plan) {
    var incoming = remapIncoming(incomingData, plan.nameRemap);
    if (plan.mode === 'replace') {
      // 全置換（incoming をそのまま・顧客 id 保証）
      var repl = clone(incoming);
      repl.customers = ensureIds(repl.customers);
      return fillSections(repl);
    }
    // merge
    var out = clone(existingData) || emptyData();
    out = fillSections(out);
    out.customers = ensureIds(out.customers);
    var mergeTargets = plan.mergeTargets || plan.idMatches || {};

    // 顧客（plan に従う：マージ先ありは統合、無ければ新規追加）。元の incoming 名で判定。
    Object.keys(incomingData.customers || {}).forEach(function (origName) {
      var finalName = (plan.nameRemap && plan.nameRemap[origName]) || origName;
      var inc = incoming.customers[finalName];
      if (!inc) return;
      if (mergeTargets[origName]) {
        out.customers[finalName] = mergeCustomer(out.customers[finalName] || {}, inc);
      } else {
        out.customers[finalName] = inc.id ? inc : Object.assign({ id: uid() }, inc);
      }
    });

    // per-client dict セクション（id でマージ／単一オブジェクトは既存優先）
    PER_CLIENT_DICT.forEach(function (sec) {
      var dst = out[sec] || {}, src = incoming[sec] || {};
      Object.keys(src).forEach(function (nm) {
        dst[nm] = mergeSection(sec, dst[nm], src[nm]);
      });
      out[sec] = dst;
    });
    // schedule / menus（配列・client 属性）: id or (client+date) で dedupe
    out.schedule = mergeArrayBy(out.schedule, incoming.schedule, function (x) { return (x.client || '') + '|' + (x.date || ''); });
    out.menus = mergeArrayBy(out.menus, incoming.menus, function (x) { return x.id || ((x.client || '') + '|' + (x.name || '')); });
    // グローバル配列: customEx / customCats（name で dedupe）
    out.customEx = mergeArrayBy(out.customEx, incoming.customEx, function (x) { return x && x.name; });
    out.customCats = mergeArrayBy(out.customCats, incoming.customCats, function (x) { return x && x.name; });
    // menuUse（dict・新しい日時を優先）
    out.menuUse = mergeMenuUse(out.menuUse, incoming.menuUse);
    // brand / settings: 既存を優先しつつ欠損を補完（契約状態等は元々含まれない）
    out.brand = Object.assign({}, incoming.brand || {}, out.brand || {});
    out.settings = Object.assign({}, incoming.settings || {}, out.settings || {});
    return out;
  }

  function fillSections(d) { var e = emptyData(); SECTION_KEYS.forEach(function (k) { if (d[k] == null) d[k] = e[k]; }); return d; }

  // incoming の per-client 氏名を nameRemap で付け替え（参照整合）。副作用なし。
  function remapIncoming(incomingData, nameRemap) {
    var inc = clone(incomingData) || emptyData();
    inc = fillSections(inc);
    if (!nameRemap || !Object.keys(nameRemap).length) return inc;
    var map = function (nm) { return nameRemap[nm] || nm; };
    // customers dict のキー＆ name
    var nc = {};
    Object.keys(inc.customers).forEach(function (nm) { var c = inc.customers[nm]; var fn = map(nm); c.name = fn; nc[fn] = c; });
    inc.customers = nc;
    // per-client dict
    PER_CLIENT_DICT.forEach(function (sec) {
      var src = inc[sec] || {}, dst = {};
      Object.keys(src).forEach(function (nm) { dst[map(nm)] = src[nm]; });
      inc[sec] = dst;
    });
    // 配列（client 属性）
    PER_CLIENT_ARRAY_CLIENTFIELD.forEach(function (sec) {
      (inc[sec] || []).forEach(function (x) { if (x && x.client != null) x.client = map(x.client); });
    });
    return inc;
  }

  function mergeCustomer(existing, incoming) {
    var out = clone(existing);
    // records: 測定日で dedupe（取込を優先）
    var byDate = {};
    (Array.isArray(out.records) ? out.records : []).forEach(function (r) { if (r && r.date) byDate[r.date] = r; });
    (Array.isArray(incoming.records) ? incoming.records : []).forEach(function (r) { if (r && r.date) byDate[r.date] = r; });
    out.records = Object.keys(byDate).map(function (k) { return byDate[k]; }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    // プロフィール欠損の補完（既存優先）
    ['gender', 'dob', 'age', 'height', 'goal', 'goalType', 'kana'].forEach(function (k) {
      if ((out[k] == null || out[k] === '') && incoming[k] != null) out[k] = incoming[k];
    });
    return out;
  }

  function mergeSection(sec, dst, src) {
    if (sec === 'analysis') {
      // {draft, history[]} : history を id dedupe・既存 draft 維持
      var o = isObj(dst) ? clone(dst) : { draft: null, history: [] };
      if (!Array.isArray(o.history)) o.history = [];
      var sh = (isObj(src) && Array.isArray(src.history)) ? src.history : [];
      o.history = dedupeById(o.history.concat(sh));
      if (o.draft == null && isObj(src)) o.draft = src.draft || null;
      return o;
    }
    if (sec === 'karte' || sec === 'consent') {
      // 単一オブジェクト: 既存優先、無ければ取込で補完
      return isObj(dst) ? dst : (isObj(src) ? clone(src) : dst);
    }
    if (sec === 'drafts') {
      // 下書き: 既存優先（未完了入力を取込で壊さない）、無ければ取込
      return (dst != null) ? dst : (src != null ? clone(src) : dst);
    }
    if (sec === 'exCustom') {
      // 顧客別 種目カスタム（dict）: 浅いマージ
      return Object.assign({}, isObj(src) ? src : {}, isObj(dst) ? dst : {});
    }
    // training / sessions / notes / photos : 配列・id で dedupe
    var a = Array.isArray(dst) ? dst : [];
    var b = Array.isArray(src) ? src : [];
    var merged = dedupeById(a.concat(b));
    if (sec === 'sessions' || sec === 'photos') merged.sort(function (x, y) { return String(y.date || '').localeCompare(String(x.date || '')); });
    return merged;
  }

  function dedupeById(arr) {
    var byId = {}, noId = [];
    (arr || []).forEach(function (x) { if (x && x.id != null) byId[x.id] = x; else if (x) noId.push(x); });
    return Object.keys(byId).map(function (k) { return byId[k]; }).concat(noId);
  }
  function mergeArrayBy(dst, src, keyFn) {
    var map = {}, order = [];
    (Array.isArray(dst) ? dst : []).concat(Array.isArray(src) ? src : []).forEach(function (x) {
      var k = keyFn(x); if (k == null || k === '') { order.push({ k: Symbol(), v: x }); return; }
      if (!(k in map)) order.push({ k: k, v: null }); map[k] = x;
    });
    return order.map(function (o) { return typeof o.k === 'symbol' ? o.v : map[o.k]; });
  }
  function mergeMenuUse(dst, src) {
    var o = Object.assign({}, isObj(dst) ? dst : {});
    if (isObj(src)) Object.keys(src).forEach(function (k) {
      var a = +o[k] || 0, b = +src[k] || 0; o[k] = Math.max(a, b);
    });
    return o;
  }

  /* ════════ 暗号化（Web Crypto・Node/ブラウザ両対応） ════════ */
  function getSubtle() {
    var c = (typeof crypto !== 'undefined') ? crypto : (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (!c || !c.subtle) throw new Error('この環境では暗号化を利用できません');
    return c;
  }
  function u8ToB64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s);
  }
  function b64ToU8(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    var s = atob(b64), u8 = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8;
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function fromUtf8(u8) { return new TextDecoder().decode(u8); }

  function deriveKey(password, saltU8) {
    var c = getSubtle();
    return c.subtle.importKey('raw', utf8(String(password)), { name: 'PBKDF2' }, false, ['deriveKey'])
      .then(function (baseKey) {
        return c.subtle.deriveKey(
          { name: 'PBKDF2', salt: saltU8, iterations: PBKDF2_ITER, hash: 'SHA-256' },
          baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  // plainString（JSON文字列）→ .torecal エンベロープ（パスワードは保存しない）
  function encryptBackup(plainString, password, meta) {
    meta = meta || {};
    if (!password) return Promise.reject(new Error('パスワードを入力してください'));
    var c = getSubtle();
    var salt = c.getRandomValues(new Uint8Array(16));
    var iv = c.getRandomValues(new Uint8Array(12));
    return deriveKey(password, salt).then(function (key) {
      return c.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, utf8(plainString));
    }).then(function (ctBuf) {
      return {
        app: APP_ID, format: ENC_FORMAT, enc: 'AES-256-GCM', kdf: 'PBKDF2-SHA256',
        iter: PBKDF2_ITER, salt: u8ToB64(salt), iv: u8ToB64(iv), ct: u8ToB64(new Uint8Array(ctBuf)),
        schema_version: SCHEMA_VERSION, exported_at: meta.exportedAt || new Date().toISOString()
      };
    });
  }

  // .torecal エンベロープ＋パスワード → 復号した JSON 文字列。失敗時は reject（データ無変更は呼び出し側で担保）。
  function decryptBackup(encObj, password) {
    if (!isObj(encObj) || encObj.format !== ENC_FORMAT) return Promise.reject(new Error('暗号化バックアップの形式が不正です'));
    if (!password) return Promise.reject(new Error('パスワードを入力してください'));
    var c = getSubtle();
    var salt, iv, ct;
    try { salt = b64ToU8(encObj.salt); iv = b64ToU8(encObj.iv); ct = b64ToU8(encObj.ct); }
    catch (_) { return Promise.reject(new Error('暗号化バックアップが壊れています')); }
    return deriveKey(password, salt).then(function (key) {
      return c.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    }).then(function (buf) {
      return fromUtf8(new Uint8Array(buf));
    }).catch(function () {
      // 認証タグ不一致＝誤パスワード/改ざん。中身はログに出さない。
      throw new Error('パスワードが違うか、ファイルが壊れています');
    });
  }

  function backupFilename(ext, date) {
    var d = date || new Date();
    var y = d.getFullYear(), m = ('0' + (d.getMonth() + 1)).slice(-2), day = ('0' + d.getDate()).slice(-2);
    return 'torecal_backup_' + y + m + day + '.' + (ext || 'json');
  }

  return {
    APP_ID: APP_ID, SCHEMA_VERSION: SCHEMA_VERSION, ENC_FORMAT: ENC_FORMAT,
    SECTION_KEYS: SECTION_KEYS, PER_CLIENT_DICT: PER_CLIENT_DICT, MAX_FILE_BYTES: MAX_FILE_BYTES,
    emptyData: emptyData, buildEnvelope: buildEnvelope, detectFormat: detectFormat,
    migrate: migrate, normalizeShapes: normalizeShapes, ensureIds: ensureIds,
    validateNormalized: validateNormalized, countData: countData,
    computeImportPlan: computeImportPlan, applyImport: applyImport, remapIncoming: remapIncoming,
    encryptBackup: encryptBackup, decryptBackup: decryptBackup, deriveKey: deriveKey,
    backupFilename: backupFilename, cmpVersion: cmpVersion
  };
});
