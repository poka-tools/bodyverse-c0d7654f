/* ══════════════════════════════════════════════════════════════════════
   トレカル 分析コア（analysis-core.js）  ── Phase 1 リファクタリング
   ----------------------------------------------------------------------
   体組成・目標に関する「純粋な計算・判定ロジック」を m.html から分離した
   単一モジュール。DOM操作・IndexedDBアクセス・グローバル状態(S)を一切含まない
   （入力 → 計算 → 結果 だけ）＝単体テスト可能。

   ・ブラウザ: <script src> で読み込むと、各関数・定数を global へ公開する
     （m.html は従来どおり素の名前 bmiOf(...) 等で参照できる）。加えて
     window.TCore に名前空間としても公開。
   ・Node: require('./analysis/analysis-core.js') で全関数・定数を取得できる
     （tests/ から単体テスト）。

   ⚠ ここに書く関数は「純粋関数」に保つこと（DOM/DB/S を触らない）。
     状態(S.bodyRange 等)は m.html 側の薄いラッパで注入する
     （例: bodyAutoAnalysis は m.html が S.bodyRange を渡す）。
   ══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; return; } // Node
  root.TCore = api;                                   // ブラウザ: 名前空間
  Object.keys(api).forEach(function (k) {
    if (k === 'bodyAutoAnalysis') return;             // 状態注入は m.html のラッパが担う
    root[k] = api[k];                                 // 素の global へ公開（従来の呼び出しをそのまま維持）
  });
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ──────── マスタ定数（分析ドメイン） ──────── */
  /* クライアントの目的（ゴール種別）。クライアント作成時に選択し、体組成分析の評価に使う。 */
  const GOAL_TYPES = [
    { key: 'diet', lbl: '減量', metric: 'weight', dir: 'down', desc: '体重を減らす' },
    { key: 'fatloss', lbl: '体脂肪減量', metric: 'bodyFatPct', dir: 'down', desc: '体脂肪を落とす' },
    { key: 'strength', lbl: '筋力アップ', metric: 'muscleMass', dir: 'up', desc: '骨格筋率を上げる' },
    { key: 'bulk', lbl: '増量', metric: 'weight', dir: 'up', desc: '体重・筋肉を増やす' },
    { key: 'maintain', lbl: '現状維持', metric: 'weight', dir: 'flat', desc: '今の状態をキープ' },
  ];
  /* metric meta: dir = which direction is "good" (down/up) */
  const METRICS = {
    weight: { lbl: '体重', unit: 'kg', dir: 'down', d: 1 },
    bodyFatPct: { lbl: '体脂肪率', unit: '%', dir: 'down', d: 1 },
    muscleMass: { lbl: '骨格筋率', unit: '%', dir: 'up', d: 1 },
  };
  const RANGE_LABELS = { '1m': '1ヶ月', '3m': '3ヶ月', '6m': '6ヶ月', '1y': '1年' };

  /* ──────── 純粋util（並べ替え・期間フィルタ） ──────── */
  const sorted = c => [...(c.records || [])].sort((a, b) => b.date.localeCompare(a.date)); // newest first
  const asc = c => [...(c.records || [])].sort((a, b) => a.date.localeCompare(b.date));     // oldest first
  function rangeLabel(k) { return RANGE_LABELS[k] || '3ヶ月'; }
  function rangeFilter(a, range) {
    if (range === 'all' || !a.length) return a;
    const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[range]; if (!months) return a;
    const last = new Date(a[a.length - 1].date); const cut = new Date(last.getFullYear(), last.getMonth() - months + 1, 1);
    return a.filter(r => new Date(r.date) >= cut);
  }

  /* ──────── 単指標の計算 ──────── */
  const bmiOf = r => r.bmi != null ? +r.bmi : (r.height && r.weight ? +(r.weight / Math.pow(r.height / 100, 2)).toFixed(1) : null);
  /* 推定体脂肪量(kg) = 体重 × 体脂肪率/100。体重が減っても体脂肪率が上がるケースで「脂肪量そのもの」の増減を見る指標。 */
  const fatMassOf = r => (r && r.weight != null && r.weight !== '' && r.bodyFatPct != null && r.bodyFatPct !== '' && !isNaN(+r.weight) && !isNaN(+r.bodyFatPct)) ? +(+r.weight * +r.bodyFatPct / 100).toFixed(1) : null;
  const muscleMassKgOf = r => r.weight != null && r.muscleMass != null ? +(r.weight * r.muscleMass / 100).toFixed(1) : null; // 筋肉量 kg（骨格筋率×体重）

  /* 生年月日(YYYY-MM-DD)→ 現在日時基準の年齢。時間が経てば自動で上がる（保存し直し不要）。 */
  function ageFromDob(dob) {
    if (!dob) return null; const b = new Date(dob); if (isNaN(b)) return null;
    const t = new Date(); let a = t.getFullYear() - b.getFullYear();
    const m = t.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
    return (a >= 0 && a < 150) ? a : null;
  }
  /* 表示用の年齢：生年月日があれば自動計算を優先、無ければ手入力のageにフォールバック。 */
  function custAge(c) { if (!c) return null; const a = ageFromDob(c.dob); return a != null ? a : (c.age != null ? c.age : null); }

  /* ──────── 増減の判定（色クラス・矢印） ──────── */
  function deltaClass(key, diff) {
    if (diff == null || Math.abs(diff) < 0.05) return ['flat', '→'];
    const good = METRICS[key]?.dir === 'down' ? diff < 0 : diff > 0;
    return [good ? 'up' : 'down', (diff > 0 ? '▲' : '▼')];
  }
  function deltaInfo(diff, dir) {
    if (diff == null || Math.abs(diff) < 0.05) return ['flat', '→'];
    const good = dir === 'down' ? diff < 0 : diff > 0; return [good ? 'up' : 'down', diff > 0 ? '▲' : '▼'];
  }

  /* ──────── 目標・目的の判定 ──────── */
  const goalTypeOf = c => GOAL_TYPES.find(g => g.key === (c && c.goalType)) || null;
  /* 目的に対する3段階評価（順調 / あと一歩 / 要確認）。deltas=期間の変化量。医学的断定はしない。 */
  function goalVerdict(gt, deltas) {
    const TH = { weight: 0.5, bodyFatPct: 0.5, muscleMass: 0.3 };
    const near = `目的（${gt.lbl}）に向けて順調です。同じ条件で測定を続け、推移を確認しましょう。`;
    const mid = `目的（${gt.lbl}）への変化はゆるやかです。食事・運動・生活習慣のうち改善しやすい点から見直すと変化が出やすくなります。`;
    const warn = `目的（${gt.lbl}）とは逆の方向に動いています。原因分析で要因を整理し、次回の指導に活かしましょう。`;
    if (gt.dir === 'flat') {   // 現状維持＝主要3指標がどれだけ動いたか
      const drift = Math.max(Math.abs(deltas.wD || 0) / TH.weight, Math.abs(deltas.bfD || 0) / TH.bodyFatPct, Math.abs(deltas.mmD || 0) / TH.muscleMass);
      if (drift <= 1) return { level: 'ok', label: '順調', caution: near };
      if (drift <= 2) return { level: 'mid', label: 'あと一歩', caution: `目的（${gt.lbl}）に対し、数値がやや動いています。無理のない範囲で今の生活リズムを保ちましょう。` };
      return { level: 'warn', label: '要確認', caution: `目的（${gt.lbl}）に対し数値の変動が大きめです。原因分析で要因を整理しましょう。` };
    }
    const map = { weight: deltas.wD, bodyFatPct: deltas.bfD, muscleMass: deltas.mmD };
    const d = map[gt.metric], t = TH[gt.metric];
    if (d == null) return { level: 'mid', label: 'あと一歩', caution: mid };
    const signed = d * (gt.dir === 'down' ? -1 : 1);   // 正＝目的の方向に進んでいる
    if (signed >= t) return { level: 'ok', label: '順調', caution: near };
    if (signed <= -t) return { level: 'warn', label: '要確認', caution: warn };
    return { level: 'mid', label: 'あと一歩', caution: mid };
  }

  /* ──────── 目標到達率 ──────── */
  /* goal progress: baseline(first)→latest に対する目標到達率 */
  function metricProgress(first, latest, goal, key) {
    if (first == null || latest == null || goal == null) return null;
    const denom = goal - first; if (Math.abs(denom) < 1e-6) return latest === goal ? 100 : 0;
    let p = (latest - first) / denom * 100; return Math.max(0, Math.min(100, Math.round(p)));
  }
  function overallProgress(c) {
    const a = asc(c); if (!a.length || !c.goal) return null;
    const first = a[0], latest = a[a.length - 1]; let sum = 0, n = 0;
    for (const k of ['weight', 'bodyFatPct', 'muscleMass']) {
      if (c.goal[k] == null) continue;
      const p = metricProgress(first[k], latest[k], c.goal[k], k);
      if (p != null) { sum += p; n++; }
    }
    return n ? { pct: Math.round(sum / n), n } : null;
  }

  /* ──────── 総合スコア ──────── */
  function bodyverseScore(c) {
    const r = sorted(c)[0]; if (!r) return null;
    const clamp = v => Math.max(0, Math.min(100, v));
    let sc = null;
    if (r.muscleMass != null && r.bodyFatPct != null) {
      const muscle = clamp((r.muscleMass - 25) / (45 - 25) * 100), fat = clamp((30 - r.bodyFatPct) / (30 - 10) * 100);
      sc = (muscle + fat) / 2;
    }
    const op = overallProgress(c);
    if (op) sc = sc != null ? sc * 0.6 + op.pct * 0.4 : op.pct;
    return sc != null ? Math.round(sc) : null;
  }

  /* ──────── 当日コンディションの安全アラート（血圧・痛みVAS） ──────── */
  function condAlerts(c) {
    const out = []; if (!c) return out;
    const sys = parseFloat(c.sys), dia = parseFloat(c.dia), vas = parseFloat(c.vas);
    if ((!isNaN(sys) && sys >= 180) || (!isNaN(dia) && dia >= 110)) out.push({ level: 'stop', msg: '血圧が非常に高い値です。本日の運動は見合わせを推奨します。' });
    else if ((!isNaN(sys) && sys >= 140) || (!isNaN(dia) && dia >= 90)) out.push({ level: 'warn', msg: '血圧が高めです。高強度・息を止める動作（いきみ）を避けてください。' });
    if (!isNaN(vas) && vas >= 7) out.push({ level: 'warn', msg: '強い痛み・不調があります（VAS ' + vas + '）。該当部位の高強度は避けてください。' });
    return out;
  }

  /* ──────── 体組成の自動分析（非断定） ──────── */
  /* 選択中の期間の最初→最新で変化を要約し、原因を決めつけない文章を返す。
     ★純粋関数化：期間(range)は引数で受け取る（m.html 側が S.bodyRange を注入）。
     返り値: {ok, period, lines:[..本文..], caution, verdict:{level,label,goalLabel}, deltas, mv} または {ok:false}。 */
  function bodyAutoAnalysis(c, range) {
    range = range || '6m';
    const fa = rangeFilter(asc(c), range);
    if (fa.length < 2) return { ok: false };
    const first = fa[0], last = fa[fa.length - 1];
    const period = rangeLabel(range);
    const dOf = (k, dp) => {
      const a = k === 'fatMass' ? fatMassOf(first) : (k === 'bmi' ? bmiOf(first) : first[k]);
      const b = k === 'fatMass' ? fatMassOf(last) : (k === 'bmi' ? bmiOf(last) : last[k]);
      return (a == null || b == null) ? null : +(b - a).toFixed(dp == null ? 1 : dp);
    };
    const wD = dOf('weight'), bfD = dOf('bodyFatPct'), mmD = dOf('muscleMass'), fmD = dOf('fatMass');
    const bfVals = fa.map(r => r.bodyFatPct).filter(x => x != null && x !== '').map(Number);
    const bfLo = bfVals.length ? Math.min(...bfVals) : null, bfHi = bfVals.length ? Math.max(...bfVals) : null;
    const lines = [], mv = [];
    // 体重
    if (wD != null) {
      if (Math.abs(wD) < 0.1) { lines.push('体重はこの' + period + 'でほぼ横ばいです。'); mv.push('体重はほぼ横ばいです。'); }
      else { const dir = wD < 0 ? '減少' : '増加'; lines.push('体重はこの' + period + 'で' + Math.abs(wD).toFixed(1) + 'kg' + dir + 'しています。'); mv.push('体重は順調に' + dir + 'しています。'); }
    }
    // 体脂肪率
    if (bfD != null) {
      if (Math.abs(bfD) < 0.3) {
        const band = (bfLo != null && bfHi != null && bfHi - bfLo >= 0.2) ? (Math.floor(bfLo) + '〜' + Math.ceil(bfHi) + '%付近') : 'ほぼ同水準';
        lines.push('一方で体脂肪率は' + band + 'で、大きな変化は見られていません。'); mv.push('体脂肪率は' + band + 'で停滞しています。');
      }
      else { const dir = bfD < 0 ? '低下' : '上昇'; lines.push('体脂肪率は' + Math.abs(bfD).toFixed(1) + 'pt' + dir + 'しています。'); mv.push('体脂肪率は' + dir + '傾向です。'); }
    }
    // 骨格筋率
    if (mmD != null && Math.abs(mmD) >= 0.3) { const dir = mmD < 0 ? '低下' : '上昇'; mv.push('骨格筋率がやや' + dir + 'しています。'); }
    // 推定体脂肪量
    const fmFirst = fatMassOf(first), fmLast = fatMassOf(last);
    if (fmFirst != null && fmLast != null) {
      if (Math.abs(fmD) < 0.2) { lines.push('推定体脂肪量は約' + fmFirst.toFixed(1) + 'kgでほぼ変化していません。'); mv.push('推定体脂肪量はほぼ変化していません。'); }
      else { const dir = fmD < 0 ? '減少' : '増加'; lines.push('推定体脂肪量は約' + fmFirst.toFixed(1) + 'kg → 約' + fmLast.toFixed(1) + 'kgとなっており、体脂肪量自体は' + dir + 'しています。'); mv.push('推定体脂肪量は' + dir + 'しています。'); }
    }
    // 注意喚起（非断定）＋総合評価レベル
    const deltas = { wD, bfD, mmD, fmD };
    let caution = '測定条件の影響もあるため、次回の測定結果と合わせて確認してください。';
    let level = 'ok', label = '順調';
    const gt = goalTypeOf(c);
    if (gt) {                                   // 目的が設定されていれば目的ベースの3段階評価
      const gv = goalVerdict(gt, deltas); level = gv.level; label = gv.label; caution = gv.caution || caution;
    } else {                                    // 目的未設定＝従来の筋肉量減少アラート（2段階）
      const wDown = wD != null && wD < -0.1, mmDown = mmD != null && mmD < -0.3, bfFlatOrUp = bfD != null && bfD >= -0.3;
      if (wDown && (mmDown || bfFlatOrUp)) {
        caution = '体重減少に対して除脂肪量（筋肉量）の減少も考えられるため、筋肉量・食事・運動習慣を合わせて確認してください。';
        level = 'warn'; label = '要確認';
      }
    }
    return { ok: true, period, lines, caution, verdict: { level, label, goalLabel: gt ? gt.lbl : null }, deltas, mv };
  }

  return {
    // 定数
    GOAL_TYPES, METRICS, RANGE_LABELS,
    // util
    asc, sorted, rangeFilter, rangeLabel,
    // 単指標
    bmiOf, fatMassOf, muscleMassKgOf, ageFromDob, custAge,
    // 判定
    deltaClass, deltaInfo, goalTypeOf, goalVerdict,
    // 集計・評価
    metricProgress, overallProgress, bodyverseScore, condAlerts, bodyAutoAnalysis,
  };
});
